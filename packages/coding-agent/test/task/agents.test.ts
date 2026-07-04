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
		expect(heavy?.model).toEqual(["anthropic/claude-fable-5:low", "openai-codex/gpt-5.5:high", "pi/task", "pi/slow"]);
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
		expect(explore?.tools).toEqual(["read", "grep", "glob", "bash", "web_search", "irc", "yield"]);
		expect(explore?.tools).toContain("web_search");
		expect(explore?.systemPrompt).toContain("Target at most 8 tool calls");
		expect(explore?.systemPrompt).toContain("12 is the hard ceiling");
		expect(explore?.systemPrompt).toContain("NEVER use Context GC tools");
		expect(explore?.systemPrompt).toContain("context_unload");
		expect(explore?.systemPrompt).toContain("MAY use `bash` only for read-only diagnostics");
		expect(explore?.systemPrompt).toContain("shell redirection");
		expect(explore?.systemPrompt).toContain("broad repo archaeology");
		expect(getBundledAgent("reviewer")?.resourceProfile).toBeUndefined();
		expect(getBundledAgent("librarian")?.resourceProfile).toBeUndefined();
	});

	test("registers browser_qa as a browser-driven QA specialist", () => {
		expect(() => loadBundledAgents()).not.toThrow();

		const browserQa = getBundledAgent("browser_qa");

		expect(browserQa).toBeDefined();
		expect(browserQa?.description).toContain("QA");
		expect(browserQa?.tools).toEqual(["browser", "read", "grep", "glob", "bash", "irc", "yield"]);
		expect(browserQa?.tools).not.toContain("edit");
		expect(browserQa?.tools).not.toContain("write");
		expect(browserQa?.model).toEqual(["pi/task"]);
		expect(browserQa?.thinkingLevel).toBe(Effort.Medium);
		expect(browserQa?.output).toEqual({
			properties: {
				summary: { type: "string" },
				cases: {
					elements: {
						properties: {
							name: { type: "string" },
							status: { enum: ["pass", "fail", "blocked"] },
							expected: { type: "string" },
							observed: { type: "string" },
							evidence: { type: "string" },
						},
					},
				},
			},
		});
	});

	test("registers qa as an adversarial read-only verification gate", () => {
		expect(() => loadBundledAgents()).not.toThrow();

		const qa = getBundledAgent("qa");

		expect(qa).toBeDefined();
		expect(qa?.tools).toEqual(["read", "grep", "glob", "bash", "lsp", "irc", "yield"]);
		expect(qa?.tools).not.toContain("edit");
		expect(qa?.tools).not.toContain("write");
		expect(qa?.spawns).toEqual(["browser_qa"]);
		expect(qa?.model).toEqual(["anthropic/claude-fable-5:low", "openai-codex/gpt-5.5:high", "pi/task"]);
		expect(qa?.thinkingLevel).toBe(Effort.High);
		expect(qa?.blocking).toBeFalsy();
		expect(qa?.output).toEqual({
			properties: {
				verdict: { enum: ["pass", "fail", "blocked"] },
				summary: {
					metadata: {
						description: "One paragraph, verdict first, most important defect first",
					},
					type: "string",
				},
				coverage: {
					elements: {
						properties: {
							case: { type: "string" },
							status: { enum: ["pass", "fail", "blocked"] },
							evidence: {
								metadata: {
									description: "Exact command + decisive output, or screenshot/artifact path",
								},
								type: "string",
							},
						},
					},
				},
			},
			optionalProperties: {
				findings: {
					elements: {
						properties: {
							severity: { enum: ["critical", "major", "minor"] },
							title: { type: "string" },
							location: {
								metadata: {
									description: "file:line or URL/flow step",
								},
								type: "string",
							},
							repro: {
								metadata: {
									description: "Exact commands or steps to reproduce",
								},
								type: "string",
							},
							evidence: { type: "string" },
						},
					},
				},
				harness_gaps: {
					metadata: {
						description: "Missing handoff items; REQUIRED when verdict is blocked",
					},
					elements: { type: "string" },
				},
			},
		});
		expect(qa?.systemPrompt).toContain("at least one bug");
		expect(qa?.systemPrompt).toContain("harness_gaps");
		expect(qa?.systemPrompt).toContain("NEVER edit source files");
		expect(qa?.systemPrompt).toContain("Default-deny");
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
