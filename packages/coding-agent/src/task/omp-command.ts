import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import "../cli/preload-env";
import {
	$env,
	$which,
	APP_NAME,
	APP_STORAGE_NAME,
	CONFIG_DIR_NAME,
	getAgentDir,
	getConfigRootDir,
} from "@oh-my-pi/pi-utils";

export interface OmpxCommand {
	cmd: string;
	args: string[];
	shell: boolean;
}

export interface OmpxSandboxOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

interface SandboxPathSets {
	readMetadataLiterals: Set<string>;
	readSubpaths: Set<string>;
	writeSubpaths: Set<string>;
}

const DEFAULT_CMD = process.platform === "win32" ? `${APP_NAME}.cmd` : APP_NAME;
const DEFAULT_SHELL = process.platform === "win32";
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MACOS_SANDBOX_INHERITED_ENV = "PI_OMPX_MACOS_SANDBOX_INHERITED";
const MACOS_SANDBOX_DEFAULT_SENTINEL = "default";
const DISABLE_SANDBOX_VALUES = new Set(["0", "false", "no", "off"]);
const READ_DENY_ROOTS = ["/Volumes", "/System/Volumes/Data/Volumes", "/Users", "/System/Volumes/Data/Users"];
const KEYCHAIN_DENY_ROOTS = ["/Library/Keychains", "/System/Volumes/Data/Library/Keychains"];
const TRAVERSAL_ROOTS = ["/Volumes", "/System/Volumes/Data/Volumes", "/Users", "/System/Volumes/Data/Users"];
const TRUSTED_CONFIG_DIR_ENV = "PI_OMPX_TRUSTED_CONFIG_DIR";
const TRUSTED_AGENT_DIR_ENV = "PI_OMPX_TRUSTED_CODING_AGENT_DIR";
const TRUSTED_TEMP_ROOTS = [
	"/tmp",
	"/private/tmp",
	"/var/tmp",
	"/private/var/tmp",
	"/var/folders",
	"/private/var/folders",
];

export function resolveOmpCommand(): OmpxCommand {
	const envCmd = $env.PI_SUBPROCESS_CMD;
	if (envCmd?.trim()) {
		return { cmd: envCmd, args: [], shell: DEFAULT_SHELL };
	}

	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return { cmd: process.execPath, args: [entry], shell: false };
	}

	return { cmd: DEFAULT_CMD, args: [], shell: DEFAULT_SHELL };
}

function isDisabledEnvValue(value: string | undefined): boolean {
	return value !== undefined && DISABLE_SANDBOX_VALUES.has(value.trim().toLowerCase());
}

function resolveSandboxEnvValue(env: Record<string, string | undefined>): string | undefined {
	const inherited = env[MACOS_SANDBOX_INHERITED_ENV];
	if (inherited === undefined) return undefined;
	const trimmed = inherited.trim();
	return trimmed === "" || trimmed === MACOS_SANDBOX_DEFAULT_SENTINEL ? undefined : inherited;
}

function shouldSandboxOmpxCommand(env: Record<string, string | undefined>): boolean {
	return process.platform === "darwin" && !isDisabledEnvValue(resolveSandboxEnvValue(env));
}

function findExecutableOnPath(cmd: string, env: Record<string, string | undefined>, cwd: string): string | null {
	const pathValue = env.PATH;
	if (!pathValue) return null;
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		const base = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
		const candidate = path.join(base, cmd);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	return null;
}

function resolveExecutable(cmd: string, env: Record<string, string | undefined>, cwd: string): string {
	if (path.isAbsolute(cmd)) return path.resolve(cmd);
	if (cmd.includes(path.sep)) return path.resolve(cwd, cmd);
	const resolved = findExecutableOnPath(cmd, env, cwd) ?? $which(cmd, env.PATH ? { PATH: env.PATH } : undefined);
	return resolved ?? cmd;
}

function addUniquePath(paths: string[], candidate: string): void {
	if (!paths.includes(candidate)) paths.push(candidate);
}

function addMacOSDataAlias(paths: string[], resolved: string): void {
	if (resolved === "/Volumes" || resolved.startsWith("/Volumes/")) {
		addUniquePath(paths, `/System/Volumes/Data${resolved}`);
		return;
	}
	if (resolved === "/Users" || resolved.startsWith("/Users/")) {
		addUniquePath(paths, `/System/Volumes/Data${resolved}`);
		return;
	}
	for (const dataRoot of ["/System/Volumes/Data/Volumes", "/System/Volumes/Data/Users"]) {
		if (resolved === dataRoot || resolved.startsWith(`${dataRoot}/`)) {
			addUniquePath(paths, resolved.slice("/System/Volumes/Data".length));
			return;
		}
	}
}

function realPaths(inputPath: string): string[] {
	if (inputPath.includes("\0")) return [];
	const resolved = path.resolve(inputPath);
	const paths = [resolved];
	addMacOSDataAlias(paths, resolved);
	try {
		const real = fs.realpathSync.native(resolved);
		addUniquePath(paths, real);
		addMacOSDataAlias(paths, real);
	} catch {}
	return paths;
}

function pathIsWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function addTraversalLiterals(paths: Set<string>, allowedPath: string): void {
	for (const root of TRAVERSAL_ROOTS) {
		if (!pathIsWithin(root, allowedPath) || allowedPath === root) continue;
		paths.add(root);
		const relative = path.relative(root, allowedPath);
		if (!relative) continue;
		let current = root;
		const parts = relative.split(path.sep);
		for (let index = 0; index < parts.length - 1; index++) {
			current = path.join(current, parts[index] ?? "");
			paths.add(current);
		}
	}
}

function addReadSubpath(sets: SandboxPathSets, inputPath: string | undefined): void {
	if (!inputPath?.trim()) return;
	for (const candidate of realPaths(inputPath)) {
		sets.readSubpaths.add(candidate);
		addTraversalLiterals(sets.readMetadataLiterals, candidate);
	}
}

function addWriteSubpath(sets: SandboxPathSets, inputPath: string | undefined): void {
	if (!inputPath?.trim()) return;
	for (const candidate of realPaths(inputPath)) {
		sets.readSubpaths.add(candidate);
		sets.writeSubpaths.add(candidate);
		addTraversalLiterals(sets.readMetadataLiterals, candidate);
	}
}

function isUnsafeRuntimePath(candidate: string, home: string): boolean {
	const resolvedHome = path.resolve(home);
	const unsafePaths = new Set(["/", "/Users", "/System/Volumes/Data/Users", resolvedHome]);
	if (resolvedHome === "/Users" || resolvedHome.startsWith("/Users/")) {
		unsafePaths.add(`/System/Volumes/Data${resolvedHome}`);
	}
	return unsafePaths.has(candidate);
}

function addRuntimeWriteSubpath(sets: SandboxPathSets, inputPath: string | undefined, home: string): void {
	if (!inputPath?.trim()) return;
	const candidates = realPaths(inputPath);
	if (candidates.length === 0) return;
	if (candidates.some(candidate => isUnsafeRuntimePath(candidate, home))) return;
	for (const candidate of candidates) {
		sets.readSubpaths.add(candidate);
		sets.writeSubpaths.add(candidate);
		addTraversalLiterals(sets.readMetadataLiterals, candidate);
	}
}

function addXdgOmpDir(sets: SandboxPathSets, env: Record<string, string | undefined>, key: string): void {
	const base = env[key];
	if (!base?.trim()) return;
	addWriteSubpath(sets, path.join(base, APP_STORAGE_NAME));
}

function addRuntimeDirs(sets: SandboxPathSets, env: Record<string, string | undefined>): string {
	const home = env.HOME ?? os.homedir();
	const trustedConfigDir = env[TRUSTED_CONFIG_DIR_ENV]?.trim();
	const configDirName =
		trustedConfigDir && trustedConfigDir !== MACOS_SANDBOX_DEFAULT_SENTINEL
			? trustedConfigDir
			: CONFIG_DIR_NAME;
	const configRoot = path.join(home, configDirName);
	const trustedAgentDir = env[TRUSTED_AGENT_DIR_ENV]?.trim();
	const agentDir =
		trustedAgentDir && trustedAgentDir !== MACOS_SANDBOX_DEFAULT_SENTINEL
			? trustedAgentDir
			: path.join(configRoot, "agent");

	addRuntimeWriteSubpath(sets, getConfigRootDir(), home);
	addRuntimeWriteSubpath(sets, getAgentDir(), home);
	addRuntimeWriteSubpath(sets, configRoot, home);
	addRuntimeWriteSubpath(sets, agentDir, home);
	addXdgOmpDir(sets, env, "XDG_DATA_HOME");
	addXdgOmpDir(sets, env, "XDG_STATE_HOME");
	addXdgOmpDir(sets, env, "XDG_CACHE_HOME");

	return home;
}

function pathIsWithinAnyRoot(roots: readonly string[], candidate: string): boolean {
	return roots.some(root => pathIsWithin(root, candidate));
}

function addTrustedTempSubpath(sets: SandboxPathSets, inputPath: string | undefined): void {
	if (!inputPath?.trim()) return;
	const candidates = realPaths(inputPath);
	if (candidates.length === 0) return;
	if (!candidates.every(candidate => pathIsWithinAnyRoot(TRUSTED_TEMP_ROOTS, candidate))) return;
	for (const candidate of candidates) {
		sets.readSubpaths.add(candidate);
		sets.writeSubpaths.add(candidate);
		addTraversalLiterals(sets.readMetadataLiterals, candidate);
	}
}

