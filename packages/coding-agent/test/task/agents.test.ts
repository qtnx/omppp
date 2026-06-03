import { afterEach, describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseAgentFields } from "../../src/discovery/helpers";
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

	test("keeps the explore scout narrow, fast, and read-only", () => {
		const explore = getBundledAgent("explore");

		expect(explore?.resourceProfile).toBe("minimal");
		expect(explore?.thinkingLevel).toBe(Effort.Medium);
		expect(explore?.tools).toEqual(["read", "search", "find", "bash", "yield"]);
		expect(explore?.tools).not.toContain("web_search");
		expect(explore?.systemPrompt).toContain("Target at most 8 tool calls");
		expect(explore?.systemPrompt).toContain("12 is the hard ceiling");
		expect(explore?.systemPrompt).toContain("MUST NOT use Context GC tools");
		expect(explore?.systemPrompt).toContain("context_unload");
		expect(explore?.systemPrompt).toContain("MAY use `bash` only for read-only diagnostics");
		expect(explore?.systemPrompt).toContain("shell redirection");
		expect(explore?.systemPrompt).toContain("broad repo archaeology");
		expect(getBundledAgent("reviewer")?.resourceProfile).toBeUndefined();
		expect(getBundledAgent("librarian")?.resourceProfile).toBeUndefined();
	});

	test("preserves explicit empty tool lists through parsing", () => {
		const parsed = parseAgentFields({
			name: "empty-tools",
			description: "Explicit empty tools",
			tools: [],
			resourceProfile: "minimal",
		});

		expect(parsed?.tools).toEqual([]);
		expect(parsed?.resourceProfile).toBe("minimal");
		expect(parseAgentFields({ name: "default-tools", description: "Default tools" })?.tools).toBeUndefined();
	});
});
