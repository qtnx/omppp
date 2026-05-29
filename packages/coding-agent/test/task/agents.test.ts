import { afterEach, describe, expect, test } from "bun:test";
import { clearBundledAgentsCache, getBundledAgent, loadBundledAgents } from "../../src/task/agents";

afterEach(() => {
	clearBundledAgentsCache();
});

describe("bundled task agents", () => {
	test("includes heavy_task with strict review gate defaults", () => {
		const names = loadBundledAgents().map(agent => agent.name);
		expect(names).toContain("heavy_task");

		const heavy = getBundledAgent("heavy_task");
		expect(heavy?.description).toContain("heavy");
		expect(heavy?.model).toEqual(["pi/task", "pi/slow"]);
		expect(heavy?.reviewGate).toEqual({
			enabled: true,
			reviewerAgent: "reviewer",
			reviewerModel: ["openai-codex/gpt-5.5:xhigh"],
			fixerAgent: "task",
			maxFixIterations: 2,
			failOnPriorities: [0, 1],
			requireCorrectVerdict: true,
		});
	});

	test("keeps task as the medium worker with a lighter review gate", () => {
		const taskAgent = getBundledAgent("task");
		expect(taskAgent?.description).toContain("Medium");
		expect(taskAgent?.model).toEqual(["pi/task"]);
		expect(taskAgent?.reviewGate).toEqual({
			enabled: true,
			reviewerAgent: "reviewer",
			reviewerModel: ["openai-codex/gpt-5.5:high"],
			fixerAgent: "task",
			maxFixIterations: 1,
			failOnPriorities: [0, 1],
			requireCorrectVerdict: true,
		});
	});

	test("keeps quick_task fast and review-gate free", () => {
		const quick = getBundledAgent("quick_task");
		expect(quick?.description).toContain("Fast");
		expect(quick?.model).toEqual(["pi/smol"]);
		expect(quick?.reviewGate).toEqual({ enabled: false });
	});
});
