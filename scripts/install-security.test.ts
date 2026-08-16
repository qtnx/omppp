import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";

const repoRoot = path.join(import.meta.dir, "..");
const shellInstallerPath = path.join(repoRoot, "scripts", "install.sh");
const powershellInstallerPath = path.join(repoRoot, "scripts", "install.ps1");
const standardConfigPath = path.join(repoRoot, "packages", "coding-agent", "examples", "standard-config.yml");
const powershellCommand = findExecutable(["pwsh", "powershell"]);
const windowsPowerShellCompiler = process.platform === "win32" ? findExecutable(["powershell"]) : null;
const describePowerShell = powershellCommand && windowsPowerShellCompiler ? describe : describe.skip;
const installerProcessTestOptions = { timeout: 30_000 };
const installerTempRoot = path.join(repoRoot, ".tmp-install-security");

function findExecutable(names: readonly string[]): string | null {
	const pathExts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			for (const ext of pathExts) {
				const candidate = path.join(dir, `${name}${ext}`);
				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					return candidate;
				} catch {
					// Keep searching PATH.
				}
			}
		}
	}
	return null;
}
function normalizeConfig(text: string): string {
	return `${text.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

async function readStandardConfig(): Promise<string> {
	return normalizeConfig(await Bun.file(standardConfigPath).text());
}

async function readShellInstallerConfigSeed(): Promise<string> {
	const installer = await Bun.file(shellInstallerPath).text();
	const match = installer.match(/cat > "\$config_file" <<'EOF_CONFIG'\n([\s\S]*?)\nEOF_CONFIG/);
	if (!match) throw new Error("Could not find shell installer standard config seed");
	return normalizeConfig(match[1]);
}

async function readPowerShellInstallerConfigSeed(): Promise<string> {
	const installer = await Bun.file(powershellInstallerPath).text();
	const match = installer.match(/@'\n([\s\S]*?)\n'@ \| Set-Content -Path \$ConfigFile -Encoding UTF8/);
	if (!match) throw new Error("Could not find PowerShell installer standard config seed");
	return normalizeConfig(match[1]);
}

/**
 * The installer verifies a freshly downloaded binary by running `--version`
 * before installing it (upstream startup verification), so the fake release
 * payload has to be an executable script rather than opaque text.
 */
const RUNNABLE_RELEASE_BINARY = "#!/bin/sh\nexit 0\n";
const RUNNABLE_FALLBACK_BINARY = "#!/bin/sh\n# fallback\nexit 0\n";

function shellConfigPath(root: string): string {
	return path.join(root, "home", ".omp", "agent", "config.yml");
}

function powerShellConfigPath(root: string): string {
	return path.join(root, "profile", ".omp", "agent", "config.yml");
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
	await Bun.write(filePath, content);
	await fs.promises.chmod(filePath, 0o755);
}

async function createFakeInstallerTools(
	binaryContent: string,
	checksum: string,
): Promise<{ root: string; installDir: string }> {
	await fs.promises.mkdir(installerTempRoot, { recursive: true });
	const root = await fs.promises.mkdtemp(`${installerTempRoot}${path.sep}`);
	const binDir = path.join(root, "bin");
	const installDir = path.join(root, "install");
	await fs.promises.mkdir(binDir, { recursive: true });
	await fs.promises.mkdir(installDir, { recursive: true });

	await writeExecutable(
		path.join(binDir, "uname"),
		`#!/bin/sh
case "$1" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
  *) exit 1 ;;
esac
`,
	);
	await writeExecutable(
		path.join(binDir, "bun"),
		`#!/bin/sh
printf '1.0.0\\n'
`,
	);
	await writeExecutable(
		path.join(binDir, "curl"),
		`#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */releases/latest) content='{"tag_name":"v-test"}' ;;
  */releases/download/v-test/SHA256SUMS) content='1111111111111111111111111111111111111111111111111111111111111111  ompx-darwin-arm64
${checksum}  ompx-linux-x64
2222222222222222222222222222222222222222222222222222222222222222  ompx-linux-arm64
' ;;
  */releases/download/v-test/ompx-linux-x64) content='${binaryContent}' ;;
  *) exit 22 ;;
esac
if [ -n "$out" ]; then
  printf '%s' "$content" > "$out"
else
  printf '%s' "$content"
fi
`,
	);

	return { root, installDir };
}
async function runShellInstaller(
	root: string,
	installDir: string,
	args: string[] = ["--binary"],
	extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
	const homeDir = path.join(root, "home");
	await fs.promises.mkdir(homeDir, { recursive: true });
	const proc = Bun.spawn(["sh", shellInstallerPath, ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
			PI_INSTALL_DIR: installDir,
			HOME: homeDir,
			OMPX_INSTALL_SKIP_CODEGRAPH: "1",
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

async function writeCodeGraphInstallerTools(root: string): Promise<{ shellLogPath: string; curlLogPath: string }> {
	const binDir = path.join(root, "bin");
	const shellLogPath = path.join(root, "codegraph-shell.log");
	const curlLogPath = path.join(root, "codegraph-curl.log");
	await writeExecutable(
		path.join(binDir, "curl"),
		`#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$OMPX_CODEGRAPH_CURL_LOG"
