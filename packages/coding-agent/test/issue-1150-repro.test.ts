import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const smokeTimeoutMs = 90_000;
const killTimeoutMs = 5_000;

async function stopProcess(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
	try {
		proc.kill("SIGKILL");
	} catch {
		// The process may have exited between its completion check and cleanup.
	}
	try {
		await withTimeout(proc.exited, killTimeoutMs, "smoke-test process did not exit after SIGKILL");
	} catch {
		// Cleanup is best-effort; the test failure retains the original command diagnostics.
	}
}

/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1150.
 *
 * Worker clients re-enter the CLI through the worker-host entry. This invokes
 * the real smoke command rather than coupling the regression to the placement
 * of its worker-host declaration in source text.
 */
describe("issue #1150 — smoke CLI worker-host re-entry", () => {
	it(
		"completes the real smoke command after spawning worker re-entries",
		async () => {
			const tempDir = await TempDir.create("@omp-issue-1150-");
			try {
				const home = tempDir.join("home");
				const xdgDataHome = tempDir.join("xdg-data");
				const xdgConfigHome = tempDir.join("xdg-config");
				await Promise.all(
					[home, xdgDataHome, xdgConfigHome].map(directory => fs.mkdir(directory, { recursive: true })),
				);

				const proc = Bun.spawn(["bun", cliEntry, "--smoke-test"], {
					cwd: repoRoot,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						HOME: home,
						XDG_DATA_HOME: xdgDataHome,
						XDG_CONFIG_HOME: xdgConfigHome,
						NO_COLOR: "1",
					},
				});
				const stdout = new Response(proc.stdout).text();
				const stderr = new Response(proc.stderr).text();

				try {
					const exitCode = await withTimeout(
						proc.exited,
						smokeTimeoutMs,
						`smoke command did not exit within ${smokeTimeoutMs}ms`,
					);
					const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
					expect(
						exitCode,
						`bun packages/coding-agent/src/cli.ts --smoke-test failed\nstderr:\n${stderrText}\nstdout:\n${stdoutText}`,
					).toBe(0);
				} catch (error) {
					await stopProcess(proc);
					const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
					throw new Error(
						`bun packages/coding-agent/src/cli.ts --smoke-test failed: ${error instanceof Error ? error.message : String(error)}\nstderr:\n${stderrText}\nstdout:\n${stdoutText}`,
					);
				}
			} finally {
				await tempDir.remove();
			}
		},
		smokeTimeoutMs + killTimeoutMs,
	);
});
