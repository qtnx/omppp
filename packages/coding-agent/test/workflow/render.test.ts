import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";
import type { AgentProgress } from "../../src/task/types";
import { renderWorkflowTree } from "../../src/workflow/render";
import type { WorkflowProgressFrame } from "../../src/workflow/types";

describe("renderWorkflowTree", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("groups agents under phases, collapses to latest state, surfaces logs", () => {
		const frames: WorkflowProgressFrame[] = [
			{ kind: "phase", runId: "r", index: 1, title: "scan" },
			{
				kind: "agent",
				runId: "r",
				index: 1,
				label: "scan:a",
				phaseTitle: "scan",
				state: "start",
				agentId: "0-scan",
			},
			{
				kind: "agent",
				runId: "r",
				index: 1,
				label: "scan:a",
				phaseTitle: "scan",
				state: "done",
				agentId: "0-scan",
				durationMs: 120,
			},
			{ kind: "log", runId: "r", message: "1 found" },
		];
		const text = renderWorkflowTree(frames);
		expect(text).toContain("▸ scan");
		expect(text).toContain("scan:a");
		expect(text).toContain("✓"); // done glyph (last state wins over start)
		expect(text).not.toContain("•"); // start glyph collapsed away
		expect(text).toContain("» 1 found");
	});

	it("renders live workflow agent progress with model, status, and latest activity", async () => {
		const theme = (await getThemeByName("dark"))!;
		const progress: AgentProgress = {
			index: 1,
			id: "0-Discovery",
			agent: "explore",
			agentSource: "bundled",
			status: "running",
			task: "Inspect workflow render path",
			assignment: "Inspect workflow render path",
			description: "Discovery agent",
			currentTool: "read",
			currentToolArgs: "packages/coding-agent/src/workflow/render.ts",
			lastIntent: "Inspect workflow renderer",
			currentToolStartMs: Date.now(),
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 128,
			requests: 1,
			cost: 0,
			durationMs: 250,
			resolvedModel: "anthropic/claude-sonnet-4",
		};
		const frames: WorkflowProgressFrame[] = [
			{ kind: "phase", runId: "r", index: 1, title: "Explore" },
			{
				kind: "agent",
				runId: "r",
				index: 1,
				label: "Discovery agent",
				phaseTitle: "Explore",
				state: "start",
				agentId: "0-Discovery",
				model: "requested/model",
				progress,
			},
		];

		const text = Bun.stripANSI(renderWorkflowTree(frames, { theme, expanded: false, spinnerFrame: 0 }));

		expect(text).toContain("Discovery agent");
		expect(text).toContain("anthropic/claude-sonnet-4");
		expect(text).toContain("explore");
		expect(text).toContain("read: Inspect workflow renderer");
	});

	it("returns a placeholder when empty", () => {
		expect(renderWorkflowTree([])).toContain("no workflow activity");
	});
});