if [ "\${OMPX_CODEGRAPH_TEST_CURL_FAIL:-}" = "1" ]; then exit 22; fi
case "$url" in
  https://example.test/codegraph-install.sh)
    content='#!/bin/sh
printf "installed\\n" >> "$OMPX_CODEGRAPH_INSTALL_LOG"
'
    ;;
  *) exit 22 ;;
esac
printf '%s' "$content" > "$out"
`,
	);
	await writeExecutable(
		path.join(binDir, "sh"),
		`#!/bin/sh
case "$1" in
  */codegraph-install.*)
    printf '%s\\n' "$1" >> "$OMPX_CODEGRAPH_SHELL_LOG"
    if [ "\${OMPX_CODEGRAPH_TEST_SH_FAIL:-}" = "1" ]; then exit 23; fi
    ;;
esac
exec /bin/sh "$@"
`,
	);
	return { shellLogPath, curlLogPath };
}

async function runPowerShellInstaller(
	root: string,
	installDir: string,
	baseUrl: string,
	args: string[] = ["-Binary"],
	extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
	if (!powershellCommand) throw new Error("PowerShell is not available");
	const userProfile = path.join(root, "profile");
	const localAppData = path.join(root, "localappdata");
	await fs.promises.mkdir(userProfile, { recursive: true });
	await fs.promises.mkdir(localAppData, { recursive: true });
	const proc = Bun.spawn(
		[powershellCommand, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", powershellInstallerPath, ...args],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
				PI_INSTALL_DIR: installDir,
				PI_GITHUB_API_BASE_URL: `${baseUrl}/api`,
				PI_RELEASE_DOWNLOAD_BASE_URL: `${baseUrl}/download`,
				USERPROFILE: userProfile,
				LOCALAPPDATA: localAppData,
				OMPX_INSTALL_SKIP_PATH_UPDATE: "1",
				OMPX_INSTALL_SKIP_BASH_CONFIG: "1",
				...extraEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

async function createPowerShellCommandStub(root: string): Promise<{ argvLogPath: string; binaryContent: Uint8Array }> {
	if (!windowsPowerShellCompiler) throw new Error("Windows PowerShell is not available");

	const stubPath = path.join(root, "ompx-command-stub.exe");
	const argvLogPath = path.join(root, "ompx-config-update-argv.log");
	const source = `
using System;
using System.IO;

public static class OmpxCommandStub
{
    public static int Main(string[] args)
    {
        string command = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]);
        if (String.Equals(command, "bun", StringComparison.OrdinalIgnoreCase))
        {
            if (args.Length == 1 && args[0] == "--version")
            {
                Console.WriteLine("1.3.14");
            }
            return 0;
        }

        string logPath = Environment.GetEnvironmentVariable("OMPX_TEST_ARGV_LOG");
        if (String.IsNullOrEmpty(logPath))
        {
            return 65;
        }

        File.AppendAllText(logPath, String.Join("\\t", args) + Environment.NewLine);
        string configuredExitCode = Environment.GetEnvironmentVariable("OMPX_TEST_EXIT_CODE");
        return String.IsNullOrEmpty(configuredExitCode) ? 0 : Int32.Parse(configuredExitCode);
    }
}
`;
	const proc = Bun.spawn(
		[
			windowsPowerShellCompiler,
			"-NoProfile",
			"-Command",
			"Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -Language CSharp -OutputAssembly $env:OMPX_TEST_STUB_PATH -OutputType ConsoleApplication",
		],
		{
			env: { ...process.env, OMPX_TEST_STUB_PATH: stubPath },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	proc.stdin.write(source);
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to compile Windows command stub: ${stdout}${stderr}`);
	}

	const binaryContent = new Uint8Array(await Bun.file(stubPath).arrayBuffer());
	await Promise.all([
		Bun.write(path.join(root, "bin", "bun.exe"), binaryContent),
		Bun.write(path.join(root, "bin", "ompx.exe"), binaryContent),
	]);
	return { argvLogPath, binaryContent };
}

async function createPowerShellInstallerFixture(): Promise<{
	root: string;
	installDir: string;
	argvLogPath: string;
	binaryContent: Uint8Array;
}> {
	const { root, installDir } = await createFakeInstallerTools("", "");
	try {
		return { root, installDir, ...(await createPowerShellCommandStub(root)) };
	} catch (error) {
		await fs.promises.rm(root, { recursive: true, force: true });
		throw error;
	}
}

async function expectSingleConfigUpdate(argvLogPath: string): Promise<void> {
	const invocations = (await Bun.file(argvLogPath).text())
		.replace(/\r\n/g, "\n")
		.trimEnd()
		.split("\n")
		.map(line => line.split("\t"));
	expect(invocations).toEqual([["config", "update", "--json"]]);
}
function startReleaseServer(
	binaryName: string,
	binaryContent: string | Uint8Array,
	checksum: string,
): { url: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/releases/latest") {
				return Response.json({ tag_name: "v-test" });
			}
			if (url.pathname === "/download/v-test/SHA256SUMS") {
				return new Response(
					[
						"1111111111111111111111111111111111111111111111111111111111111111  unrelated",
						`${checksum}  ${binaryName}`,
						"2222222222222222222222222222222222222222222222222222222222222222  another",
						"",
					].join("\n"),
				);
			}
			if (url.pathname === `/download/v-test/${binaryName}`) {
				return new Response(binaryContent);
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		url: `http://${server.hostname}:${server.port}`,
		stop: () => server.stop(true),
	};
}

