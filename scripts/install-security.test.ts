import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const shellInstallerPath = path.join(repoRoot, "scripts", "install.sh");
const powershellInstallerPath = path.join(repoRoot, "scripts", "install.ps1");
const powershellCommand = findExecutable(["pwsh", "powershell"]);
const describePowerShell = powershellCommand ? describe : describe.skip;

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

async function writeExecutable(filePath: string, content: string): Promise<void> {
	await Bun.write(filePath, content);
	await fs.promises.chmod(filePath, 0o755);
}

async function createFakeInstallerTools(binaryContent: string, checksum: string): Promise<{ root: string; installDir: string }> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-install-test-"));
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
  */releases/download/v-test/SHA256SUMS) content='1111111111111111111111111111111111111111111111111111111111111111  omp-darwin-arm64
${checksum}  omp-linux-x64
2222222222222222222222222222222222222222222222222222222222222222  omp-linux-arm64
' ;;
  */releases/download/v-test/omp-linux-x64) content='${binaryContent}' ;;
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
): Promise<{ exitCode: number; output: string }> {
	const proc = Bun.spawn(["sh", shellInstallerPath, ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
			PI_INSTALL_DIR: installDir,
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

async function runPowerShellInstaller(
	root: string,
	installDir: string,
	baseUrl: string,
	args: string[] = ["-Binary"],
): Promise<{ exitCode: number; output: string }> {
	if (!powershellCommand) throw new Error("PowerShell is not available");
	const userProfile = path.join(root, "profile");
	const localAppData = path.join(root, "localappdata");
	await fs.promises.mkdir(userProfile, { recursive: true });
	await fs.promises.mkdir(localAppData, { recursive: true });
	const proc = Bun.spawn([powershellCommand, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", powershellInstallerPath, ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
			PI_INSTALL_DIR: installDir,
			PI_GITHUB_API_BASE_URL: `${baseUrl}/api`,
			PI_RELEASE_DOWNLOAD_BASE_URL: `${baseUrl}/download`,
			USERPROFILE: userProfile,
			LOCALAPPDATA: localAppData,
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

function startReleaseServer(binaryName: string, binaryContent: string, checksum: string): { url: string; stop: () => void } {
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

	it("installs a release binary only after matching SHA256SUMS", async () => {
		const binaryContent = "safe release binary";
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		try {
			const result = await runShellInstaller(root, installDir);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Verifying omp-linux-x64 checksum");
			expect(await Bun.file(path.join(installDir, "omp")).text()).toBe(binaryContent);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("falls back to the verified binary path when default mode finds an outdated Bun", async () => {
		const binaryContent = "safe fallback binary";
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		try {
			const result = await runShellInstaller(root, installDir, []);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Verifying omp-linux-x64 checksum");
			expect(await Bun.file(path.join(installDir, "omp")).text()).toBe(binaryContent);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves an existing install when the checksum does not match", async () => {
		const { root, installDir } = await createFakeInstallerTools("tampered binary", "0".repeat(64));
		const installedPath = path.join(installDir, "omp");
		try {
			await Bun.write(installedPath, "previous binary");
			const result = await runShellInstaller(root, installDir);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("Checksum verification failed for omp-linux-x64");
			expect(await Bun.file(installedPath).text()).toBe("previous binary");
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});

describePowerShell("install.ps1 supply-chain hardening", () => {
	it("installs a release binary only after matching SHA256SUMS", async () => {
		const binaryContent = "safe windows release binary";
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const server = startReleaseServer("omp-windows-x64.exe", binaryContent, checksum);
		try {
			const result = await runPowerShellInstaller(root, installDir, server.url);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Verifying omp-windows-x64.exe checksum");
			expect(await Bun.file(path.join(installDir, "omp.exe")).text()).toBe(binaryContent);
		} finally {
			server.stop();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("falls back to the verified binary path when default mode finds an outdated Bun", async () => {
		const binaryContent = "safe windows fallback binary";
		const checksum = new Bun.CryptoHasher("sha256").update(binaryContent).digest("hex");
		const { root, installDir } = await createFakeInstallerTools(binaryContent, checksum);
		const server = startReleaseServer("omp-windows-x64.exe", binaryContent, checksum);
		try {
			const result = await runPowerShellInstaller(root, installDir, server.url, []);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Verifying omp-windows-x64.exe checksum");
			expect(await Bun.file(path.join(installDir, "omp.exe")).text()).toBe(binaryContent);
		} finally {
			server.stop();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves an existing install when the checksum does not match", async () => {
		const { root, installDir } = await createFakeInstallerTools("tampered windows binary", "0".repeat(64));
		const installedPath = path.join(installDir, "omp.exe");
		const server = startReleaseServer("omp-windows-x64.exe", "tampered windows binary", "0".repeat(64));
		try {
			await Bun.write(installedPath, "previous windows binary");
			const result = await runPowerShellInstaller(root, installDir, server.url);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("Checksum verification failed for omp-windows-x64.exe");
			expect(await Bun.file(installedPath).text()).toBe("previous windows binary");
		} finally {
			server.stop();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
