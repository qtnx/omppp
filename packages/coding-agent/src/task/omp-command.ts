import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import { YAML } from "bun";
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
import { DEFAULT_MACOS_SANDBOX_ALLOWED_PATHS } from "../config/sandbox-defaults";

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

export interface MacOSSandboxRelaunchRequest {
	type: "ompx:macos-sandbox:relaunch";
	sessionId: string;
	sessionDir?: string;
	addDirs: string[];
}

export interface MacOSSandboxRelaunchResult {
	requested: boolean;
	reason?: "inactive" | "missing-session" | "missing-supervisor" | "send-failed" | "unsafe-path";
}

export interface ResolvedMacOSSandboxWorkspaceDirs {
	paths: string[];
	error?: string;
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
const MACOS_SANDBOX_RELAUNCH_MESSAGE_TYPE = "ompx:macos-sandbox:relaunch";
const MACOS_SANDBOX_RELAUNCH_SUPPORTED_ENV = "PI_OMPX_MACOS_SANDBOX_RELAUNCH_SUPPORTED";
const MACOS_SANDBOX_RELAUNCH_FORCE_KILL_MS = 10_000;
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
// Well-known SSH agent socket locations probed for zero-config discovery (macOS).
// Entries are paths under the user home (relative to ~).
const SSH_AGENT_HOME_SOCKETS = [
	"Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock", // 1Password
	"Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh", // Secretive
];
const CLI_VALUE_FLAGS = new Set([
	"--api-key",
	"--approval-mode",
	"--add-dir",
	"--sandbox-add-dir",
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
const RELAUNCH_UNSUPPORTED_FLAGS = new Set(["--print", "-p", "--export"]);
const RELAUNCH_UNSUPPORTED_MODES = new Set(["json", "rpc", "rpc-ui"]);
const RELAUNCH_UNSUPPORTED_SUBCOMMANDS = new Set([
	"__complete",
	"agents",
	"auth-broker",
	"auth-gateway",
	"commit",
	"completions",
	"config",
	"grep",
	"grievances",
	"install",
	"plugin",
	"read",
	"search",
	"setup",
	"shell",
	"ssh",
	"stats",
	"tiny-models",
	"update",
	"worktree",
	"wt",
	"q",
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

function extractCliFlagValues(args: readonly string[], targetFlag: string): string[] {
	let skipNext = false;
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (!arg) continue;
		if (arg === "--") break;
		const eqIndex = arg.indexOf("=");
		const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
		if (flag === targetFlag) {
			if (eqIndex === -1) {
				const value = args[index + 1];
				if (value !== undefined) {
					values.push(value);
					index++;
				}
			} else {
				values.push(arg.slice(eqIndex + 1));
			}
			continue;
		}
		if (eqIndex === -1 && CLI_VALUE_FLAGS.has(flag)) {
			skipNext = true;
		}
	}
	return values;
}

function hasCliFlag(args: readonly string[], targetFlags: ReadonlySet<string>): boolean {
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (arg === "--") return false;
		const eqIndex = arg.indexOf("=");
		const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
		if (targetFlags.has(flag)) return true;
		if (eqIndex === -1 && CLI_VALUE_FLAGS.has(flag)) {
			skipNext = true;
		}
	}
	return false;
}

function firstNonFlagArg(args: readonly string[]): string | undefined {
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (arg === "--") return undefined;
		const eqIndex = arg.indexOf("=");
		const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
		if (arg.startsWith("-")) {
			if (eqIndex === -1 && CLI_VALUE_FLAGS.has(flag)) {
				skipNext = true;
			}
			continue;
		}
		return arg;
	}
	return undefined;
}

function supportsMacOSSandboxRelaunch(argv: readonly string[]): boolean {
	if (hasCliFlag(argv, RELAUNCH_UNSUPPORTED_FLAGS)) return false;
	const mode = extractCliFlagValues(argv, "--mode")[0];
	if (mode && RELAUNCH_UNSUPPORTED_MODES.has(mode)) return false;
	const firstArg = firstNonFlagArg(argv);
	return !firstArg || firstArg === "launch" || firstArg === "acp" || !RELAUNCH_UNSUPPORTED_SUBCOMMANDS.has(firstArg);
}

function withActiveMacOSSandboxEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	return {
		...env,
		[MACOS_SANDBOX_ACTIVE_ENV]: "1",
		[MACOS_SANDBOX_ACTIVE_INHERITED_ENV]: "1",
	};
}

function withMacOSSandboxRelaunchSupervisorEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return {
		...env,
		[MACOS_SANDBOX_RELAUNCH_SUPPORTED_ENV]: "1",
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

function inferMacOSSandboxHome(cwd: string): string {
	const resolved = path.resolve(cwd);
	const userPath = resolved.startsWith("/System/Volumes/Data/")
		? resolved.slice("/System/Volumes/Data".length)
		: resolved;
	const parts = userPath.split(path.sep);
	if (parts[1] === "Users" && parts[2]) {
		return path.join(path.sep, "Users", parts[2]);
	}
	return os.homedir();
}

function unsafeMacOSSandboxWorkspaceDirReason(candidate: string, home: string): string | null {
	const candidates = realPaths(candidate);
	const homeCandidates = realPaths(home);
	const unsafeExact = new Set([
		"/",
		"/Users",
		"/System/Volumes/Data",
		"/System/Volumes/Data/Users",
		"/Volumes",
		"/System/Volumes/Data/Volumes",
		...homeCandidates,
	]);
	for (const resolved of candidates) {
		if (unsafeExact.has(resolved)) return "broad home/root paths are not working directories";
		for (const homeCandidate of homeCandidates) {
			for (const secretDir of [
				path.join(homeCandidate, ".ssh"),
				path.join(homeCandidate, ".config", "gh"),
				path.join(homeCandidate, "Library", "Keychains"),
			]) {
				if (pathIsWithin(secretDir, resolved)) {
					return "credential and keychain directories cannot be whitelisted as working directories";
				}
			}
		}
	}
	return null;
}

export function resolveMacOSSandboxWorkspaceDirs(
	inputPaths: readonly string[],
	cwd: string,
): ResolvedMacOSSandboxWorkspaceDirs {
	const seen = new Set<string>();
	const paths: string[] = [];
	const home = inferMacOSSandboxHome(cwd);
	for (const inputPath of inputPaths) {
		const trimmed = inputPath.trim();
		if (!trimmed) continue;
		const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
		const unsafeReason = unsafeMacOSSandboxWorkspaceDirReason(resolved, home);
		if (unsafeReason) return { paths, error: unsafeReason };
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		paths.push(resolved);
	}
	return { paths };
}

export function resolveMacOSSandboxAllowedPaths(
	inputPaths: readonly string[],
	cwd: string,
	home: string = inferMacOSSandboxHome(cwd),
): ResolvedMacOSSandboxWorkspaceDirs {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const inputPath of inputPaths) {
		const trimmed = inputPath.trim();
		if (!trimmed || trimmed.includes("\0")) continue;
		const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? path.join(home, trimmed.slice(2)) : trimmed;
		const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
		const unsafeReason = unsafeMacOSSandboxWorkspaceDirReason(resolved, home);
		if (unsafeReason) return { paths, error: unsafeReason };
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		paths.push(resolved);
	}
	return { paths };
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

function pathLooksLikeKubeConfig(inputPath: string): boolean {
	const normalized = inputPath.replaceAll("\\", "/");
	return normalized === "~/.kube/config" || normalized.endsWith("/.kube/config");
}

function addSandboxAllowedPath(sets: SandboxPathSets, inputPath: string): void {
	if (pathLooksLikeKubeConfig(inputPath)) {
		addWriteLiteral(sets, inputPath);
		return;
	}
	for (const candidate of realPaths(inputPath)) {
		try {
			if (fs.lstatSync(candidate).isDirectory() && !pathLooksLikeKubeConfig(candidate)) {
				addWriteSubpath(sets, candidate);
				continue;
			}
			addWriteLiteral(sets, candidate);
		} catch {
			if (pathLooksLikeKubeConfig(candidate)) {
				addWriteLiteral(sets, candidate);
			} else {
				addWriteSubpath(sets, candidate);
			}
		}
	}
}

function stringArraySetting(value: unknown): string[] | null {
	if (value === undefined) return null;
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return null;
}

function readConfiguredMacOSSandboxAllowedPaths(): string[] {
	try {
		const configPath = path.join(getAgentDir(), "config.yml");
		const parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return DEFAULT_MACOS_SANDBOX_ALLOWED_PATHS;
		}
		const raw = parsed as { sandbox?: { allowedPaths?: unknown }; "sandbox.allowedPaths"?: unknown };
		return (
			stringArraySetting(raw.sandbox?.allowedPaths) ??
			stringArraySetting(raw["sandbox.allowedPaths"]) ??
			DEFAULT_MACOS_SANDBOX_ALLOWED_PATHS
		);
	} catch {
		return DEFAULT_MACOS_SANDBOX_ALLOWED_PATHS;
	}
}

function addConfiguredSandboxAllowedPaths(sets: SandboxPathSets, cwd: string, home: string): void {
	const resolved = resolveMacOSSandboxAllowedPaths(readConfiguredMacOSSandboxAllowedPaths(), cwd, home);
	if (resolved.error) return;
	for (const allowedPath of resolved.paths) {
		addSandboxAllowedPath(sets, allowedPath);
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

function readConfiguredSSHAuthSock(): string | undefined {
	try {
		const configPath = path.join(getAgentDir(), "config.yml");
		const parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const raw = parsed as { sandbox?: { sshAuthSock?: unknown }; "sandbox.sshAuthSock"?: unknown };
		const value = raw.sandbox?.sshAuthSock ?? raw["sandbox.sshAuthSock"];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

function statIfOwnedSocket(candidate: string, uid: number | undefined): fs.Stats | null {
	try {
		const stat = fs.lstatSync(candidate);
		if (!stat.isSocket()) return null;
		if (uid !== undefined && stat.uid !== uid) return null;
		return stat;
	} catch {
		return null;
	}
}

// launchd agents expose `<root>/com.apple.launchd.*/Listeners` (under per-user temp
// roots, or /var/run for the system com.openssh.ssh-agent); classic ssh-agent exposes
// `<root>/ssh-*/agent.*`. Pick the newest live-looking socket owned by us.
function newestAgentSocketInTempRoots(
	roots: readonly (string | undefined)[],
	uid: number | undefined,
): string | undefined {
	let best: string | undefined;
	let bestMtime = -1;
	const seen = new Set<string>();
	for (const root of roots) {
		if (!root?.trim() || seen.has(root)) continue;
		seen.add(root);
		let entries: string[];
		try {
			entries = fs.readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			let socketPath: string | undefined;
			if (entry.startsWith("com.apple.launchd.")) {
				socketPath = path.join(root, entry, "Listeners");
			} else if (entry.startsWith("ssh-")) {
				try {
					const inner = fs.readdirSync(path.join(root, entry)).find(name => name.startsWith("agent."));
					if (inner) socketPath = path.join(root, entry, inner);
				} catch {}
			}
			const stat = socketPath ? statIfOwnedSocket(socketPath, uid) : null;
			if (socketPath && stat && stat.mtimeMs > bestMtime) {
				best = socketPath;
				bestMtime = stat.mtimeMs;
			}
		}
	}
	return best;
}

// Best-effort zero-config discovery of the user's running SSH agent on macOS. Only
// sockets owned by the current uid are trusted, so another user cannot plant one
// under a shared temp root to hijack agent auth.
function discoverSSHAuthSock(env: Record<string, string | undefined>, home: string): string | undefined {
	const getuid = process.getuid;
	const uid = getuid ? getuid() : undefined;
	for (const relative of SSH_AGENT_HOME_SOCKETS) {
		const candidate = path.join(home, relative);
		if (statIfOwnedSocket(candidate, uid)) return candidate;
	}
	return newestAgentSocketInTempRoots(
		[env.TMPDIR, os.tmpdir(), "/tmp", "/private/tmp", "/var/run", "/private/var/run"],
		uid,
	);
}

// Resolution priority mirrors the trust model: the boot-captured/env-override socket
// (PI_OMPX_TRUSTED_SSH_AUTH_SOCK, set in preload-env) wins, then user/global config,
// then best-effort zero-config discovery. Raw SSH_AUTH_SOCK is never trusted directly.
// A config value of off/false/no/0 disables both the config path and discovery.
function resolveSandboxSSHAuthSock(env: Record<string, string | undefined>, home: string): string | undefined {
	const inherited = trustedSSHAuthSock(env);
	if (inherited) return inherited;
	const configured = readConfiguredSSHAuthSock();
	if (configured) {
		if (DISABLE_SANDBOX_VALUES.has(configured.toLowerCase())) return undefined;
		if (configured === "~") return home;
		return configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured;
	}
	return discoverSSHAuthSock(env, home);
}

function addSSHAgentSocket(sets: SandboxPathSets, inputPath: string | undefined): void {
	if (!inputPath?.trim()) return;
	const candidates = realPaths(inputPath);
	if (candidates.length === 0) return;
	if (candidates.every(candidate => pathIsWithinAnyRoot(TRUSTED_TEMP_ROOTS, candidate))) {
		for (const candidate of candidates) {
			try {
				if (!fs.lstatSync(candidate).isSocket()) return;
			} catch {}
		}
		for (const candidate of candidates) {
			addWriteLiteral(sets, candidate);
		}
		return;
	}
	for (const candidate of candidates) {
		try {
			if (fs.lstatSync(candidate).isSocket()) {
				addWriteLiteral(sets, candidate);
			}
		} catch {}
	}
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

function addWorkspaceDirectoryArg(sets: SandboxPathSets, value: string | undefined, cwd: string): void {
	if (!value?.trim()) return;
	const resolved = resolveMacOSSandboxWorkspaceDirs([value], cwd);
	if (resolved.error) return;
	for (const workspaceDir of resolved.paths) {
		addWriteSubpath(sets, workspaceDir);
	}
}

function addSandboxAllowedPathArg(sets: SandboxPathSets, value: string | undefined, cwd: string): void {
	if (!value?.trim()) return;
	const resolved = resolveMacOSSandboxAllowedPaths([value], cwd);
	if (resolved.error) return;
	for (const allowedPath of resolved.paths) {
		addSandboxAllowedPath(sets, allowedPath);
	}
}

function addCommandArgumentPaths(sets: SandboxPathSets, args: string[], cwd: string): void {
	const firstArg = args[0];
	if (firstArg && !firstArg.startsWith("-") && (path.isAbsolute(firstArg) || firstArg.includes(path.sep))) {
		addResolvedReadArg(sets, firstArg, cwd);
	}

	for (const sessionDir of extractCliFlagValues(args, "--session-dir")) {
		addWriteSubpath(sets, resolveChildPath(sessionDir, cwd));
	}
	for (const workspaceDir of extractCliFlagValues(args, "--add-dir")) {
		addWorkspaceDirectoryArg(sets, workspaceDir, cwd);
	}
	for (const allowedPath of extractCliFlagValues(args, "--sandbox-add-dir")) {
		addSandboxAllowedPathArg(sets, allowedPath, cwd);
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
	addConfiguredSandboxAllowedPaths(sets, cwd, home);
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

function extractSessionDirArgs(argv: readonly string[]): string[] {
	const sessionDir = extractCliFlagValues(argv, "--session-dir")[0];
	return sessionDir ? ["--session-dir", sessionDir] : [];
}

function extractSandboxAllowDirArgs(argv: readonly string[]): string[] {
	return [...extractCliFlagValues(argv, "--sandbox-add-dir"), ...extractCliFlagValues(argv, "--add-dir")];
}

function extractRelaunchModeArgs(argv: readonly string[]): string[] {
	if (argv[0] === "acp") return ["--mode", "acp"];
	const mode = extractCliFlagValues(argv, "--mode")[0];
	return mode === "acp" ? ["--mode", "acp"] : [];
}

function macOSSandboxShellQuote(arg: string): string {
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

export function formatMacOSSandboxRestartCommand(args: readonly string[]): string {
	return [APP_NAME, ...args].map(macOSSandboxShellQuote).join(" ");
}

function uniqueAddDirs(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const inputPath of paths) {
		const trimmed = inputPath.trim();
		if (!trimmed) continue;
		const resolved = path.resolve(trimmed);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		out.push(resolved);
	}
	return out;
}

function isSafeMacOSSandboxRelaunchArg(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed === value && !trimmed.startsWith("-") && !trimmed.includes("\0");
}

function isSafeMacOSSandboxRelaunchSessionId(sessionId: string): boolean {
	return isSafeMacOSSandboxRelaunchArg(sessionId);
}

function parseMacOSSandboxRelaunchRequest(message: unknown, cwd: string): MacOSSandboxRelaunchRequest | null {
	if (!message || typeof message !== "object") return null;
	const value = message as Partial<MacOSSandboxRelaunchRequest>;
	if (
		value.type !== MACOS_SANDBOX_RELAUNCH_MESSAGE_TYPE ||
		typeof value.sessionId !== "string" ||
		!isSafeMacOSSandboxRelaunchSessionId(value.sessionId) ||
		!Array.isArray(value.addDirs) ||
		!value.addDirs.every(dir => typeof dir === "string")
	) {
		return null;
	}
	const sessionDir =
		typeof value.sessionDir === "string" && isSafeMacOSSandboxRelaunchArg(value.sessionDir)
			? path.resolve(value.sessionDir)
			: undefined;
	if (value.sessionDir !== undefined && !sessionDir) return null;
	const resolved = resolveMacOSSandboxAllowedPaths(value.addDirs, cwd);
	if (resolved.error || resolved.paths.length === 0) return null;
	return {
		type: MACOS_SANDBOX_RELAUNCH_MESSAGE_TYPE,
		sessionId: value.sessionId,
		sessionDir,
		addDirs: resolved.paths,
	};
}

function processSender(): ((message: unknown) => boolean) | undefined {
	return (process as NodeJS.Process & { send?: (message: unknown) => boolean }).send;
}

export function disconnectMacOSSandboxSupervisor(): void {
	const childProcess = process as NodeJS.Process & { connected?: boolean; disconnect?: () => void };
	if (!childProcess.disconnect || childProcess.connected === false) return;
	childProcess.disconnect();
}

export function requestMacOSSandboxRelaunch(
	addDirs: readonly string[],
	sessionId: string | null | undefined,
	sessionDir?: string | null,
): MacOSSandboxRelaunchResult {
	if (!isMacOSSandboxActive()) return { requested: false, reason: "inactive" };
	if (!sessionId || !isSafeMacOSSandboxRelaunchSessionId(sessionId)) {
		return { requested: false, reason: "missing-session" };
	}
	if (Bun.env[MACOS_SANDBOX_RELAUNCH_SUPPORTED_ENV] !== "1") {
		return { requested: false, reason: "missing-supervisor" };
	}
	const sender = processSender();
	if (!sender) return { requested: false, reason: "missing-supervisor" };
	const resolved = resolveMacOSSandboxAllowedPaths(addDirs, process.cwd());
	if (resolved.error) return { requested: false, reason: "unsafe-path" };
	if (resolved.paths.length === 0) return { requested: false, reason: "missing-session" };
	const resolvedSessionDir =
		typeof sessionDir === "string" && isSafeMacOSSandboxRelaunchArg(sessionDir)
			? path.resolve(sessionDir)
			: undefined;
	const request: MacOSSandboxRelaunchRequest = {
		type: MACOS_SANDBOX_RELAUNCH_MESSAGE_TYPE,
		sessionId,
		sessionDir: resolvedSessionDir,
		addDirs: uniqueAddDirs(resolved.paths),
	};
	const childProcess = process as NodeJS.Process & { connected?: boolean };
	if (childProcess.connected === false) return { requested: false, reason: "send-failed" };
	try {
		return sender(request) ? { requested: true } : { requested: false, reason: "send-failed" };
	} catch {
		return { requested: false, reason: "send-failed" };
	}
}

export function buildMacOSSandboxRelaunchArgv(
	previousArgv: readonly string[],
	sessionId: string,
	addDirs: readonly string[],
): string[] {
	const argv = [
		...extractSessionDirArgs(previousArgv),
		...extractRelaunchModeArgs(previousArgv),
		"--resume",
		sessionId,
	];
	for (const dir of uniqueAddDirs([...addDirs, ...extractSandboxAllowDirArgs(previousArgv)])) {
		argv.push("--sandbox-add-dir", dir);
	}
	return argv;
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
	let command = sandboxCurrentOmpxCommand(argv);
	if (!command) return false;

	let nextArgv = argv;
	const addDirs: string[] = [];
	while (command) {
		const relaunchSupported = supportsMacOSSandboxRelaunch(nextArgv);
		if (!relaunchSupported) {
			const child = Bun.spawn({
				cmd: [command.cmd, ...command.args],
				env: command.env ?? Bun.env,
				stderr: "inherit",
				stdin: "inherit",
				stdout: "inherit",
			});
			process.exit(await child.exited);
		}

		let relaunchSessionId: string | undefined;
		let relaunchSessionDir: string | undefined;
		let terminationScheduled = false;
		let forceKillTimer: NodeJS.Timeout | undefined;
		const relaunchAddDirs: string[] = [];
		const child = Bun.spawn({
			cmd: [command.cmd, ...command.args],
			env: withMacOSSandboxRelaunchSupervisorEnv(command.env ?? Bun.env),
			stderr: "inherit",
			stdin: "inherit",
			stdout: "inherit",
			serialization: "advanced",
			ipc(message) {
				const request = parseMacOSSandboxRelaunchRequest(message, process.cwd());
				if (!request) return;
				if (relaunchSessionId && relaunchSessionId !== request.sessionId) return;
				relaunchSessionId = request.sessionId;
				if (request.sessionDir) {
					relaunchSessionDir = request.sessionDir;
				}
				relaunchAddDirs.push(...request.addDirs);
				if (terminationScheduled) return;
				terminationScheduled = true;
				globalThis.setTimeout(() => {
					child.kill("SIGTERM");
					// Escalate to SIGKILL if the child's SIGTERM cleanup hangs (e.g. an
					// unbounded ssh/sshfs unmount in postmortem) so the relaunch never
					// blocks `await child.exited` forever.
					forceKillTimer = globalThis.setTimeout(() => {
						try {
							child.kill("SIGKILL");
						} catch {
							// Child already exited; nothing to escalate.
						}
					}, MACOS_SANDBOX_RELAUNCH_FORCE_KILL_MS);
					forceKillTimer.unref?.();
				}, 250);
			},
		});
		const exitCode = await child.exited;
		if (forceKillTimer) clearTimeout(forceKillTimer);
		if (!relaunchSessionId) {
			process.exit(exitCode);
		}
		addDirs.push(...relaunchAddDirs);
		const relaunchPreviousArgv = relaunchSessionDir ? ["--session-dir", relaunchSessionDir, ...nextArgv] : nextArgv;
		nextArgv = buildMacOSSandboxRelaunchArgv(relaunchPreviousArgv, relaunchSessionId, addDirs);
		command = sandboxCurrentOmpxCommand(nextArgv);
	}
	return false;
}

export function sandboxOmpxCommand(command: OmpxCommand, options: OmpxSandboxOptions = {}): OmpxCommand {
	if (command.cmd === MACOS_SANDBOX_EXEC) return command;
	const env = options.env ?? Bun.env;
	if (commandRequestsNoSandbox(command.args) || !shouldSandboxOmpxCommand(env)) return command;

	const cwd = path.resolve(options.cwd?.trim() ? options.cwd : process.cwd());
	const resolvedCmd = resolveExecutable(command.cmd, env, cwd);
	const childEnv = withActiveMacOSSandboxEnv(env);
	const sshAuthSock = resolveSandboxSSHAuthSock(childEnv, childEnv.HOME ?? os.homedir());
	if (sshAuthSock) {
		childEnv.SSH_AUTH_SOCK = sshAuthSock;
		childEnv[TRUSTED_SSH_AUTH_SOCK_ENV] = sshAuthSock;
	}
	const profile = buildMacOSSandboxProfile(collectSandboxPaths(command, resolvedCmd, cwd, childEnv));
	return {
		cmd: MACOS_SANDBOX_EXEC,
		args: ["-p", profile, resolvedCmd, ...command.args],
		shell: false,
		env: childEnv,
	};
}
