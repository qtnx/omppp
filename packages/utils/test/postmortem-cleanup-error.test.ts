import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { postmortem } from "@oh-my-pi/pi-utils";

const postmortemModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/index.ts")).href;

async function runPostmortemProbe(
	source: string,
	inheritedEnv: Record<string, string | undefined> = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string; stateHome: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-postmortem-probe-"));
	const stateHome = path.join(root, "state");
	const probePath = path.join(root, "probe.ts");
	try {
		await Bun.write(probePath, source);
		await fs.mkdir(path.join(stateHome, "omp"), { recursive: true });
		const env: Record<string, string | undefined> = {
			...process.env,
			...inheritedEnv,
			XDG_STATE_HOME: stateHome,
		};
		delete env.PI_CODING_AGENT_DIR;
		delete env.OMP_PROFILE;
		delete env.PI_PROFILE;
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		// Process-level regressions can hang the child; the watchdog bounds the fixture without slowing green runs.
		const watchdog = Bun.sleep(2000).then(() => {
			proc.kill();
			return -999;
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			Promise.race([proc.exited, watchdog]),
		]);
		return { exitCode, stdout, stderr, stateHome };
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function wrapCause(reason: Error, wrapperCount: number): Error {
	let current = reason;
	for (let index = 0; index < wrapperCount; index++) {
		current = new Error(`wrapper ${index}`, { cause: current });
	}
	return current;
}

describe("postmortem expected cleanup errors", () => {
	it("marks errors with the well-known cleanup symbol and recognizes them", () => {
		const reason = new Error("browser run ended");

		const marked = postmortem.markExpectedCleanupError(reason);

		expect(marked).toBe(reason);
		expect(Reflect.get(reason, Symbol.for("omp.expectedCleanupError"))).toBe(true);
		expect(postmortem.isExpectedCleanupError(reason)).toBe(true);
	});

	it("recognizes marked cleanup errors through bounded cause chains", () => {
		const marked = postmortem.markExpectedCleanupError(new Error("browser run ended"));
		const withinLimit = wrapCause(marked, 7);
		const beyondLimit = wrapCause(marked, 8);

		expect(postmortem.isExpectedCleanupError(withinLimit)).toBe(true);
		expect(postmortem.isExpectedCleanupError(beyondLimit)).toBe(false);
	});

	it("lets the process survive an unhandled rejection whose cause chain is marked", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			const marked = postmortem.markExpectedCleanupError(new Error("browser run ended"));
			Promise.reject(new Error("abort wrapper", { cause: marked }));
			await Promise.resolve();
			console.log("survived expected cleanup rejection");
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("survived expected cleanup rejection");
		expect(result.stderr).not.toContain("[Unhandled Rejection]");
	});

	it("lets the process survive an uncaught exception that is marked as expected cleanup", async () => {
		const result = await runPostmortemProbe(`
			import { postmortem } from "${postmortemModuleUrl}";

			queueMicrotask(() => {
				throw postmortem.markExpectedCleanupError(new Error("expected cleanup exception"));
			});
			await Promise.resolve();
			console.log("survived expected cleanup exception");
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("survived expected cleanup exception");
		expect(result.stderr).not.toContain("[Uncaught Exception]");
	});

	it("keeps unmarked uncaught exceptions fatal", async () => {
		const result = await runPostmortemProbe(`
			import "${postmortemModuleUrl}";

			queueMicrotask(() => {
				throw new Error("unexpected cleanup exception");
			});
			await Promise.resolve();
		`);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Uncaught Exception] Error: unexpected cleanup exception");
	});

	it("keeps unmarked unhandled rejections fatal", async () => {
		const result = await runPostmortemProbe(
			`
			import "${postmortemModuleUrl}";

			Promise.reject(new Error("unexpected cleanup rejection"));
			await Promise.resolve();
		`,
			{
				PI_CODING_AGENT_DIR: path.join(os.tmpdir(), "inherited-agent"),
				OMP_PROFILE: "inherited-profile",
				PI_PROFILE: "legacy-profile",
			},
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[Unhandled Rejection] Error: unexpected cleanup rejection");
		expect(result.stderr).toContain(path.join(result.stateHome, "omp", "logs", "crash-unhandled_rejection-"));
	});

	it("releases manual cleanup at the deadline even when a callback never settles", async () => {
		const result = await runPostmortemProbe(`
			import { vi } from "bun:test";
			import { postmortem } from "${postmortemModuleUrl}";

			vi.useFakeTimers();
			postmortem.register("never-settles", () => Promise.withResolvers<void>().promise);

			let settled = false;
			const cleanup = postmortem.cleanup().then(() => {
				settled = true;
			});
			await Promise.resolve();
			if (settled) {
				console.error("cleanup settled before the deadline");
				process.exit(2);
			}

			vi.advanceTimersByTime(9999);
			await Promise.resolve();
			if (settled) {
				console.error("cleanup settled before the full deadline");
				process.exit(3);
			}

			vi.advanceTimersByTime(1);
			await cleanup;
			if (!settled) {
				console.error("cleanup stayed pending after the deadline");
				process.exit(4);
			}
			console.log("cleanup deadline released");
		`);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("cleanup deadline released");
		expect(result.stderr).not.toContain("cleanup stayed pending after the deadline");
	});
});
