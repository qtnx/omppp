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
	env?: Record<string, string | undefined>;
}

export interface OmpxSandboxOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export interface OmpxSelfSandboxOptions extends OmpxSandboxOptions {
	entryPath?: string;
	execPath?: string;
}

interface SandboxPathSets {
	readMetadataLiterals: Set<string>;
	readLiterals: Set<string>;
	readSubpaths: Set<string>;
	writeSubpaths: Set<string>;
	writeLiterals: Set<string>;
}

const DEFAULT_CMD = process.platform === "win32" ? `${APP_NAME}.cmd` : APP_NAME;
const DEFAULT_SHELL = process.platform === "win32";
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const MACOS_SANDBOX_ACTIVE_ENV = "PI_OMPX_MACOS_SANDBOX_ACTIVE";
const MACOS_SANDBOX_ACTIVE_INHERITED_ENV = "PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED";
const MACOS_SANDBOX_INHERITED_ENV = "PI_OMPX_MACOS_SANDBOX_INHERITED";
const MACOS_SANDBOX_DEFAULT_SENTINEL = "default";
const DISABLE_SANDBOX_VALUES = new Set(["0", "false", "no", "off"]);
const READ_DENY_ROOTS = ["/Volumes", "/System/Volumes/Data/Volumes", "/Users", "/System/Volumes/Data/Users"];
const KEYCHAIN_DENY_ROOTS = ["/Library/Keychains", "/System/Volumes/Data/Library/Keychains"];
const TRAVERSAL_ROOTS = ["/Volumes", "/System/Volumes/Data/Volumes", "/Users", "/System/Volumes/Data/Users"];
const TRUSTED_CONFIG_DIR_ENV = "PI_OMPX_TRUSTED_CONFIG_DIR";
const TRUSTED_AGENT_DIR_ENV = "PI_OMPX_TRUSTED_CODING_AGENT_DIR";
const TRUSTED_SSH_AUTH_SOCK_ENV = "PI_OMPX_TRUSTED_SSH_AUTH_SOCK";
const TRUSTED_TEMP_ROOTS = [
	"/tmp",
	"/private/tmp",
	"/var/tmp",
	"/private/var/tmp",
	"/var/folders",
	"/private/var/folders",
];
const SSH_CLIENT_READ_FILES = ["config", "known_hosts", "known_hosts2", "allowed_signers", "revoked_keys"];
const SSH_PUBLIC_IDENTITY_FILES = [
	"id_dsa.pub",
	"id_dsa-cert.pub",
	"id_ecdsa.pub",
	"id_ecdsa-cert.pub",
	"id_ecdsa_sk.pub",
	"id_ecdsa_sk-cert.pub",
	"id_ed25519.pub",
	"id_ed25519-cert.pub",
	"id_ed25519_sk.pub",
	"id_ed25519_sk-cert.pub",
	"id_rsa.pub",
	"id_rsa-cert.pub",
];
const CLI_VALUE_FLAGS = new Set([
	"--api-key",
	"--approval-mode",
	"--add-dir",
	"--append-system-prompt",
	"--be",
	"--fe",
	"--export",
	"--extension",
	"--fork",
	"--hook",
	"--mode",
	"--model",
	"--models",
	"--plan",
	"--plugin-dir",
	"--provider",
	"--provider-session-id",
	"--session-dir",
	"--skills",
	"--slow",
	"--smol",
	"--system-prompt",
	"--thinking",
	"--tools",
	"-e",
]);

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

export function isMacOSSandboxActive(env: Record<string, string | undefined> = Bun.env): boolean {
	return process.platform === "darwin" && env[MACOS_SANDBOX_ACTIVE_INHERITED_ENV]?.trim() === "1";
}

export function disableMacOSSandboxForProcess(): void {
	Bun.env[MACOS_SANDBOX_INHERITED_ENV] = "0";
	Bun.env.PI_OMPX_MACOS_SANDBOX = "0";
}

function shouldSandboxOmpxCommand(env: Record<string, string | undefined>): boolean {
	return process.platform === "darwin" && !isDisabledEnvValue(resolveSandboxEnvValue(env));
}

function commandRequestsNoSandbox(args: readonly string[]): boolean {
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (arg === "--") return false;
		const eqIndex = arg.indexOf("=");
		const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
		if (flag === "--no-sandbox") return true;
		if (eqIndex === -1 && CLI_VALUE_FLAGS.has(flag)) {
			skipNext = true;
		}
	}
	return false;
}

function withActiveMacOSSandboxEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	return {
		...env,
		[MACOS_SANDBOX_ACTIVE_ENV]: "1",
		[MACOS_SANDBOX_ACTIVE_INHERITED_ENV]: "1",
	};
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

