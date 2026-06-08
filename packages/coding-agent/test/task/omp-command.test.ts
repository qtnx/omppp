import { afterEach, describe, expect, it } from "bun:test";
import { sandboxOmpxCommand } from "@oh-my-pi/pi-coding-agent/task/omp-command";

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

describe("sandboxOmpxCommand", () => {
	afterEach(() => {
		restorePlatform();
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
		expect(profile.startsWith("(version 1)\n")).toBe(true);
		expect(profile).toContain("(allow default)");
		expect(profile).toContain("(deny file-write*");
		expect(profile).toContain("(subpath \"/\")");
		expect(profile).toContain("(deny file-read*");
		expect(profile).toContain("(subpath \"/Users\")");
		expect(profile).toContain("(subpath \"/Volumes\")");
		expect(profile).toContain("(subpath \"/Users/alice/work repo\")");
		expect(profile).toContain("(subpath \"/Users/alice/.bun/bin/bun\")");
		expect(profile).toContain("(subpath \"/Users/alice/.bun\")");
		expect(profile).toContain("(literal \"/Users\")");
		expect(profile.indexOf("(subpath \"/Users\")")).toBeLessThan(
			profile.indexOf("(subpath \"/Users/alice/work repo\")"),
		);
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

	it("resolves relative executables from the child cwd", () => {
		setPlatform("darwin");

		const wrapped = sandboxOmpxCommand(
			{ cmd: "./bin/ompx", args: ["--resume", "session-1"], shell: false },
			{ cwd: "/Users/alice/project", env: macEnv() },
		);

		expect(wrapped.args[2]).toBe("/Users/alice/project/bin/ompx");
		expect(wrapped.args[1]).toContain("(subpath \"/Users/alice/project/bin/ompx\")");
	});

	it("allows known writable runtime paths without allowing arbitrary absolute args", () => {
		setPlatform("darwin");

		const wrapped = sandboxOmpxCommand(
			{
				cmd: "/usr/local/bin/ompx",
				args: [
					"dist/cli.js",
					"--session-dir",
					"ompx sessions",
					"--model",
					"/Users/alice/secrets",
				],
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

		expect(profile).toContain("(subpath \"/Users/alice/project/ompx sessions\")");
		expect(profile).toContain("(subpath \"/Users/alice/isolated-agent\")");
		expect(profile).toContain("(subpath \"/System/Volumes/Data/Users/alice/project/ompx sessions\")");
		expect(profile).not.toContain("(subpath \"/Users/alice/.ssh\")");
		expect(profile).not.toContain("(subpath \"/Users/alice\")");
		expect(profile).not.toContain("(subpath \"/System/Volumes/Data/Users/alice\")");
		expect(profile).not.toContain("(subpath \"/Users/alice/secrets\")");
		expect(profile).not.toContain("(subpath \"/Users/alice/untrusted-tmp\")");
		expect(profile).toContain("(subpath \"/System/Volumes/Data/Users\")");
		expect(profile).toContain("(subpath \"/System/Volumes/Data/Volumes\")");
		expect(profile).toContain("(subpath \"/System/Volumes/Data/Library/Keychains\")");
	});

	it("escapes Seatbelt string literals and preserves temp/device deny ordering", () => {
		setPlatform("darwin");
		const trickyCwd = "/Users/alice/work \"repo\" \\ slash\nline";

		const wrapped = sandboxOmpxCommand(
			{ cmd: "/usr/local/bin/ompx", args: ["--resume", "session-1"], shell: false },
			{ cwd: trickyCwd, env: macEnv({ TMPDIR: "/private/tmp/ompx tmp" }) },
		);
		const profile = wrapped.args[1] ?? "";

		expect(profile).toContain(`(subpath ${JSON.stringify(trickyCwd)})`);
		expect(profile).toContain("(subpath \"/tmp\")");
		expect(profile).toContain("(subpath \"/private/tmp\")");
		expect(profile).toContain("(subpath \"/private/tmp/ompx tmp\")");
		expect(profile).toContain("(regex #\"^/dev/r?disk\")");
		expect(profile.lastIndexOf("(regex #\"^/dev/r?disk\")")).toBeGreaterThan(
			profile.indexOf("(subpath \"/dev\")"),
		);
	});
});
