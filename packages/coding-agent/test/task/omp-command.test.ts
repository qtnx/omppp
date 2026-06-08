import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildMacOSSandboxRelaunchArgv,
	MACOS_SANDBOX_ACTIVE_ENV,
	sandboxCurrentOmpxCommand,
	sandboxOmpxCommand,
} from "@oh-my-pi/pi-coding-agent/task/omp-command";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

function macEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		BUN_INSTALL: "/Users/alice/.bun",
		HOME: "/Users/alice",
		PATH: "/Users/alice/.bun/bin:/usr/bin:/bin",
		TMPDIR: "/var/folders/alice/T/",
		...overrides,
	};
}

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createWorkspaceTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(process.cwd(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function listenUnixSocket(socketPath: string): Promise<net.Server> {
	const server = net.createServer();
	const { promise, reject, resolve } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(socketPath, resolve);
	await promise;
	server.off("error", reject);
	return server;
}

async function closeServer(server: net.Server): Promise<void> {
	const { promise, reject, resolve } = Promise.withResolvers<void>();
	server.close(error => {
		if (error) {
			reject(error);
		} else {
			resolve();
		}
	});
	await promise;
}

function profileHasWritableFilter(profile: string, filter: string): boolean {
	return profile
		.split("(allow file-write*")
		.slice(1)
		.some(rule => rule.includes(filter));
}

describe("sandboxOmpxCommand", () => {
	afterEach(() => {
		restorePlatform();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { force: true, recursive: true });
		}
	});

	it("wraps macOS ompx spawns in a Seatbelt profile by default", () => {
		setPlatform("darwin");
		const command = {
			cmd: "/Users/alice/.bun/bin/bun",
			args: ["/Users/alice/work repo/dist/cli.js", "--mode", "rpc"],
			shell: false,
		};

		const wrapped = sandboxOmpxCommand(command, {
			cwd: "/Users/alice/work repo",
			env: macEnv(),
		});

		expect(command).toEqual({
			cmd: "/Users/alice/.bun/bin/bun",
			args: ["/Users/alice/work repo/dist/cli.js", "--mode", "rpc"],
			shell: false,
		});
		expect(wrapped.cmd).toBe("/usr/bin/sandbox-exec");
		expect(wrapped.shell).toBe(false);
		const profile = wrapped.args[1] ?? "";
		expect(wrapped.args.slice(0, 3)).toEqual(["-p", profile, "/Users/alice/.bun/bin/bun"]);
		expect(wrapped.args.slice(3)).toEqual(command.args);
		expect(wrapped.env?.[MACOS_SANDBOX_ACTIVE_ENV]).toBe("1");
		expect(wrapped.env?.PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED).toBe("1");
		expect(profile.startsWith("(version 1)\n")).toBe(true);
		expect(profile).toContain("(allow default)");
		expect(profile).toContain("(deny file-write*");
		expect(profile).toContain('(subpath "/")');
		expect(profile).toContain("(deny file-read*");
		expect(profile).toContain('(subpath "/Users")');
		expect(profile).toContain('(subpath "/Volumes")');
		expect(profile).toContain('(subpath "/Users/alice/work repo")');
		expect(profile).toContain('(subpath "/Users/alice/.bun/bin/bun")');
		expect(profile).toContain('(subpath "/Users/alice/.bun")');
		expect(profile).toContain('(literal "/Users")');
		expect(profile.indexOf('(subpath "/Users")')).toBeLessThan(profile.indexOf('(subpath "/Users/alice/work repo")'));
	});

	it("uses the inherited working directory when cwd is omitted", () => {
		setPlatform("darwin");
		const cwd = process.cwd();

		const wrapped = sandboxOmpxCommand(
			{ cmd: "/usr/local/bin/ompx", args: ["--resume", "session-1"], shell: false },
			{ env: macEnv() },
		);

		expect(wrapped.cmd).toBe("/usr/bin/sandbox-exec");
		expect(wrapped.args[1]).toContain(`(subpath ${JSON.stringify(cwd)})`);
	});

	it("does not sandbox non-macOS commands", () => {
		setPlatform("linux");
		const command = { cmd: "bun", args: ["dist/cli.js"], shell: false };

		expect(sandboxOmpxCommand(command, { cwd: "/Users/alice/work", env: macEnv() })).toBe(command);
	});

	it("honors explicit inherited opt-out values without project env overriding the default", () => {
		setPlatform("darwin");
		const command = { cmd: "/usr/local/bin/ompx", args: ["--resume", "session-1"], shell: false };

		for (const value of ["0", " false ", "NO", "Off"]) {
			const projectEnvAttempt = sandboxOmpxCommand(command, {
				cwd: "/Users/alice/work",
				env: macEnv({ PI_OMPX_MACOS_SANDBOX: value }),
			});
			expect(projectEnvAttempt.cmd).toBe("/usr/bin/sandbox-exec");
			expect(
				sandboxOmpxCommand(command, {
					cwd: "/Users/alice/work",
					env: macEnv({
						PI_OMPX_MACOS_SANDBOX_INHERITED: value,
						PI_OMPX_MACOS_SANDBOX: "1",
					}),
				}),
			).toBe(command);
		}

		const wrapped = sandboxOmpxCommand(command, {
			cwd: "/Users/alice/work",
			env: macEnv({
				PI_OMPX_MACOS_SANDBOX_INHERITED: "default",
				PI_OMPX_MACOS_SANDBOX: "0",
			}),
		});
		expect(wrapped.cmd).toBe("/usr/bin/sandbox-exec");
	});

	it("does not add a new wrapper for explicit child --no-sandbox", () => {
		setPlatform("darwin");
		const command = { cmd: "/usr/local/bin/ompx", args: ["--no-sandbox", "--resume", "session-1"], shell: false };

		expect(sandboxOmpxCommand(command, { cwd: "/Users/alice/work", env: macEnv() })).toBe(command);
		const equalsCommand = { cmd: "/usr/local/bin/ompx", args: ["--no-sandbox=true"], shell: false };
		expect(sandboxOmpxCommand(equalsCommand, { cwd: "/Users/alice/work", env: macEnv() })).toBe(equalsCommand);
		const afterStandaloneDashdash = { cmd: "/usr/local/bin/ompx", args: ["--", "--no-sandbox"], shell: false };
		expect(sandboxOmpxCommand(afterStandaloneDashdash, { cwd: "/Users/alice/work", env: macEnv() }).cmd).toBe(
			"/usr/bin/sandbox-exec",
		);
		const afterConsumedDashdash = {
			cmd: "/usr/local/bin/ompx",
			args: ["--approval-mode", "--", "--no-sandbox"],
			shell: false,
		};
		expect(sandboxOmpxCommand(afterConsumedDashdash, { cwd: "/Users/alice/work", env: macEnv() })).toBe(
			afterConsumedDashdash,
		);
	});

	it("does not treat --no-sandbox values for other flags as an opt-out", () => {
		setPlatform("darwin");
		for (const args of [
			["--append-system-prompt", "--no-sandbox", "--resume", "session-1"],
			["--approval-mode", "--no-sandbox", "--resume", "session-1"],
		]) {
			const command = {
				cmd: "/usr/local/bin/ompx",
				args,
				shell: false,
			};

			const wrapped = sandboxOmpxCommand(command, { cwd: "/Users/alice/work", env: macEnv() });

			expect(wrapped.cmd).toBe("/usr/bin/sandbox-exec");
		}
	});

	it("wraps the current top-level ompx process by default on macOS", () => {
		setPlatform("darwin");

		const wrapped = sandboxCurrentOmpxCommand(["--print", "hi"], {
			cwd: "/Users/alice/work",
			entryPath: "/Users/alice/bin/ompx",
			env: macEnv({ PATH: "/Users/alice/bin" }),
			execPath: "/Users/alice/bin/ompx",
		});

		expect(wrapped?.cmd).toBe("/usr/bin/sandbox-exec");
		expect(wrapped?.args.slice(2)).toEqual(["/Users/alice/bin/ompx", "--print", "hi"]);
		expect(wrapped?.env?.PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED).toBe("1");
	});

	it("does not self-wrap helper or explicitly unsandboxed top-level invocations", () => {
		setPlatform("darwin");
		const options = {
			cwd: "/Users/alice/work",
			entryPath: "/Users/alice/bin/ompx",
			env: macEnv({ PATH: "/Users/alice/bin" }),
			execPath: "/Users/alice/bin/ompx",
		};

		expect(sandboxCurrentOmpxCommand(["--smoke-test"], options)).toBeNull();
		expect(sandboxCurrentOmpxCommand(["--no-sandbox"], options)).toBeNull();
		expect(
			sandboxCurrentOmpxCommand(["--print", "hi"], {
				...options,
				env: macEnv({ PATH: "/Users/alice/bin", PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED: "1" }),
			}),
		).toBeNull();
	});

	it("preserves session-dir, ACP mode, and existing add-dir roots when supervisor relaunches a session", () => {
		const argv = buildMacOSSandboxRelaunchArgv(
			[
				"--model",
				"claude-opus-4-1",
				"--session-dir",
				"/Users/alice/sessions",
				"--mode",
				"acp",
				"--add-dir",
				"/Users/alice/project1",
				"old prompt",
			],
			"session-1",
			["/Users/alice/project2", "/Users/alice/project1", "/Users/alice/project3"],
		);

		expect(argv).toEqual([
			"--session-dir",
			"/Users/alice/sessions",
			"--mode",
			"acp",
			"--resume",
			"session-1",
			"--add-dir",
			"/Users/alice/project1",
			"--add-dir",
			"/Users/alice/project2",
			"--add-dir",
			"/Users/alice/project3",
		]);
	});

	it("allows --add-dir paths in the sandbox profile at launch", () => {
		setPlatform("darwin");

		const wrapped = sandboxOmpxCommand(
			{
				cmd: "/usr/local/bin/ompx",
				args: ["--resume", "session-1", "--add-dir", "/Users/alice/other-work"],
				shell: false,
			},
			{ cwd: "/Users/alice/project", env: macEnv() },
		);
		const profile = wrapped.args[1] ?? "";

		expect(profile).toContain('(subpath "/Users/alice/other-work")');
		expect(profile).toContain('(subpath "/System/Volumes/Data/Users/alice/other-work")');
	});

	it("does not allow unsafe or value-operand add-dir paths in the sandbox profile", () => {
		setPlatform("darwin");

		const unsafeAddDir = sandboxOmpxCommand(
			{
				cmd: "/usr/local/bin/ompx",
				args: ["--resume", "session-1", "--add-dir", "/System/Volumes/Data/Users/alice/.ssh"],
				shell: false,
			},
			{ cwd: "/Users/alice/project", env: macEnv() },
		);
		const unsafeProfile = unsafeAddDir.args[1] ?? "";

		expect(unsafeProfile).not.toContain('(subpath "/Users/alice/.ssh")');
		expect(unsafeProfile).not.toContain('(subpath "/System/Volumes/Data/Users/alice/.ssh")');

		const valueOperand = sandboxOmpxCommand(
			{
				cmd: "/usr/local/bin/ompx",
				args: ["--append-system-prompt", "--add-dir=/Users/alice/.ssh", "--resume", "session-1"],
				shell: false,
			},
			{ cwd: "/Users/alice/project", env: macEnv() },
		);
		const valueProfile = valueOperand.args[1] ?? "";

		expect(valueProfile).not.toContain('(subpath "/Users/alice/.ssh")');
	});

	it("allows external git metadata referenced by a git worktree", () => {
		setPlatform("darwin");
		const root = createTempDir("ompx-sandbox-git-");
		const worktree = path.join(root, "worktree");
		const commonGitDir = path.join(root, "main", ".git");
		const worktreeGitDir = path.join(commonGitDir, "worktrees", "feature");
		fs.mkdirSync(worktree, { recursive: true });
		fs.mkdirSync(worktreeGitDir, { recursive: true });
		fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
		fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

		const wrapped = sandboxOmpxCommand(
			{ cmd: "/usr/local/bin/ompx", args: ["--print", "hi"], shell: false },
			{ cwd: worktree, env: macEnv() },
		);
		const profile = wrapped.args[1] ?? "";

		expect(profile).toContain(`(subpath ${JSON.stringify(worktreeGitDir)})`);
		expect(profile).toContain(`(subpath ${JSON.stringify(commonGitDir)})`);
		expect(profile).not.toContain('(subpath "/Users/alice")');
	});

	it("resolves relative executables from the child cwd", () => {
		setPlatform("darwin");

		const wrapped = sandboxOmpxCommand(
			{ cmd: "./bin/ompx", args: ["--resume", "session-1"], shell: false },
			{ cwd: "/Users/alice/project", env: macEnv() },
		);

		expect(wrapped.args[2]).toBe("/Users/alice/project/bin/ompx");
		expect(wrapped.args[1]).toContain('(subpath "/Users/alice/project/bin/ompx")');
	});

	it("allows known writable runtime paths without allowing arbitrary absolute args", () => {
		setPlatform("darwin");

		const wrapped = sandboxOmpxCommand(
			{
				cmd: "/usr/local/bin/ompx",
				args: ["dist/cli.js", "--session-dir", "ompx sessions", "--model", "/Users/alice/secrets"],
				shell: false,
			},
			{
				cwd: "/Users/alice/project",
				env: macEnv({
					PI_CODING_AGENT_DIR: "/Users/alice/.ssh",
					PI_OMPX_TRUSTED_CODING_AGENT_DIR: "/Users/alice/isolated-agent",
					TMP: "/Users/alice/untrusted-tmp",
				}),
			},
		);
		const profile = wrapped.args[1] ?? "";

		expect(profile).toContain('(subpath "/Users/alice/project/ompx sessions")');
		expect(profile).toContain('(subpath "/Users/alice/isolated-agent")');
		expect(profile).toContain('(subpath "/System/Volumes/Data/Users/alice/project/ompx sessions")');
		expect(profile).not.toContain('(subpath "/Users/alice/.ssh")');
		expect(profile).not.toContain('(subpath "/Users/alice")');
		expect(profile).not.toContain('(subpath "/System/Volumes/Data/Users/alice")');
		expect(profile).not.toContain('(subpath "/Users/alice/secrets")');
		expect(profile).not.toContain('(subpath "/Users/alice/untrusted-tmp")');
		expect(profile).toContain('(subpath "/System/Volumes/Data/Users")');
		expect(profile).toContain('(subpath "/System/Volumes/Data/Volumes")');
		expect(profile).toContain('(subpath "/System/Volumes/Data/Library/Keychains")');
		expect(profile).not.toContain("(with no-sandbox)");
	});

	it("escapes Seatbelt string literals and preserves temp/device deny ordering", () => {
		setPlatform("darwin");

		const trickyCwd = '/Users/alice/work "repo" \\ slash\nline';

		const wrapped = sandboxOmpxCommand(
			{ cmd: "/usr/local/bin/ompx", args: ["--resume", "session-1"], shell: false },
			{ cwd: trickyCwd, env: macEnv({ TMPDIR: "/private/tmp/ompx tmp" }) },
		);
		const profile = wrapped.args[1] ?? "";

		expect(profile).toContain(`(subpath ${JSON.stringify(trickyCwd)})`);
		expect(profile).toContain('(subpath "/tmp")');
		expect(profile).toContain('(subpath "/private/tmp")');
		expect(profile).toContain('(subpath "/private/tmp/ompx tmp")');
		expect(profile).toContain('(regex #"^/dev/r?disk")');
		expect(profile.lastIndexOf('(regex #"^/dev/r?disk")')).toBeGreaterThan(profile.indexOf('(subpath "/dev")'));
	});

	it("allows SSH agent sockets and public SSH client metadata without exposing private keys", () => {
		setPlatform("darwin");

		const wrapped = sandboxOmpxCommand(
			{ cmd: "/usr/local/bin/ompx", args: ["--print", "git fetch"], shell: false },
			{
				cwd: "/Users/alice/project",
				env: macEnv({
					PI_OMPX_TRUSTED_SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.test/Listeners",
					SSH_AUTH_SOCK: "/Users/alice/.ssh/ignored-agent.sock",
				}),
			},
		);
		const profile = wrapped.args[1] ?? "";

		expect(profile).toContain('(literal "/private/tmp/com.apple.launchd.test/Listeners")');
		expect(profileHasWritableFilter(profile, '(literal "/private/tmp/com.apple.launchd.test/Listeners")')).toBe(true);
		expect(profile).not.toContain("/Users/alice/.ssh/ignored-agent.sock");
		expect(profile).toContain('(literal "/Users/alice/.ssh/config")');
		expect(profile).toContain('(literal "/Users/alice/.ssh/known_hosts")');
		expect(profile).toContain('(literal "/Users/alice/.ssh/known_hosts2")');
		expect(profile).toContain('(literal "/Users/alice/.ssh/allowed_signers")');
		expect(profile).toContain('(literal "/Users/alice/.ssh/revoked_keys")');
		expect(profile).toContain('(literal "/Users/alice/.ssh/id_ed25519.pub")');
		expect(profile).toContain('(literal "/Users/alice/.ssh/id_ed25519-cert.pub")');
		expect(profile).not.toContain('(subpath "/Users/alice/.ssh/id_ed25519")');
		expect(profile).not.toContain('(subpath "/Users/alice/.ssh/id_rsa")');
		expect(profile).not.toContain('(subpath "/Users/alice/.ssh")');
	});

	it("does not follow symlinked SSH metadata to private keys", () => {
		setPlatform("darwin");
		const home = createWorkspaceTempDir("ompx-ssh-home-");
		const sshDir = path.join(home, ".ssh");
		fs.mkdirSync(sshDir, { recursive: true });
		fs.writeFileSync(path.join(sshDir, "id_ed25519"), "private-key");
		fs.symlinkSync(path.join(sshDir, "id_ed25519"), path.join(sshDir, "config"));

		const wrapped = sandboxOmpxCommand(
			{ cmd: "/usr/local/bin/ompx", args: ["--print", "ssh host"], shell: false },
			{ cwd: "/Users/alice/project", env: macEnv({ HOME: home }) },
		);
		const profile = wrapped.args[1] ?? "";

		expect(profile).not.toContain(`(literal ${JSON.stringify(path.join(sshDir, "id_ed25519"))})`);
		expect(profile).not.toContain(`(subpath ${JSON.stringify(path.join(sshDir, "id_ed25519"))})`);
		expect(profile).not.toContain(`(literal ${JSON.stringify(path.join(sshDir, "config"))})`);
	});

	it("allows an inherited trusted SSH agent socket outside temp roots when it is a Unix socket", async () => {
		setPlatform("darwin");
		const dir = createWorkspaceTempDir("ompx-ssh-agent-");
		const socketPath = path.join(dir, "agent.sock");
		const server = await listenUnixSocket(socketPath);
		try {
			const wrapped = sandboxOmpxCommand(
				{ cmd: "/usr/local/bin/ompx", args: ["--print", "ssh host"], shell: false },
				{
					cwd: "/Users/alice/project",
					env: macEnv({
						PI_OMPX_TRUSTED_SSH_AUTH_SOCK: socketPath,
					}),
				},
			);
			const profile = wrapped.args[1] ?? "";

			expect(profile).toContain(`(literal ${JSON.stringify(socketPath)})`);
			expect(profileHasWritableFilter(profile, `(literal ${JSON.stringify(socketPath)})`)).toBe(true);
		} finally {
			await closeServer(server);
		}
	});

	it("does not allow trusted SSH_AUTH_SOCK under trusted temp roots when it points to a regular file", () => {
		setPlatform("darwin");
		const dir = createTempDir("ompx-ssh-agent-file-");
		const socketPath = path.join(dir, "agent.sock");
		fs.writeFileSync(socketPath, "not a socket");

		const wrapped = sandboxOmpxCommand(
			{ cmd: "/usr/local/bin/ompx", args: ["--print", "ssh host"], shell: false },
			{
				cwd: "/Users/alice/project",
				env: macEnv({
					PI_OMPX_TRUSTED_SSH_AUTH_SOCK: socketPath,
				}),
			},
		);
		const profile = wrapped.args[1] ?? "";

		expect(profile).not.toContain(socketPath);
	});

	it("does not allow unsafe SSH_AUTH_SOCK paths under the user home", () => {
		setPlatform("darwin");

		const wrapped = sandboxOmpxCommand(
			{ cmd: "/usr/local/bin/ompx", args: ["--print", "ssh host"], shell: false },
			{
				cwd: "/Users/alice/project",
				env: macEnv({
					SSH_AUTH_SOCK: "/Users/alice/.ssh/agent.sock",
				}),
			},
		);
		const profile = wrapped.args[1] ?? "";

		expect(profile).not.toContain("/Users/alice/.ssh/agent.sock");
	});
});