function resolveChildPath(inputPath: string, cwd: string): string {
	return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

function addResolvedReadArg(sets: SandboxPathSets, arg: string | undefined, cwd: string): void {
	if (!arg?.trim()) return;
	addReadSubpath(sets, resolveChildPath(arg, cwd));
}

function addCommandArgumentPaths(sets: SandboxPathSets, args: string[], cwd: string): void {
	const firstArg = args[0];
	if (firstArg && !firstArg.startsWith("-") && (path.isAbsolute(firstArg) || firstArg.includes(path.sep))) {
		addResolvedReadArg(sets, firstArg, cwd);
	}

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--session-dir") {
			if (args[index + 1]) {
				addWriteSubpath(sets, resolveChildPath(args[index + 1], cwd));
			}
			index++;
			continue;
		}
		if (arg?.startsWith("--session-dir=")) {
			addWriteSubpath(sets, resolveChildPath(arg.slice("--session-dir=".length), cwd));
		}
	}
}

function collectSandboxPaths(
	command: OmpxCommand,
	resolvedCmd: string,
	cwd: string,
	env: Record<string, string | undefined>,
): SandboxPathSets {
	const sets: SandboxPathSets = {
		readMetadataLiterals: new Set(),
		readSubpaths: new Set(),
		writeSubpaths: new Set(),
	};

	addWriteSubpath(sets, cwd);
	const home = addRuntimeDirs(sets, env);
	addReadSubpath(sets, home ? path.join(home, ".bun") : undefined);
	addReadSubpath(sets, resolvedCmd);
	addCommandArgumentPaths(sets, command.args, cwd);

	for (const tmp of TRUSTED_TEMP_ROOTS) {
		addWriteSubpath(sets, tmp);
	}
	for (const tmp of [os.tmpdir(), env.TMPDIR, env.TMP, env.TEMP]) {
		addTrustedTempSubpath(sets, tmp);
	}
	addWriteSubpath(sets, "/dev");

	return sets;
}

function seatbeltString(value: string): string {
	let escaped = "\"";
	for (let index = 0; index < value.length; index++) {
		const char = value[index] ?? "";
		const code = char.charCodeAt(0);
		if (char === "\"" || char === "\\") {
			escaped += `\\${char}`;
		} else if (char === "\n") {
			escaped += "\\n";
		} else if (char === "\r") {
			escaped += "\\r";
		} else if (char === "\t") {
			escaped += "\\t";
		} else if (code < 0x20) {
			escaped += `\\x${code.toString(16).padStart(2, "0")}`;
		} else {
			escaped += char;
		}
	}
	return `${escaped}"`;
}

function renderFilters(kind: "literal" | "subpath", paths: Iterable<string>): string[] {
	const filters: string[] = [];
	for (const candidate of paths) {
		filters.push(`    (${kind} ${seatbeltString(candidate)})`);
	}
	return filters;
}

function renderRule(action: string, filters: string[]): string | null {
	if (filters.length === 0) return null;
	return `(${action}\n${filters.join("\n")})`;
}

function buildMacOSSandboxProfile(paths: SandboxPathSets): string {
	const rules = [
		"(version 1)",
		"(allow default)",
		"",
		";; Deny writes outside explicit working/runtime paths.",
		"(deny file-write*\n    (subpath \"/\"))",
		"",
		";; Deny removable-volume and home reads unless selected paths are re-allowed below.",
		renderRule("deny file-read*", renderFilters("subpath", READ_DENY_ROOTS)),
		"",
		";; Re-allow traversal and selected subpaths after the broad read denies.",
		renderRule("allow file-read-metadata", renderFilters("literal", paths.readMetadataLiterals)),
		renderRule("allow file-read*", renderFilters("subpath", paths.readSubpaths)),
		"",
		";; System.keychain is world-readable on stock macOS.",
		renderRule("deny file-read*", renderFilters("subpath", KEYCHAIN_DENY_ROOTS)),
		"",
		renderRule("allow file-write*", renderFilters("subpath", paths.writeSubpaths)),
		"",
		";; Keep raw disk and packet-capture devices blocked even though /dev is writable.",
		"(deny file-read* file-write*\n    (regex #\"^/dev/r?disk\")\n    (regex #\"^/private/dev/r?disk\")\n    (regex #\"^/dev/bpf\"))",
		"",
		"(allow process-info*)",
		"(allow sysctl-read)",
		"(allow process*)",
		"(allow process-exec\n    (literal \"/bin/ps\")\n    (with no-sandbox))",
	].filter((rule): rule is string => rule !== null);

	return `${rules.join("\n")}\n`;
}

export function sandboxOmpxCommand(command: OmpxCommand, options: OmpxSandboxOptions = {}): OmpxCommand {
	if (command.cmd === MACOS_SANDBOX_EXEC) return command;
	const env = options.env ?? Bun.env;
	if (!shouldSandboxOmpxCommand(env)) return command;

	const cwd = path.resolve(options.cwd?.trim() ? options.cwd : process.cwd());
	const resolvedCmd = resolveExecutable(command.cmd, env, cwd);
	const profile = buildMacOSSandboxProfile(collectSandboxPaths(command, resolvedCmd, cwd, env));
	return {
		cmd: MACOS_SANDBOX_EXEC,
		args: ["-p", profile, resolvedCmd, ...command.args],
		shell: false,
	};
}
