import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { rewriteCommandWithRtk } from "@oh-my-pi/pi-coding-agent/tools/rtk-rewrite";

const tempDirs: string[] = [];

async function createRtkFixture(stdout: string, exitCode: number): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rtk-rewrite-"));
	tempDirs.push(tempDir);
	const executable = path.join(tempDir, "rtk");
	// The payload goes through a file so the fixture reproduces RTK's stdout
	// byte-for-byte, including padding and newlines the helper must trim.
	const payload = path.join(tempDir, "stdout.txt");
	await Bun.write(payload, stdout);
	await Bun.write(executable, `#!/bin/sh\ncat ${JSON.stringify(payload)}\nexit ${exitCode}\n`);
	await fs.chmod(executable, 0o755);
	return executable;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(tempDir => fs.rm(tempDir, { recursive: true, force: true })));
});

describe("rewriteCommandWithRtk", () => {
	it.each([
		["successful rewrites", 0],
		["RTK's documented partial-success rewrites", 3],
	] as const)("uses non-empty stdout for %s", async (_caseName, exitCode) => {
		const executable = await createRtkFixture("  printf compact-output  \n", exitCode);

		await expect(rewriteCommandWithRtk("printf original-output", { executable })).resolves.toBe(
			"printf compact-output",
		);
	});

	it("fails open for unavailable, failing, and empty-output RTK invocations", async () => {
		const original = "printf original-output";
		const failingExecutable = await createRtkFixture("printf rewritten-output", 2);
		const emptyExecutable = await createRtkFixture("", 0);
		const missingExecutable = path.join(os.tmpdir(), `missing-rtk-${crypto.randomUUID()}`);

		await expect(rewriteCommandWithRtk(original, { executable: null })).resolves.toBe(original);
		await expect(rewriteCommandWithRtk(original, { executable: missingExecutable })).resolves.toBe(original);
		await expect(rewriteCommandWithRtk(original, { executable: failingExecutable })).resolves.toBe(original);
		await expect(rewriteCommandWithRtk(original, { executable: emptyExecutable })).resolves.toBe(original);
	});

	it("does not re-run commands already rewritten by RTK", async () => {
		const executable = await createRtkFixture("printf rewritten-twice", 0);
		const original = "rtk printf already-compressed";

		await expect(rewriteCommandWithRtk(original, { executable })).resolves.toBe(original);
	});
});
