import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { persistWorkflowScript, readWorkflowScript, slugify, workflowDir } from "../../src/workflow/storage";

describe("slugify", () => {
	it("normalizes names, falls back to 'workflow'", () => {
		expect(slugify("Bug Fix #1")).toBe("bug-fix-1");
		expect(slugify("***")).toBe("workflow");
	});
});

describe("persist + read", () => {
	it("round-trips a script under the workflows dir", async () => {
		await using dir = await TempDir.create("wf-storage");
		const base = dir.path();
		const p = await persistWorkflowScript(base, "My Flow", "run-1", "export const meta={name:'x',description:'d'};");
		expect(p.startsWith(path.join(workflowDir(base), "scripts"))).toBe(true);
		const read = await readWorkflowScript(p);
		expect(read.error).toBeUndefined();
		expect(read.script).toContain("meta");
	});
	it("reports an oversize script", async () => {
		await using dir = await TempDir.create("wf-storage2");
		const big = path.join(dir.path(), "big.js");
		await Bun.write(big, "x".repeat(524_289));
		expect((await readWorkflowScript(big)).error).toContain("exceeds");
	});
	it("reports a missing script", async () => {
		expect((await readWorkflowScript("/nonexistent/x.js")).error).toContain("not found");
	});
});
