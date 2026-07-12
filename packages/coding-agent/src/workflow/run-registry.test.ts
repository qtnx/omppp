import { describe, expect, it } from "bun:test";
import { WorkflowRunRegistry } from "./run-registry";
import type { WorkflowProgressFrame } from "./types";

const agentFrame = (overrides: Partial<Extract<WorkflowProgressFrame, { kind: "agent" }>> = {}) => ({
	kind: "agent" as const,
	runId: "run-a",
	index: 1,
	label: "Scout",
	phaseTitle: "Discover",
	state: "start" as const,
	agentId: "ScoutAgent",
	...overrides,
});

describe("WorkflowRunRegistry", () => {
	it("lists runs newest first and preserves frame phase attribution", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest({ kind: "phase", runId: "run-a", index: 1, title: "Discover" });
		registry.ingest(agentFrame());
		registry.ingest({ kind: "log", runId: "run-a", message: "started" });
		registry.ingest({ kind: "phase", runId: "run-b", index: 1, title: "Build" });

		const [newest, oldest] = registry.list();
		expect(newest?.runId).toBe("run-b");
		expect(oldest).toMatchObject({
			runId: "run-a",
			phases: [{ title: "Discover" }],
			logs: [{ phase: "Discover", message: "started" }],
			agents: [{ id: "ScoutAgent", label: "Scout", phase: "Discover", state: "running" }],
		});
	});

	it("updates agent token and duration totals from cumulative progress", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest(
			agentFrame({
				progress: {
					inputTokens: 12,
					outputTokens: 4,
					durationMs: 25,
				} as Extract<WorkflowProgressFrame, { kind: "agent" }>["progress"],
			}),
		);
		registry.ingest(
			agentFrame({
				state: "done",
				tokens: 9,
				durationMs: 70,
				progress: {
					inputTokens: 20,
					outputTokens: 9,
					durationMs: 65,
				} as Extract<WorkflowProgressFrame, { kind: "agent" }>["progress"],
			}),
		);

		expect(registry.get("run-a")?.agents).toEqual([
			{
				id: "ScoutAgent",
				label: "Scout",
				phase: "Discover",
				state: "completed",
				tokensIn: 20,
				tokensOut: 9,
				durationMs: 70,
				updatedAt: expect.any(Number),
			},
		]);
	});

	it("keeps a run running until its terminal frame completes it", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest(agentFrame());
		expect(registry.get("run-a")?.status).toBe("running");

		registry.ingest({ kind: "done", runId: "run-a", ok: true });
		expect(registry.get("run-a")).toMatchObject({ status: "completed", endedAt: expect.any(Number) });
	});

	it("reopens a terminal run when a resumed run emits a new progress frame", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest(agentFrame({ state: "done" }));
		registry.ingest({ kind: "done", runId: "run-a", ok: true });

		expect(registry.get("run-a")).toMatchObject({ status: "completed", endedAt: expect.any(Number) });

		registry.ingest(agentFrame({ state: "start" }));

		expect(registry.get("run-a")).toMatchObject({ status: "running", endedAt: undefined });
	});

	it("normalizes every emitted workflow agent state for hub status rendering", () => {
		const statuses = [
			["start", "running"],
			["done", "completed"],
			["error", "failed"],
			["cached", "completed"],
		] as const;

		for (const [state, status] of statuses) {
			const registry = new WorkflowRunRegistry();
			registry.ingest(agentFrame({ state }));

			expect(registry.get("run-a")?.agents[0]?.state).toBe(status);
		}
	});

	it("preserves an emitted agent error message for hub rendering", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest(agentFrame({ state: "error", error: "worker timed out" }));

		expect(registry.get("run-a")?.agents[0]).toMatchObject({
			state: "failed",
			error: "worker timed out",
		});
	});

	it("marks a run failed from a failed terminal frame", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest(agentFrame());
		registry.ingest({ kind: "done", runId: "run-a", ok: false, error: "script failed" });

		expect(registry.get("run-a")).toMatchObject({ status: "failed", endedAt: expect.any(Number) });
	});

	it("clears records and returns undefined for unknown runs", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest(agentFrame());
		registry.clear();

		expect(registry.list()).toEqual([]);
		expect(registry.get("missing")).toBeUndefined();
	});
});