function lexicalPaths(inputPath: string): string[] {
	if (inputPath.includes("\0")) return [];
	const resolved = path.resolve(inputPath);
	const paths = [resolved];
	addMacOSDataAlias(paths, resolved);
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

function addReadLiteral(sets: SandboxPathSets, inputPath: string | undefined): void {
	if (!inputPath?.trim()) return;
	for (const candidate of lexicalPaths(inputPath)) {
		sets.readLiterals.add(candidate);
		addTraversalLiterals(sets.readMetadataLiterals, candidate);
	}
}

function addWriteLiteral(sets: SandboxPathSets, inputPath: string | undefined): void {
	if (!inputPath?.trim()) return;
	for (const candidate of lexicalPaths(inputPath)) {
		sets.readLiterals.add(candidate);
		sets.writeLiterals.add(candidate);
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
		trustedConfigDir && trustedConfigDir !== MACOS_SANDBOX_DEFAULT_SENTINEL ? trustedConfigDir : CONFIG_DIR_NAME;
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
function addTrustedTempSubpath(sets: SandboxPathSets, inputPath: string | undefined): boolean {
	if (!inputPath?.trim()) return false;
	const candidates = realPaths(inputPath);
	if (candidates.length === 0) return false;
	if (!candidates.every(candidate => pathIsWithinAnyRoot(TRUSTED_TEMP_ROOTS, candidate))) return false;
	for (const candidate of candidates) {
		sets.readSubpaths.add(candidate);
		sets.writeSubpaths.add(candidate);
		addTraversalLiterals(sets.readMetadataLiterals, candidate);
	}
	return true;
}

function existingPathIsRegularFile(inputPath: string): boolean | null {
	try {
		const stat = fs.lstatSync(inputPath);
		return stat.isFile();
	} catch {
		return null;
	}
}

function addSSHClientReadFile(sets: SandboxPathSets, inputPath: string): void {
	const regularFile = existingPathIsRegularFile(inputPath);
	if (regularFile === false) return;
	addReadLiteral(sets, inputPath);
}

function trustedSSHAuthSock(env: Record<string, string | undefined>): string | undefined {
	const trusted = env[TRUSTED_SSH_AUTH_SOCK_ENV]?.trim();
	return trusted && trusted !== MACOS_SANDBOX_DEFAULT_SENTINEL ? trusted : undefined;
}

function addSSHAgentSocket(sets: SandboxPathSets, inputPath: string | undefined): void {
	if (!inputPath?.trim()) return;
	if (addTrustedTempSubpath(sets, inputPath)) return;
	try {
		if (fs.lstatSync(path.resolve(inputPath)).isSocket()) {
			addWriteLiteral(sets, inputPath);
		}
	} catch {}
}

function addSSHSupportSubpaths(sets: SandboxPathSets, env: Record<string, string | undefined>, home: string): void {
	addSSHAgentSocket(sets, trustedSSHAuthSock(env));
	const sshDir = path.join(home, ".ssh");
	for (const file of SSH_CLIENT_READ_FILES) {
		addSSHClientReadFile(sets, path.join(sshDir, file));
	}
	for (const file of SSH_PUBLIC_IDENTITY_FILES) {
		addSSHClientReadFile(sets, path.join(sshDir, file));
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

function readGitFileTarget(gitFilePath: string): string | null {
	try {
		const firstLine = fs.readFileSync(gitFilePath, "utf8").split(/\r?\n/, 1)[0]?.trim();
		if (!firstLine?.startsWith("gitdir:")) return null;
		const rawTarget = firstLine.slice("gitdir:".length).trim();
		if (!rawTarget || rawTarget.includes("\0")) return null;
		return path.resolve(path.dirname(gitFilePath), rawTarget);
	} catch {
		return null;
	}
}

function isAssociatedExternalGitDir(candidate: string): boolean {
	const parts = path.resolve(candidate).split(path.sep);
	const gitIndex = parts.lastIndexOf(".git");
	if (gitIndex === -1) return false;
	const tail = parts.slice(gitIndex + 1);
	return tail.includes("worktrees") || tail.includes("modules");
}

function readCommonGitDir(gitDir: string): string | null {
	try {
		const firstLine = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").split(/\r?\n/, 1)[0]?.trim();
		if (!firstLine || firstLine.includes("\0")) return null;
		return path.resolve(gitDir, firstLine);
	} catch {
		return null;
	}
}

function addGitMetadataSubpaths(sets: SandboxPathSets, cwd: string): void {
	let current = cwd;
	while (true) {
		const gitPath = path.join(current, ".git");
		try {
			const stat = fs.statSync(gitPath);
			if (stat.isDirectory()) {
				addWriteSubpath(sets, gitPath);
				return;
			}
			if (stat.isFile()) {
				addReadSubpath(sets, gitPath);
				const gitDir = readGitFileTarget(gitPath);
				if (!gitDir || (!pathIsWithin(cwd, gitDir) && !isAssociatedExternalGitDir(gitDir))) return;
				addWriteSubpath(sets, gitDir);
				const commonGitDir = readCommonGitDir(gitDir);
				if (commonGitDir && pathIsWithin(commonGitDir, gitDir)) {
					addWriteSubpath(sets, commonGitDir);
				}
				return;
			}
		} catch {}
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

function collectSandboxPaths(
	command: OmpxCommand,
	resolvedCmd: string,
	cwd: string,
	env: Record<string, string | undefined>,
): SandboxPathSets {
	const sets: SandboxPathSets = {
		readLiterals: new Set(),
		readMetadataLiterals: new Set(),
		readSubpaths: new Set(),
		writeSubpaths: new Set(),
		writeLiterals: new Set(),
	};

	addWriteSubpath(sets, cwd);
	addGitMetadataSubpaths(sets, cwd);
	const home = addRuntimeDirs(sets, env);
	addReadSubpath(sets, home ? path.join(home, ".bun") : undefined);
	addSSHSupportSubpaths(sets, env, home);
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
	let escaped = '"';
	for (let index = 0; index < value.length; index++) {
		const char = value[index] ?? "";
		const code = char.charCodeAt(0);
		if (char === '"' || char === "\\") {
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
		'(deny file-write*\n    (subpath "/"))',
		"",
		";; Deny removable-volume and home reads unless selected paths are re-allowed below.",
		renderRule("deny file-read*", renderFilters("subpath", READ_DENY_ROOTS)),
		"",
		";; Re-allow traversal and selected subpaths after the broad read denies.",
		renderRule("allow file-read-metadata", renderFilters("literal", paths.readMetadataLiterals)),
		renderRule("allow file-read*", renderFilters("literal", paths.readLiterals)),
		renderRule("allow file-read*", renderFilters("subpath", paths.readSubpaths)),
		"",
		";; System.keychain is world-readable on stock macOS.",
		renderRule("deny file-read*", renderFilters("subpath", KEYCHAIN_DENY_ROOTS)),
		"",
		renderRule("allow file-write*", renderFilters("subpath", paths.writeSubpaths)),
		renderRule("allow file-write*", renderFilters("literal", paths.writeLiterals)),
		"",
		";; Keep raw disk and packet-capture devices blocked even though /dev is writable.",
		'(deny file-read* file-write*\n    (regex #"^/dev/r?disk")\n    (regex #"^/private/dev/r?disk")\n    (regex #"^/dev/bpf"))',
		"",
		"(allow process-info*)",
		"(allow sysctl-read)",
		"(allow process*)",
	].filter((rule): rule is string => rule !== null);

	return `${rules.join("\n")}\n`;
}

function shouldSelfSandboxArgv(argv: readonly string[], env: Record<string, string | undefined>): boolean {
	if (isMacOSSandboxActive(env) || commandRequestsNoSandbox(argv)) return false;
	const first = argv[0];
	return (
		first !== "--smoke-test" &&
		first !== "--tiny-worker" &&
		first !== "--help" &&
		first !== "-h" &&
		first !== "--version" &&
		first !== "-v" &&
		first !== "help"
	);
}

function currentOmpxBaseCommand(argv: string[], options: OmpxSelfSandboxOptions): OmpxCommand {
	const execPath = options.execPath ?? process.execPath;
	const entryPath = options.entryPath ?? process.argv[1];
	const args =
		entryPath && (entryPath.endsWith(".ts") || entryPath.endsWith(".js")) ? [entryPath, ...argv] : [...argv];
	return { cmd: execPath, args, shell: false };
}

export function sandboxCurrentOmpxCommand(argv: string[], options: OmpxSelfSandboxOptions = {}): OmpxCommand | null {
	const env = options.env ?? Bun.env;
	if (!shouldSelfSandboxArgv(argv, env)) return null;

	const command = currentOmpxBaseCommand(argv, options);
	const sandboxed = sandboxOmpxCommand(command, options);
	return sandboxed === command ? null : sandboxed;
}

export async function reexecUnderMacOSSandboxIfNeeded(argv: string[]): Promise<boolean> {
	const command = sandboxCurrentOmpxCommand(argv);
	if (!command) return false;
	const child = Bun.spawn([command.cmd, ...command.args], {
		env: command.env ?? Bun.env,
		stderr: "inherit",
		stdin: "inherit",
		stdout: "inherit",
	});
	const exitCode = await child.exited;
	process.exit(exitCode);
}

export function sandboxOmpxCommand(command: OmpxCommand, options: OmpxSandboxOptions = {}): OmpxCommand {
	if (command.cmd === MACOS_SANDBOX_EXEC) return command;
	const env = options.env ?? Bun.env;
	if (commandRequestsNoSandbox(command.args) || !shouldSandboxOmpxCommand(env)) return command;

	const cwd = path.resolve(options.cwd?.trim() ? options.cwd : process.cwd());
	const resolvedCmd = resolveExecutable(command.cmd, env, cwd);
	const profile = buildMacOSSandboxProfile(collectSandboxPaths(command, resolvedCmd, cwd, env));
	return {
		cmd: MACOS_SANDBOX_EXEC,
		args: ["-p", profile, resolvedCmd, ...command.args],
		shell: false,
		env: withActiveMacOSSandboxEnv(env),
	};
}
