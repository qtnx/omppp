import { describe, expect, it, vi } from "bun:test";
import type { WorkflowRunRecord } from "../../workflow/run-registry";
import type { Theme } from "../theme/theme";
import { WorkflowHubOverlayComponent } from "./workflow-hub";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	status: { running: ">", done: "+", error: "!", shadowed: "-" },
	nav: { cursor: ">" },
	sep: { dot: " · " },
	boxRound: { horizontal: "-" },
} as unknown as Theme;

function makeRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
	return {
		runId: "run-active",
		name: "Deploy preview",
		status: "running",
		startedAt: Date.now() - 2_000,
		phases: [{ title: "Implement", startedAt: Date.now() - 1_000 }],
		logs: [],
		agents: [
			{
				id: "agent-first",
				label: "Implementer",
				state: "running",
				model: "task-model",
				tokensIn: 120,
				tokensOut: 80,
				durationMs: 1_000,
				updatedAt: Date.now(),
			},
			{
				id: "agent-second",
				label: "Reviewer",
				state: "done",
				model: "review-model",
				tokensIn: 50,
				tokensOut: 25,
				durationMs: 500,
				updatedAt: Date.now(),
			},
		],
		lastFrameAt: Date.now(),
		...overrides,
	};
}

function makeHarness(runs: WorkflowRunRecord[]) {
	const openTranscript = vi.fn();
	const close = vi.fn();
	const requestRender = vi.fn();
	const registry = {
		list: () => runs,
		get: (id: string) => runs.find(run => run.runId === id),
	};
	const component = new WorkflowHubOverlayComponent({ registry, openTranscript, close, theme, requestRender });
	return { component, openTranscript, close, requestRender };
}

describe("WorkflowHubOverlayComponent", () => {
	it("renders run, phase, and agent rows from in-session registry records", () => {
		const completedRun = makeRun({
			runId: "run-complete",
			name: "Release notes",
			status: "completed",
			endedAt: Date.now(),
			phases: [{ title: "Publish", startedAt: Date.now() - 500 }],
			agents: [],
		});
		const { component } = makeHarness([makeRun(), completedRun]);

		const output = component.render(120).join("\n");

		expect(output).toContain("Deploy preview");
		expect(output).toContain("phase: Implement");
		expect(output).toContain("Implementer");
		expect(output).toContain("Release notes");
		expect(output).toContain("phase: Publish");
	});

	it("moves only among agent rows and opens the selected transcript", () => {
		const { component, openTranscript, requestRender } = makeHarness([
			makeRun(),
			makeRun({ runId: "run-complete", agents: [] }),
		]);

		component.handleInput("j");
		component.handleInput("\r");
		component.handleInput("k");
		component.handleInput("\r");

		expect(requestRender).toHaveBeenCalledTimes(2);
		expect(openTranscript).toHaveBeenNthCalledWith(1, "agent-second");
		expect(openTranscript).toHaveBeenNthCalledWith(2, "agent-first");
	});

	it("keeps the selected agent within the long-list viewport", () => {
		const agents = Array.from({ length: 40 }, (_, index) => ({
			id: `agent-${index}`,
			label: `Agent ${index}`,
			state: "running",
			updatedAt: Date.now(),
		}));
		const { component } = makeHarness([makeRun({ agents })]);

		for (let index = 0; index < 35; index++) component.handleInput("j");
		const output = component.render(120).join("\n");

		expect(output).toContain("... ");
		expect(output).toContain("Agent 35");
	});

	it("closes on Escape", () => {
		const { component, close } = makeHarness([makeRun()]);

		component.handleInput("\u001B");

		expect(close).toHaveBeenCalledTimes(1);
	});
});
