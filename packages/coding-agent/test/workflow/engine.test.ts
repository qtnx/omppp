import { describe, expect, it } from "bun:test";
import type { AgentDefinition, AgentProgress, SingleResult } from "../../src/task/types";
import { WorkflowRun, workflowConcurrency } from "../../src/workflow/engine";
import { MAX_WORKFLOW_AGENTS, type WorkflowProgressFrame } from "../../src/workflow/types";

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
		runSubprocess: async o =>
			({
				index: o.index,
				id: o.id,
				exitCode: 0,
				stderr: "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				...(await opts.runSubprocess(o.task)),
			}) as SingleResult,
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

	it("emits task-style progress frames from subagent progress callbacks", async () => {
		const frames: WorkflowProgressFrame[] = [];
		const progress: AgentProgress = {
			index: 1,
			id: "0-Discovery",
			agent: "workflow-subagent",
			agentSource: "bundled",
			status: "running",
			task: "inspect workflow ui",
			assignment: "inspect workflow ui",
			description: "Discovery agent",
			currentTool: "read",
			currentToolArgs: "packages/coding-agent/src/workflow/render.ts",
			lastIntent: "Inspect workflow renderer",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 17,
			cost: 0,
			durationMs: 5,
			resolvedModel: "anthropic/claude-sonnet-4",
		};
		const run = new WorkflowRun({
			runId: "t1",
			cwd: process.cwd(),
			concurrency: 1,
			budgetTotal: null,
			signal: new AbortController().signal,
			allocateId: async label => `0-${label}`,
			emit: frame => frames.push(frame),
			resolveAgent: () => ({ name: "workflow-subagent" }) as AgentDefinition,
			runSubprocess: async options => {
				options.onProgress?.(progress);
				return {
					index: options.index,
					id: options.id,
					agent: "workflow-subagent",
					agentSource: "bundled",
					task: options.task,
					assignment: options.assignment,
					description: options.description,
					exitCode: 0,
					output: "ok",
					stderr: "",
					truncated: false,
					durationMs: 10,
					tokens: 17,
					resolvedModel: "anthropic/claude-sonnet-4",
					usage: { output: 17 } as never,
				} satisfies SingleResult;
			},
		});

		await run.spawn("inspect workflow ui", { label: "Discovery agent" });

		const liveFrame = frames.find(
			(frame): frame is Extract<WorkflowProgressFrame, { kind: "agent" }> =>
				frame.kind === "agent" && frame.progress?.currentTool === "read",
		);
		expect(liveFrame?.progress?.resolvedModel).toBe("anthropic/claude-sonnet-4");
		expect(liveFrame?.progress?.lastIntent).toBe("Inspect workflow renderer");

		const doneFrame = frames.find(
			(frame): frame is Extract<WorkflowProgressFrame, { kind: "agent" }> =>
				frame.kind === "agent" && frame.state === "done",
		);
		expect(doneFrame?.model).toBe("anthropic/claude-sonnet-4");
		expect(doneFrame?.progress?.status).toBe("completed");
	});
});
