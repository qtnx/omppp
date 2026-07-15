import { afterEach, describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseAgentFields } from "../../src/discovery/helpers";
import { clearBundledAgentsCache, getBundledAgent, loadBundledAgents } from "../../src/task/agents";

afterEach(() => {
	clearBundledAgentsCache();
});

const FRONTEND_SKILLS = ["frontend-design", "frontend-accessibility", "frontend-ui-copy"];
const REVIEW_COMMENT_PATTERN = /\[REVIEW|# REVIEW/i;

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
		expect(taskAgent?.model).toEqual(["@task"]);
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

	test("keeps designer as the stable production frontend UI/UX owner", () => {
		const designers = loadBundledAgents().filter(agent => agent.name === "designer");
		expect(designers).toHaveLength(1);

		const designer = designers[0];
		expect(designer?.tools ?? []).toContain("browser");
		expect(designer?.autoloadSkills).toEqual(FRONTEND_SKILLS);
		expect(designer?.model).toEqual(["tnx/designer"]);
		expect(designer?.description).toMatch(/design lead[\s\S]{0,160}(direction|system|concept)/i);
		expect(designer?.description).toMatch(/scoped[\s\S]{0,160}(frontend_ui|ui_ux_reviewer)/i);
		expect(designer?.systemPrompt).toMatch(/production design lead/i);
		expect(designer?.systemPrompt).not.toMatch(REVIEW_COMMENT_PATTERN);
	});

	test("front-end specialized agents route to the designer model", () => {
		const names = loadBundledAgents().map(agent => agent.name);
		expect(names.filter(name => name === "designer")).toHaveLength(1);
		const designer = getBundledAgent("designer");
		expect(designer?.model).toEqual(["tnx/designer"]);

		const frontendUi = getBundledAgent("frontend_ui");
		expect(frontendUi?.name).toBe("frontend_ui");
		expect(frontendUi?.tools).toContain("browser");
		expect(frontendUi?.autoloadSkills).toEqual(FRONTEND_SKILLS);
		expect(frontendUi?.model).toEqual(["tnx/designer"]);
		expect(frontendUi?.description).toMatch(/scoped[\s\S]{0,80}UI[\s\S]{0,80}(build|implement)/i);
		expect(frontendUi?.description).toMatch(/existing design system/i);
		expect(frontendUi?.description).toMatch(
			/(escalat|hand off|defer)[\s\S]{0,120}designer[\s\S]{0,120}(direction|system|concept)/i,
		);
		expect(frontendUi?.systemPrompt).toMatch(/production frontend UI implementer/i);
		expect(frontendUi?.systemPrompt).toMatch(/composition patterns/i);
		expect(frontendUi?.systemPrompt).not.toMatch(REVIEW_COMMENT_PATTERN);

		const uiUxReviewer = getBundledAgent("ui_ux_reviewer");
		expect(uiUxReviewer?.name).toBe("ui_ux_reviewer");
		expect(uiUxReviewer?.tools).toEqual(["browser", "read", "grep", "glob", "irc", "yield"]);
		expect(uiUxReviewer?.autoloadSkills).toEqual(FRONTEND_SKILLS);
		expect(uiUxReviewer?.model).toEqual(["tnx/designer"]);
		expect(uiUxReviewer?.description).toMatch(/(UI|UX|design)[\s\S]{0,80}review/i);
		expect(uiUxReviewer?.systemPrompt).toMatch(/UI\/UX review specialist/i);
		expect(uiUxReviewer?.systemPrompt).toMatch(/accessibility[\s\S]{0,160}interface states/i);
		expect(uiUxReviewer?.systemPrompt).not.toMatch(REVIEW_COMMENT_PATTERN);

		const uxCopywriter = getBundledAgent("ux_copywriter");
		expect(uxCopywriter?.name).toBe("ux_copywriter");
		expect(uxCopywriter?.autoloadSkills).toEqual(["frontend-ui-copy"]);
		expect(uxCopywriter?.model).toEqual(["tnx/designer"]);
		expect(uxCopywriter?.description).toMatch(/UX[\s\S]{0,80}(copy|copywriting|microcopy)/i);
		expect(uxCopywriter?.systemPrompt).toMatch(/keep scope to strings/i);
		expect(uxCopywriter?.systemPrompt).toMatch(/i18n|source locale|source-language|source language/i);
		expect(uxCopywriter?.systemPrompt).not.toMatch(REVIEW_COMMENT_PATTERN);
	});

	test("registers presenter with preview-templates autoload", () => {
		const presenter = getBundledAgent("presenter");

		expect(presenter).toBeDefined();
		expect(presenter?.source).toBe("bundled");
		expect(presenter?.name).toBe("presenter");
		expect(presenter?.model).toEqual(["tnx/designer"]);
		expect(presenter?.autoloadSkills).toEqual(["preview-templates"]);
		expect(presenter?.tools ?? []).toEqual(
			expect.arrayContaining(["read", "grep", "glob", "bash", "edit", "write", "browser", "irc", "yield"]),
		);
		expect(presenter?.tools ?? []).not.toContain("task");
		expect(presenter?.description).toMatch(/\.canvas\.json|canvas/i);
		expect(presenter?.description).toMatch(/product[- ]preview/i);
		expect(presenter?.description).toMatch(/html|mockup/i);
		expect(presenter?.systemPrompt).toMatch(/docs\/product\/canvases\/.*\.canvas\.json/i);
		expect(presenter?.systemPrompt).toMatch(/version:\s*1|version":\s*1/i);
		expect(presenter?.systemPrompt).toMatch(/story-map/);
		expect(presenter?.systemPrompt).toMatch(/journey-map/);
		expect(presenter?.systemPrompt).toMatch(/architecture/);
		expect(presenter?.systemPrompt).toMatch(/all-or-none/i);
		expect(presenter?.systemPrompt).toMatch(/review-only/i);
		expect(presenter?.systemPrompt).toMatch(/NEVER[\s\S]{0,80}(HTML|style|URL|React Flow)/i);
		expect(presenter?.systemPrompt).toMatch(/kind=mockup|self-contained \.html/i);
		expect(presenter?.systemPrompt).not.toMatch(REVIEW_COMMENT_PATTERN);

		const names = loadBundledAgents().map(agent => agent.name);
		expect(names.filter(name => name === "presenter")).toHaveLength(1);
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
