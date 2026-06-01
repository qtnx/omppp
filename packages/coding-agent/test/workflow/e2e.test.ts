import { describe, expect, it } from "bun:test";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { WorkflowRun, workflowConcurrency } from "../../src/workflow/engine";
import { createWorkflowGlobals } from "../../src/workflow/runtime";
import { runWorkflowScript } from "../../src/workflow/sandbox";
import type { WorkflowProgressFrame } from "../../src/workflow/types";

describe("workflow end-to-end (stubbed subprocess)", () => {
	it("drives phases, pipeline, parallel, and returns a synthesis", async () => {
		const frames: WorkflowProgressFrame[] = [];
		let n = 0;
		const run = new WorkflowRun({
			runId: "e2e",
			cwd: process.cwd(),
			concurrency: workflowConcurrency(),
			budgetTotal: null,
			signal: new AbortController().signal,
			allocateId: async l => `${n++}-${l}`,
			emit: f => frames.push(f),
			resolveAgent: () => ({ name: "workflow-subagent" }) as AgentDefinition,
			runSubprocess: async o =>
				({
					index: o.index,
					id: o.id,
					exitCode: 0,
					output: `R(${o.task})`,
					stderr: "",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					usage: { output: 5 },
				}) as SingleResult,
		});
		const globals = createWorkflowGlobals(run, { topics: ["a", "b"] });

		const script = `
export const meta = { name: "demo", description: "demo", phases: ["scan", "synthesize"] };
phase("scan");
const scanned = await pipeline(args.topics, t => agent("scan:" + t), r => agent("verify:" + r));
phase("synthesize");
const merged = await parallel(scanned.map(s => () => agent("merge:" + s)));
return merged.filter(Boolean).join(" | ");
`;
		const result = await runWorkflowScript(script, globals as unknown as Record<string, unknown>, {
			topics: ["a", "b"],
		});
		expect(result).toBe("R(merge:R(verify:R(scan:a))) | R(merge:R(verify:R(scan:b)))");
		expect(frames.filter(f => f.kind === "phase").map(f => (f as { title: string }).title)).toEqual([
			"scan",
			"synthesize",
		]);
		// 2 scan + 2 verify + 2 merge = 6 completed spawns
		expect(frames.filter(f => f.kind === "agent" && f.state === "done").length).toBe(6);
	});
});
