import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const postmortemModuleUrl = pathToFileURL(join(import.meta.dir, "../src/postmortem.ts")).href;

describe("postmortem crash reports", () => {
	it("persists an unhandled rejection before exiting", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-postmortem-crash-report-"));
		const stateHome = join(root, "state");
		const probePath = join(root, "probe.ts");
		try {
			await Bun.write(
				probePath,
				`import "${postmortemModuleUrl}";\nPromise.reject(new Error("crash-report-probe"));\nawait Promise.resolve();\n`,
			);
			await mkdir(join(stateHome, "omp"), { recursive: true });
			await Bun.write(join(stateHome, "omp", ".keep"), "");
			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, XDG_STATE_HOME: stateHome },
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(stdout).toBe("");
			expect(exitCode).toBe(1);
			expect(stderr).toContain("[Unhandled Rejection] Error: crash-report-probe");
			const pathLine = stderr.split("\n").find(line => line.startsWith("Crash report: "));
			expect(pathLine).toBeDefined();
			const crashPath = pathLine!.slice("Crash report: ".length);
			const record = JSON.parse(await readFile(crashPath, "utf8")) as { kind?: unknown };
			expect(record.kind).toBe("unhandled_rejection");
			expect(
				(await readdir(join(stateHome, "omp", "logs"))).filter(name =>
					name.startsWith("crash-unhandled_rejection-"),
				),
			).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