describe("installer supply-chain hardening", () => {
	it("does not bootstrap Bun by fetching remote installer scripts", async () => {
		const [shellInstaller, powershellInstaller] = await Promise.all([
			Bun.file(shellInstallerPath).text(),
			Bun.file(powershellInstallerPath).text(),
		]);

		expect(shellInstaller).not.toContain("bun.sh/install");
		expect(powershellInstaller).not.toContain("bun.sh/install.ps1");
	});

	it("keeps installer standard config seeds in sync with the canonical template", async () => {
		const standardConfig = await readStandardConfig();

		expect(await readShellInstallerConfigSeed()).toBe(standardConfig);
		expect(await readPowerShellInstallerConfigSeed()).toBe(standardConfig);
	});

	it("installs a release binary only after matching SHA256SUMS", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		try {
			const result = await runShellInstaller(root, installDir);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Verifying ompx-linux-x64 checksum");
			expect(await Bun.file(path.join(installDir, "ompx")).text()).toBe(binaryContent);
			expect(normalizeConfig(await Bun.file(shellConfigPath(root)).text())).toBe(await readStandardConfig());
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("updates Superpowers skills through the installed shell binary", async () => {
		const binaryContent = `#!/bin/sh
printf "%s\\n" "$*" >> "$OMPX_SUPERPOWERS_LOG"
`;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const superpowersLog = path.join(root, "superpowers.log");
		try {
			const result = await runShellInstaller(root, installDir, ["--binary"], {
				OMPX_SUPERPOWERS_LOG: superpowersLog,
			});

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Updating Superpowers skills");
			// The installed binary is probed with `--version` (startup verification)
			// before the installer drives any real command.
			expect(await Bun.file(superpowersLog).text()).toBe(
				"--version\nconfig update --json\ninstall git:github.com/obra/superpowers\n",
			);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps existing shell installer config values while adding config migrations", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(configPath, "theme:\n  dark: custom\ndisplay:\n  smoothStreaming: true\n");
			const result = await runShellInstaller(root, installDir);

			expect(result.exitCode).toBe(0);
			const config = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
			expect(config).toMatchObject({
				theme: { dark: "custom" },
				display: { smoothStreaming: true, syntaxHighlighting: "basic" },
				task: {
					agentModelOverrides: {
						designer: "tnx/designer",
						frontend_ui: "tnx/designer",
						ui_ux_reviewer: "tnx/designer",
						ux_copywriter: "tnx/designer",
						scout: "tnx/scout",
					},
				},
			});
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("adds shell installer syntax highlighting migration to an existing display block", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(configPath, "display:\n  smoothStreaming: true\ntheme:\n  dark: custom\n");
			const result = await runShellInstaller(root, installDir);

			expect(result.exitCode).toBe(0);
			const config = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
			expect(config).toMatchObject({
				display: { smoothStreaming: true, syntaxHighlighting: "basic" },
				theme: { dark: "custom" },
				task: {
					agentModelOverrides: {
						designer: "tnx/designer",
						frontend_ui: "tnx/designer",
						ui_ux_reviewer: "tnx/designer",
						ux_copywriter: "tnx/designer",
						scout: "tnx/scout",
					},
				},
			});
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
	it("migrates shell installer UI agent overrides while preserving custom overrides and syntax highlighting", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(
				configPath,
				"setupVersion: 1\ndisplay:\n  smoothStreaming: true\ntask:\n  agentModelOverrides:\n    designer: pi/designer\n    frontend_ui: pi/designer\n    ui_ux_reviewer: pi/designer\n    qa: custom/qa\n",
			);
			const result = await runShellInstaller(root, installDir);

			expect(result.exitCode).toBe(0);
			const config = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
			const display = config.display as Record<string, unknown>;
			expect(display.smoothStreaming).toBe(true);
			expect(display.syntaxHighlighting).toBe("basic");
			expect((config.task as Record<string, Record<string, unknown>>).agentModelOverrides).toMatchObject({
				designer: "tnx/designer",
				frontend_ui: "tnx/designer",
				ui_ux_reviewer: "tnx/designer",
				ux_copywriter: "tnx/designer",
				scout: "tnx/scout",
				qa: "custom/qa",
			});
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
	it("migrates shell installer UI agent overrides with inline comments", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(
				configPath,
				"task:\n  agentModelOverrides:\n    designer: pi/designer # old designer route\n    frontend_ui: pi/designer # old frontend route\n    ui_ux_reviewer: pi/designer # old review route\n    ux_copywriter: pi/designer # old copy route\n    qa: custom/qa\n",
			);
			const result = await runShellInstaller(root, installDir);

			expect(result.exitCode).toBe(0);
			const config = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
			expect((config.task as Record<string, Record<string, unknown>>).agentModelOverrides).toMatchObject({
				designer: "tnx/designer",
				frontend_ui: "tnx/designer",
				ui_ux_reviewer: "tnx/designer",
				ux_copywriter: "tnx/designer",
				scout: "tnx/scout",
				qa: "custom/qa",
			});
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves inline shell installer agent override maps while adding UI routes", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(configPath, "task:\n  agentModelOverrides: { qa: custom/qa }\n");
			const result = await runShellInstaller(root, installDir);

			expect(result.exitCode).toBe(0);
			const config = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
			expect((config.task as Record<string, Record<string, unknown>>).agentModelOverrides).toMatchObject({
				designer: "tnx/designer",
				frontend_ui: "tnx/designer",
				ui_ux_reviewer: "tnx/designer",
				ux_copywriter: "tnx/designer",
				scout: "tnx/scout",
				qa: "custom/qa",
			});
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("migrates legacy GPT-5.5 routes idempotently while preserving custom routes", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(
				configPath,
				`modelRoles:
  default: openai-codex/gpt-5.5:xhigh
  plan: openai-codex/gpt-5.5:xhigh
  task: openai-codex/gpt-5.5:medium
  slow: openai-codex/gpt-5.5:high
  commit: openai-codex/gpt-5.5:low
  smol: anthropic/claude-sonnet-4-6
  custom: local/custom-model
task:
  agentModelOverrides:
    oracle: openai-codex/gpt-5.5:xhigh
    reviewer: openai-codex/gpt-5.5:xhigh
    plan: openai-codex/gpt-5.5:xhigh
    quick_task: openai-codex/gpt-5.5:low
    task: openai-codex/gpt-5.5:medium
    designer: tnx/designer
    custom_agent: custom/provider
`,
			);

			const firstResult = await runShellInstaller(root, installDir);
			expect(firstResult.exitCode).toBe(0);
			const firstConfigText = await Bun.file(configPath).text();
			const firstConfig = YAML.parse(firstConfigText) as {
				modelRoles: Record<string, string>;
				task: { agentModelOverrides: Record<string, string> };
			};

			expect(firstConfig.modelRoles).toMatchObject({
				default: "openai-codex/gpt-5.6-sol:xhigh",
				plan: "openai-codex/gpt-5.6-sol:xhigh",
				task: "openai-codex/gpt-5.6-terra:medium",
				slow: "openai-codex/gpt-5.6-sol:high",
				commit: "openai-codex/gpt-5.6-luna:high",
				smol: "anthropic/claude-sonnet-4-6",
				custom: "local/custom-model",
			});
			expect(firstConfig.task.agentModelOverrides).toMatchObject({
				heavy_task: "openai-codex/gpt-5.6-terra:high",
				oracle: "openai-codex/gpt-5.6-sol:high",
				qa: "openai-codex/gpt-5.6-sol:high",
				reviewer: "openai-codex/codex-auto-review",
				scout: "tnx/scout",
				quick_task: "openai-codex/gpt-5.6-luna:high",
				task: "openai-codex/gpt-5.6-terra:medium",
				tester: "openai-codex/gpt-5.6-sol:medium",
				plan: "anthropic/claude-fable-5:high",
				designer: "tnx/designer",
				custom_agent: "custom/provider",
			});

			const secondResult = await runShellInstaller(root, installDir);
			expect(secondResult.exitCode).toBe(0);
			const secondConfigText = await Bun.file(configPath).text();
			const secondConfig = YAML.parse(secondConfigText);
			expect(secondConfig).toEqual(firstConfig);
			expect(secondConfigText).toBe(firstConfigText);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	const reviewerMigrationCases = [
		{
			name: "migrates the previously shipped GPT-5.6 Sol reviewer override to auto-review",
			input: "task:\n  agentModelOverrides:\n    reviewer: openai-codex/gpt-5.6-sol:high\n",
			expectedReviewer: "openai-codex/codex-auto-review",
		},
		{
			name: "adds the auto-review reviewer override when an existing override block omits it",
			input: "task:\n  agentModelOverrides:\n    custom_agent: custom/provider\n",
			expectedReviewer: "openai-codex/codex-auto-review",
		},
		{
			name: "preserves a custom reviewer override",
			input: "task:\n  agentModelOverrides:\n    reviewer: custom/provider\n",
			expectedReviewer: "custom/provider",
		},
	] as const;

	for (const { name, input, expectedReviewer } of reviewerMigrationCases) {
		it(name, async () => {
			const binaryContent = RUNNABLE_RELEASE_BINARY;
			const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
			const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
			const configPath = shellConfigPath(root);
			try {
				await Bun.write(configPath, input);

				const result = await runShellInstaller(root, installDir);
				expect(result.exitCode).toBe(0);
				const config = YAML.parse(await Bun.file(configPath).text()) as {
					task: { agentModelOverrides: Record<string, string> };
				};

				expect(config.task.agentModelOverrides.reviewer).toBe(expectedReviewer);
			} finally {
				await fs.promises.rm(root, { recursive: true, force: true });
			}
		});
	}

	it("migrates shell installer scout override and fallback chain idempotently", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(
				configPath,
				`task:
  agentModelOverrides:
    scout: pi/smol
    qa: custom/qa
retry:
  fallbackChains:
    task:
      - openai-codex/gpt-5.6-terra:medium
    scout:
      - leftover/old-scout
`,
			);

			const firstResult = await runShellInstaller(root, installDir);
			expect(firstResult.exitCode).toBe(0);
			const firstConfig = YAML.parse(await Bun.file(configPath).text()) as {
				task: { agentModelOverrides: Record<string, string> };
				retry: { fallbackChains: Record<string, string[]> };
			};

			expect(firstConfig.task.agentModelOverrides.scout).toBe("tnx/scout");
			expect(firstConfig.task.agentModelOverrides.qa).toBe("custom/qa");
			expect(firstConfig.retry.fallbackChains.scout).toEqual(["leftover/old-scout"]);
			expect(firstConfig.retry.fallbackChains.task).toEqual(["openai-codex/gpt-5.6-terra:medium"]);
			expect(firstConfig.retry.fallbackChains.heavy_task).toEqual(["anthropic/claude-opus-5:high"]);

			const secondResult = await runShellInstaller(root, installDir);
			expect(secondResult.exitCode).toBe(0);
			expect(YAML.parse(await Bun.file(configPath).text())).toEqual(firstConfig);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("adds shell installer heavy_task fallback chain to existing retry chains idempotently", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(
				configPath,
				`modelRoles:
  default: local/default-model
task:
  agentModelOverrides:
    designer: tnx/designer
retry:
  fallbackChains:
    task:
      - openai-codex/gpt-5.6-terra:medium
    smol:
      - cerebras/gpt-oss-120b
  otherRetryKey: keepme
providers:
  local:
    baseURL: http://localhost:1234/v1
`,
			);

			const firstResult = await runShellInstaller(root, installDir);
			expect(firstResult.exitCode).toBe(0);
			const firstConfig = YAML.parse(await Bun.file(configPath).text()) as {
				retry: {
					fallbackChains: Record<string, string[]>;
					otherRetryKey: string;
				};
			};

			expect(firstConfig.retry.fallbackChains.heavy_task).toEqual(["anthropic/claude-opus-5:high"]);
			expect(firstConfig.retry.fallbackChains.scout).toEqual([
				"openai-codex/gpt-5.3-codex-spark",
				"anthropic/claude-haiku-4-5",
			]);
			expect(firstConfig.retry.fallbackChains.task).toEqual(["openai-codex/gpt-5.6-terra:medium"]);
			expect(firstConfig.retry.otherRetryKey).toBe("keepme");

			const secondResult = await runShellInstaller(root, installDir);
			expect(secondResult.exitCode).toBe(0);
			const secondConfig = YAML.parse(await Bun.file(configPath).text());
			expect(secondConfig).toEqual(firstConfig);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("does not create shell installer heavy_task fallback chain without retry chains", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(
				configPath,
				`modelRoles:
  default: local/default-model
providers:
  local:
    baseURL: http://localhost:1234/v1
`,
			);

			const result = await runShellInstaller(root, installDir);
			expect(result.exitCode).toBe(0);
			const config = YAML.parse(await Bun.file(configPath).text()) as {
				retry?: { fallbackChains?: Record<string, string[]> };
			};

			expect(config.retry).toBeUndefined();
			expect(config.retry?.fallbackChains?.scout).toBeUndefined();
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("migrates existing legacy GPT-5.5 heavy, QA, and tester overrides", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(
				configPath,
				`task:
  agentModelOverrides:
    heavy_task: openai-codex/gpt-5.5:high
    qa: openai-codex/gpt-5.5:high
    tester: openai-codex/gpt-5.5:medium
`,
			);

			const result = await runShellInstaller(root, installDir);
			expect(result.exitCode).toBe(0);
			const config = YAML.parse(await Bun.file(configPath).text()) as {
				task: { agentModelOverrides: Record<string, string> };
			};

			expect(config.task.agentModelOverrides).toMatchObject({
				heavy_task: "openai-codex/gpt-5.6-terra:high",
				qa: "openai-codex/gpt-5.6-sol:high",
				tester: "openai-codex/gpt-5.6-sol:medium",
			});
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("migrates existing Claude Opus 4.8 routes to Opus 5 while preserving effort suffixes", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(
				configPath,
				`modelRoles:
  default: anthropic/claude-opus-4-8
  slow: anthropic/claude-opus-4-8:high
task:
  agentModelOverrides:
    designer: tnx/designer
    oracle: anthropic/claude-opus-4-8:xhigh
    quick_task: openai-codex/gpt-5.6-luna:high
retry:
  fallbackChains:
    task:
      - anthropic/claude-opus-4-8
      - openai-codex/gpt-5.6-terra:medium
    heavy_task:
      - anthropic/claude-opus-4-8:high
`,
			);

			const firstResult = await runShellInstaller(root, installDir);
			expect(firstResult.exitCode).toBe(0);
			const firstConfig = YAML.parse(await Bun.file(configPath).text()) as {
				modelRoles: Record<string, string>;
				task: { agentModelOverrides: Record<string, string> };
				retry: { fallbackChains: Record<string, string[]> };
			};

			expect(firstConfig.modelRoles).toMatchObject({
				default: "anthropic/claude-opus-5",
				slow: "anthropic/claude-opus-5:high",
			});
			expect(firstConfig.task.agentModelOverrides).toMatchObject({
				oracle: "anthropic/claude-opus-5:xhigh",
				quick_task: "openai-codex/gpt-5.6-luna:high",
			});
			expect(firstConfig.retry.fallbackChains.task).toEqual([
				"anthropic/claude-opus-5",
				"openai-codex/gpt-5.6-terra:medium",
			]);
			expect(firstConfig.retry.fallbackChains.scout).toEqual([
				"openai-codex/gpt-5.3-codex-spark",
				"anthropic/claude-haiku-4-5",
			]);

			const secondResult = await runShellInstaller(root, installDir);
			expect(secondResult.exitCode).toBe(0);
			expect(YAML.parse(await Bun.file(configPath).text())).toEqual(firstConfig);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("bumps previously-shipped heavy_task sol:high override to terra:high while preserving custom overrides", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const configPath = shellConfigPath(root);
		try {
			await Bun.write(
				configPath,
				`task:
  agentModelOverrides:
    heavy_task: openai-codex/gpt-5.6-sol:high
    oracle: openai-codex/gpt-5.5:xhigh
    custom_agent: local/foo
`,
			);

			const firstResult = await runShellInstaller(root, installDir);
			expect(firstResult.exitCode).toBe(0);
			const firstConfig = YAML.parse(await Bun.file(configPath).text()) as {
				task: { agentModelOverrides: Record<string, string> };
			};

			expect(firstConfig.task.agentModelOverrides).toMatchObject({
				heavy_task: "openai-codex/gpt-5.6-terra:high",
				oracle: "openai-codex/gpt-5.6-sol:high",
				custom_agent: "local/foo",
			});

			const secondResult = await runShellInstaller(root, installDir);
			expect(secondResult.exitCode).toBe(0);
			const secondConfig = YAML.parse(await Bun.file(configPath).text());
			expect(secondConfig).toEqual(firstConfig);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("runs the installed config update command for existing shell configs", async () => {
		const binaryContent = `#!/bin/sh
# The installer verifies the freshly downloaded binary with \`--version\` before
# it runs any real command; answer that probe instead of failing the contract.
if [ "$1" = "--version" ]; then
  printf "ompx/0.0.0-test\\n"
  exit 0
fi
if [ "$1" != "config" ] || [ "$2" != "update" ] || [ "$3" != "--json" ] || [ "$#" -ne 3 ]; then
  printf "unexpected args: %s\\n" "$*" >&2
  exit 64
fi
config_file="$PI_CODING_AGENT_DIR/config.yml"
marker_file="$PI_CODING_AGENT_DIR/config-update-ran"
tmp_file="$config_file.tmp"
while IFS= read -r line; do
  case "$line" in
    "setupVersion: 0") printf "setupVersion: 1\\n" ;;
    *) printf "%s\\n" "$line" ;;
  esac
done < "$config_file" > "$tmp_file"
mv "$tmp_file" "$config_file"
printf "called\\n" > "$marker_file"
`;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const codingAgentDir = path.join(root, "agent");
		const configPath = path.join(codingAgentDir, "config.yml");
		const markerPath = path.join(codingAgentDir, "config-update-ran");
		try {
			await fs.promises.mkdir(codingAgentDir, { recursive: true });
			await Bun.write(
				configPath,
				"setupVersion: 0\ntheme:\n  dark: custom\ndisplay:\n  syntaxHighlighting: vivid\nmodelRoles:\n  default: custom-model\n",
			);
			const result = await runShellInstaller(root, installDir, ["--binary"], {
				PI_CODING_AGENT_DIR: codingAgentDir,
			});

			expect(result.exitCode).toBe(0);
			expect(await Bun.file(markerPath).exists()).toBe(true);
			const config = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
			expect(config).toMatchObject({
				setupVersion: 1,
				theme: { dark: "custom" },
				display: { syntaxHighlighting: "vivid" },
				modelRoles: { default: "custom-model" },
				task: {
					agentModelOverrides: {
						designer: "tnx/designer",
						frontend_ui: "tnx/designer",
						ui_ux_reviewer: "tnx/designer",
						ux_copywriter: "tnx/designer",
						scout: "tnx/scout",
					},
				},
			});
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("skips shell installer config seeding when requested", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		try {
			const result = await runShellInstaller(root, installDir, ["--binary"], {
				OMPX_INSTALL_SKIP_STANDARD_CONFIG: "1",
			});

			expect(result.exitCode).toBe(0);
			expect(await Bun.file(shellConfigPath(root)).exists()).toBe(false);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("falls back to the verified binary path when default mode finds an outdated Bun", async () => {
		const binaryContent = RUNNABLE_FALLBACK_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		try {
			const result = await runShellInstaller(root, installDir, []);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Verifying ompx-linux-x64 checksum");
			expect(await Bun.file(path.join(installDir, "ompx")).text()).toBe(binaryContent);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves an existing install when the checksum does not match", async () => {
		const { root, installDir } = await createFakeInstallerTools("tampered binary", "0".repeat(64));
		const installedPath = path.join(installDir, "ompx");
		try {
			await Bun.write(installedPath, "previous binary");
			const result = await runShellInstaller(root, installDir);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("Checksum verification failed for ompx-linux-x64");
			expect(await Bun.file(installedPath).text()).toBe("previous binary");
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
	it("skips CodeGraph installation when requested", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const codegraphLog = path.join(root, "codegraph.log");
		try {
			await writeExecutable(
				path.join(root, "bin", "codegraph"),
				`#!/bin/sh
printf '%s\\n' "$*" >> "$OMPX_CODEGRAPH_LOG"
`,
			);
			const result = await runShellInstaller(root, installDir, ["--binary"], {
				OMPX_CODEGRAPH_LOG: codegraphLog,
				OMPX_INSTALL_SKIP_SUPERPOWERS: "1",
			});

			expect(result.exitCode).toBe(0);
			expect(await Bun.file(codegraphLog).exists()).toBe(false);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("upgrades an existing CodeGraph binary after binary installation", async () => {
		const binaryContent = RUNNABLE_RELEASE_BINARY;
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const codegraphLog = path.join(root, "codegraph.log");
		try {
			await writeExecutable(
				path.join(root, "bin", "codegraph"),
				`#!/bin/sh
printf '%s\\n' "$*" >> "$OMPX_CODEGRAPH_LOG"
`,
			);
			const result = await runShellInstaller(root, installDir, ["--binary"], {
				OMPX_CODEGRAPH_LOG: codegraphLog,
				OMPX_INSTALL_SKIP_CODEGRAPH: "0",
				OMPX_INSTALL_SKIP_SUPERPOWERS: "1",
			});

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Installed/updated CodeGraph");
			expect(await Bun.file(codegraphLog).text()).toBe("upgrade\n");
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("downloads and executes CodeGraph installation after source installation", async () => {
		const { root, installDir } = await createFakeInstallerTools("", "");
		const installLog = path.join(root, "codegraph-install.log");
		try {
			const { shellLogPath, curlLogPath } = await writeCodeGraphInstallerTools(root);
			await writeExecutable(
				path.join(root, "bin", "bun"),
				`#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.3.14\\n'; fi
`,
			);
			const result = await runShellInstaller(root, installDir, ["--source"], {
				OMPX_CODEGRAPH_CURL_LOG: curlLogPath,
				OMPX_CODEGRAPH_INSTALL_LOG: installLog,
				OMPX_CODEGRAPH_INSTALL_URL: "https://example.test/codegraph-install.sh",
				OMPX_CODEGRAPH_SHELL_LOG: shellLogPath,
				OMPX_INSTALL_SKIP_CODEGRAPH: "0",
				OMPX_INSTALL_SKIP_SUPERPOWERS: "1",
				PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
			});

			const temporaryInstaller = (await Bun.file(shellLogPath).text()).trim();
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Installed/updated CodeGraph");
			expect(await Bun.file(curlLogPath).text()).toBe("https://example.test/codegraph-install.sh\n");
			expect(await Bun.file(installLog).text()).toBe("installed\n");
			expect(await Bun.file(temporaryInstaller).exists()).toBe(false);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps OMPx installation successful when CodeGraph download or execution fails", async () => {
		for (const failure of ["download", "execution"] as const) {
			const { root, installDir } = await createFakeInstallerTools("", "");
			try {
				const { curlLogPath, shellLogPath } = await writeCodeGraphInstallerTools(root);
				await writeExecutable(
					path.join(root, "bin", "bun"),
					`#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.3.14\\n'; fi
`,
				);
				const result = await runShellInstaller(root, installDir, ["--source"], {
					OMPX_CODEGRAPH_CURL_LOG: curlLogPath,
					OMPX_CODEGRAPH_INSTALL_URL: "https://example.test/codegraph-install.sh",
					OMPX_CODEGRAPH_SHELL_LOG: shellLogPath,
					OMPX_CODEGRAPH_TEST_CURL_FAIL: failure === "download" ? "1" : "0",
					OMPX_CODEGRAPH_TEST_SH_FAIL: failure === "execution" ? "1" : "0",
					OMPX_INSTALL_SKIP_CODEGRAPH: "0",
					OMPX_INSTALL_SKIP_SUPERPOWERS: "1",
					PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
				});

				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("Failed to install CodeGraph");
				expect(result.output).toContain(
					"curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh",
				);
				expect(await Bun.file(curlLogPath).text()).toBe("https://example.test/codegraph-install.sh\n");
				if (failure === "download") {
					expect(await Bun.file(shellLogPath).exists()).toBe(false);
				} else {
					const temporaryInstaller = (await Bun.file(shellLogPath).text()).trim();
					expect(await Bun.file(temporaryInstaller).exists()).toBe(false);
				}
			} finally {
				await fs.promises.rm(root, { recursive: true, force: true });
			}
		}
	});
});

describePowerShell("install.ps1 supply-chain hardening", () => {
	it(
		"installs a release binary and updates config exactly once after matching SHA256SUMS",
		async () => {
			const { root, installDir, argvLogPath, binaryContent } = await createPowerShellInstallerFixture();
			const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
			const server = startReleaseServer("ompx-windows-x64.exe", binaryContent, checksum);
			try {
				const result = await runPowerShellInstaller(root, installDir, server.url, ["-Binary"], {
					OMPX_TEST_ARGV_LOG: argvLogPath,
				});

				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("Verifying ompx-windows-x64.exe checksum");
				expect(new Uint8Array(await Bun.file(path.join(installDir, "ompx.exe")).arrayBuffer())).toEqual(
					binaryContent,
				);
				expect(normalizeConfig(await Bun.file(powerShellConfigPath(root)).text())).toBe(await readStandardConfig());
				await expectSingleConfigUpdate(argvLogPath);
			} finally {
				server.stop();
				await fs.promises.rm(root, { recursive: true, force: true });
			}
		},
		installerProcessTestOptions,
	);

	it(
		"preserves an existing PowerShell config while updating it exactly once",
		async () => {
			const { root, installDir, argvLogPath, binaryContent } = await createPowerShellInstallerFixture();
			const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
			const server = startReleaseServer("ompx-windows-x64.exe", binaryContent, checksum);
			const configPath = powerShellConfigPath(root);
			try {
				await Bun.write(configPath, "theme:\n  dark: custom\n");
				const result = await runPowerShellInstaller(root, installDir, server.url, ["-Binary"], {
					OMPX_TEST_ARGV_LOG: argvLogPath,
				});

				expect(result.exitCode).toBe(0);
				expect(await Bun.file(configPath).text()).toBe("theme:\n  dark: custom\n");
				await expectSingleConfigUpdate(argvLogPath);
			} finally {
				server.stop();
				await fs.promises.rm(root, { recursive: true, force: true });
			}
		},
		installerProcessTestOptions,
	);

	it(
		"updates config exactly once after a source install",
		async () => {
			const { root, installDir, argvLogPath } = await createPowerShellInstallerFixture();
			try {
				const result = await runPowerShellInstaller(root, installDir, "http://127.0.0.1:1", ["-Source"], {
					OMPX_TEST_ARGV_LOG: argvLogPath,
				});

				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("Installing via bun");
				expect(normalizeConfig(await Bun.file(powerShellConfigPath(root)).text())).toBe(await readStandardConfig());
				await expectSingleConfigUpdate(argvLogPath);
			} finally {
				await fs.promises.rm(root, { recursive: true, force: true });
			}
		},
		installerProcessTestOptions,
	);

	it(
		"fails when the installed binary cannot update config",
		async () => {
			const { root, installDir, argvLogPath, binaryContent } = await createPowerShellInstallerFixture();
			const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
			const server = startReleaseServer("ompx-windows-x64.exe", binaryContent, checksum);
			try {
				const result = await runPowerShellInstaller(root, installDir, server.url, ["-Binary"], {
					OMPX_TEST_ARGV_LOG: argvLogPath,
					OMPX_TEST_EXIT_CODE: "23",
				});

				expect(result.exitCode).toBe(1);
				expect(result.output).toContain("Failed to update existing OMPx config (exit code 23)");
				await expectSingleConfigUpdate(argvLogPath);
			} finally {
				server.stop();
				await fs.promises.rm(root, { recursive: true, force: true });
			}
		},
		installerProcessTestOptions,
	);

	it(
		"falls back to the verified binary path and updates config exactly once when Bun is outdated",
		async () => {
			const { root, installDir, argvLogPath, binaryContent } = await createPowerShellInstallerFixture();
			const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
			const server = startReleaseServer("ompx-windows-x64.exe", binaryContent, checksum);
			try {
				await fs.promises.rm(path.join(root, "bin", "bun.exe"));
				const result = await runPowerShellInstaller(root, installDir, server.url, [], {
					OMPX_TEST_ARGV_LOG: argvLogPath,
				});

				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("Verifying ompx-windows-x64.exe checksum");
				expect(new Uint8Array(await Bun.file(path.join(installDir, "ompx.exe")).arrayBuffer())).toEqual(
					binaryContent,
				);
				await expectSingleConfigUpdate(argvLogPath);
			} finally {
				server.stop();
				await fs.promises.rm(root, { recursive: true, force: true });
			}
		},
		installerProcessTestOptions,
	);

	it(
		"preserves an existing install when the checksum does not match",
		async () => {
			const { root, installDir } = await createFakeInstallerTools("tampered windows binary", "0".repeat(64));
			const installedPath = path.join(installDir, "ompx.exe");
			const server = startReleaseServer("ompx-windows-x64.exe", "tampered windows binary", "0".repeat(64));
			try {
				await Bun.write(installedPath, "previous windows binary");
				const result = await runPowerShellInstaller(root, installDir, server.url);

				expect(result.exitCode).toBe(1);
				expect(result.output).toContain("Checksum verification failed for ompx-windows-x64.exe");
				expect(await Bun.file(installedPath).text()).toBe("previous windows binary");
			} finally {
				server.stop();
				await fs.promises.rm(root, { recursive: true, force: true });
			}
		},
		installerProcessTestOptions,
	);
});
