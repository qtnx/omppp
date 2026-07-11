import { afterEach, describe, expect, it, vi } from "bun:test";
import type { WorkflowRunRecord } from "../../workflow/run-registry";
import type { Theme } from "../theme/theme";
import { WorkflowHubOverlayComponent } from "./workflow-hub";

const originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function setViewportRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function restoreViewportRows(): void {
	if (originalRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
		return;
	}
	Reflect.deleteProperty(process.stdout, "rows");
}

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
				sessionFile: "/t/run-active/agent-first.jsonl",
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
				sessionFile: "/t/run-active/agent-second.jsonl",
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
afterEach(() => {
	restoreViewportRows();
});

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
		expect(openTranscript).toHaveBeenNthCalledWith(1, "agent-second", "/t/run-active/agent-second.jsonl");
		expect(openTranscript).toHaveBeenNthCalledWith(2, "agent-first", "/t/run-active/agent-first.jsonl");
	});

	it("keeps the selected agent within the long-list viewport", () => {
		setViewportRows(12);
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

	it("renders an emitted start state as active", () => {
		const { component } = makeHarness([
			makeRun({ agents: [{ id: "agent-start", label: "Runner", state: "start", updatedAt: Date.now() }] }),
		]);

		expect(component.render(120).join("\n")).toContain("> start");
	});

	it("renders an emitted error state as failed", () => {
		const { component } = makeHarness([
			makeRun({ agents: [{ id: "agent-error", label: "Runner", state: "error", updatedAt: Date.now() }] }),
		]);

		expect(component.render(120).join("\n")).toContain("! error");
	});

	it("does not route keys through a disposed hub after reopening", () => {
		const opened: string[] = [];
		const runs = [makeRun()];
		const first = new WorkflowHubOverlayComponent({
			registry: { list: () => runs, get: id => runs.find(run => run.runId === id) },
			openTranscript: agentId => opened.push(agentId),
			close: () => {},
			theme,
		});
		first.dispose();
		const second = new WorkflowHubOverlayComponent({
			registry: { list: () => runs, get: id => runs.find(run => run.runId === id) },
			openTranscript: agentId => opened.push(agentId),
			close: () => {},
			theme,
		});

		try {
			first.handleInput("\r");
			second.handleInput("\r");

			expect(opened).toEqual(["agent-first"]);
		} finally {
			second.dispose();
		}
	});

	it("restores the prior agent selection after an empty filtered result", () => {
		const run = makeRun();
		let visibleRuns: WorkflowRunRecord[] = [run];
		const openTranscript = vi.fn();
		const component = new WorkflowHubOverlayComponent({
			registry: {
				list: () => visibleRuns,
				get: id => visibleRuns.find(candidate => candidate.runId === id),
			},
			openTranscript,
			close: () => {},
			theme,
		});

		try {
			component.handleInput("j");
			visibleRuns = [];
			component.refresh();
			component.handleInput("j");
			visibleRuns = [run];
			component.refresh();
			component.handleInput("\r");

			expect(openTranscript).toHaveBeenCalledWith("agent-second", "/t/run-active/agent-second.jsonl");
		} finally {
			component.dispose();
		}
	});

	it("closes on Escape", () => {
		const { component, close } = makeHarness([makeRun()]);

		component.handleInput("\u001B");

		expect(close).toHaveBeenCalledTimes(1);
	});
});
