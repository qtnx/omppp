import { describe, expect, it } from "bun:test";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { WorkflowRun, workflowConcurrency } from "../../src/workflow/engine";
import { MAX_WORKFLOW_AGENTS } from "../../src/workflow/types";

function makeRun(opts: {
	concurrency?: number;
	budgetTotal?: number | null;
	runSubprocess: (task: string) => Promise<Partial<SingleResult>>;
}) {
	return new WorkflowRun({
		runId: "t1",
		cwd: process.cwd(),
		concurrency: opts.concurrency ?? 2,
		budgetTotal: opts.budgetTotal ?? null,
		signal: new AbortController().signal,
		allocateId: async label => `0-${label}`,
		emit: () => {},
		resolveAgent: () => ({ name: "workflow-subagent" }) as AgentDefinition,
		runSubprocess: async o => ({ index: o.index, id: o.id, ...(await opts.runSubprocess(o.task)) }) as SingleResult,
	});
}

describe("workflowConcurrency", () => {
	it("is clamped to [2,16]", () => {
		const c = workflowConcurrency();
		expect(c).toBeGreaterThanOrEqual(2);
		expect(c).toBeLessThanOrEqual(16);
	});
});

describe("WorkflowRun.spawn", () => {
	it("returns subagent output text", async () => {
		const run = makeRun({ runSubprocess: async p => ({ output: `out:${p}`, usage: { output: 10 } as never }) });
		expect(await run.spawn("hello", {})).toBe("out:hello");
	});
	it("limits concurrency to the configured cap", async () => {
		let active = 0;
		let peak = 0;
		const run = makeRun({
			concurrency: 2,
			runSubprocess: async () => {
				active++;
				peak = Math.max(peak, active);
				await Bun.sleep(10);
				active--;
				return { output: "ok" };
			},
		});
		await Promise.all(Array.from({ length: 6 }, () => run.spawn("x", {})));
		expect(peak).toBeLessThanOrEqual(2);
	});
	it("throws once the lifetime agent cap is exceeded", async () => {
		const run = makeRun({ runSubprocess: async () => ({ output: "ok" }) });
		run.forceAgentCountForTest(MAX_WORKFLOW_AGENTS);
		await expect(run.spawn("x", {})).rejects.toThrow(/agent\(\) call cap/);
	});
	it("enforces the token budget as a hard ceiling", async () => {
		const run = makeRun({
			budgetTotal: 5,
			runSubprocess: async () => ({ output: "ok", usage: { output: 10 } as never }),
		});
		expect(await run.spawn("first", {})).toBe("ok"); // spent → 10 (over 5)
		await expect(run.spawn("second", {})).rejects.toThrow(/budget/i);
	});
	it("rejects isolation requests (not yet supported) for any value", async () => {
		const run = makeRun({ runSubprocess: async () => ({ output: "ok" }) });
		await expect(run.spawn("x", { isolation: "worktree" })).rejects.toThrow(/not yet supported/);
		await expect(run.spawn("y", { isolation: "remote" as never })).rejects.toThrow(/not yet supported/);
	});
});
