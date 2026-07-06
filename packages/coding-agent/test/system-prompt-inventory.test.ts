import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt as buildSdkSystemPrompt } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	buildSystemPrompt,
	DEFAULT_SYSTEM_PROMPT_TOOL_NAMES,
	type SystemPromptToolMetadata,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { buildSkillPromptMessage, loadSkills } from "../src/extensibility/skills";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const TOOLS = new Map<string, SystemPromptToolMetadata>([
	[
		"read",
		{
			label: "Read",
			description: "Reads files from disk.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	],
	[
		"bash",
		{
			label: "Bash",
			description: "Executes a shell command.",
			parameters: { type: "object", properties: { command: { type: "string" } } },
		},
	],
]);

const SDK_TOOL: Tool = {
	name: "sdk_custom",
	label: "SDK Custom",
	description: "SDK-provided custom tool.",
	parameters: { type: "object", properties: {} },
	approval: "read",
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
};

const ARCHIVE_PROMPT_SKILL_NAMES = [
	"bug-hunting",
	"feature-anatomy",
	"refactoring-safely",
	"migration-upgrade",
	"database-craft",
	"security-review",
	"concurrency-correctness",
	"dependency-doctor",
	"writing-tests-that-matter",
	"verify-before-done",
	"subagents-development",
	"code-review-lens",
	"git-craft",
	"incident-response",
] as const;

describe("system prompt tool inventory", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-inv-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-inv-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(opts: { nativeTools: boolean; inlineToolDescriptors: boolean }): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "bash"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: opts.nativeTools,
			inlineToolDescriptors: opts.inlineToolDescriptors,
		});
		return systemPrompt.join("\n\n");
	}

	async function renderWithCompactTool(): Promise<string> {
		const tools = new Map<string, SystemPromptToolMetadata>(TOOLS);
		tools.set("compact", {
			label: "Compact",
			description: "Archives context for later retrieval.",
			parameters: { type: "object", properties: {} },
		});
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "bash", "compact"],
			tools,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: false,
		});
		return systemPrompt.join("\n\n");
	}

	async function renderOrchestratorPrompt(): Promise<string> {
		const tools = new Map<string, SystemPromptToolMetadata>(TOOLS);
		tools.set("task", {
			label: "Task",
			description: "Runs subagents.",
			parameters: { type: "object", properties: { tasks: { type: "array" } } },
		});
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "bash", "task"],
			tools,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: false,
			eagerTasks: true,
		});
		return systemPrompt.join("\n\n");
	}

	function inventoryFrom(text: string): string {
		// Tolerate either prompt layout: the merge-base "# Inventory" / "ENV" framing and the
		// reordered "# Tool Inventory" / "TOOL POLICY" framing on current main. The slice just
		// needs to isolate the rendered tool list from the rest of the prompt.
		const inventoryStart =
			["# Tool Inventory", "# Inventory"].map(header => text.indexOf(header)).find(index => index >= 0) ?? -1;
		expect(inventoryStart).toBeGreaterThan(-1);
		const sectionEnds = ["\nENV\n", "\nTOOL POLICY", "\n# "]
			.map(marker => text.indexOf(marker, inventoryStart + 1))
			.filter(index => index > inventoryStart);
		const inventoryEnd = sectionEnds.length > 0 ? Math.min(...sectionEnds) : text.length;
		return text.slice(inventoryStart, inventoryEnd);
	}

	it("renders a compact name list only when native tools are active and descriptors stay in schemas", async () => {
		const text = await render({ nativeTools: true, inlineToolDescriptors: false });
		expect(text).toContain("- Read: `read`");
		expect(text).toContain("- Bash: `bash`");
		// No full per-tool sections in list mode.
		expect(text).not.toContain("# Tool: read");
		expect(text).not.toContain("Reads files from disk.");
	});

	it("teaches that compact schedules stale context archival at turn boundaries", async () => {
		const text = await renderWithCompactTool();
		const compactGuidance = text.match(/.{0,500}compact.{0,700}/gis)?.join("\n---\n") ?? "";

		expect(compactGuidance).toMatch(/compact/i);
		expect(compactGuidance).toMatch(/schedul\w*[\s\S]{0,220}archiv\w*|archiv\w*[\s\S]{0,220}schedul\w*/i);
		expect(compactGuidance).toMatch(
			/(?:stale|older)[\s\S]{0,260}context[\s\S]{0,260}(?:no longer needed|not needed (?:for )?next)|context[\s\S]{0,260}(?:no longer needed|not needed (?:for )?next)/i,
		);
		expect(compactGuidance).toMatch(/last action|end[- ]of[- ]turn|end of your turn|before ending (?:your )?turn/i);
	});

	it("renders `# Tool:` sections (not a name list) when tools are not native", async () => {
		const text = await render({ nativeTools: false, inlineToolDescriptors: false });
		expect(text).toContain("# Tool: read");
		expect(text).toContain("# Tool: bash");
		expect(text).toContain("Reads files from disk.");
		expect(text).not.toContain("- Read: `read`");
		// The legacy `<tool>` wrapper is gone.
		expect(text).not.toContain("<tool name=");
	});

	it("renders `# Tool:` sections when descriptors are inlined even with native tools", async () => {
		const text = await render({ nativeTools: true, inlineToolDescriptors: true });
		expect(text).toContain("# Tool: read");
		expect(text).toContain("Executes a shell command.");
		expect(text).not.toContain("- Read: `read`");
	});

	it("uses a conservative fallback inventory when no tools map is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const inventory = inventoryFrom(systemPrompt.join("\n\n"));
		for (const toolName of DEFAULT_SYSTEM_PROMPT_TOOL_NAMES) {
			expect(inventory).toContain(`- \`${toolName}\``);
		}
		expect(inventory).not.toContain("- `browser`");
		expect(inventory).not.toContain("- `task`");
	});

	it("SDK wrapper renders provided tools instead of the fallback inventory", async () => {
		const { systemPrompt } = await buildSdkSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			tools: [SDK_TOOL],
		});
		const inventory = inventoryFrom(systemPrompt.join("\n\n"));
		expect(inventory).toContain("- SDK Custom: `sdk_custom`");
		expect(inventory).not.toContain("- `read`");
	});

	it("SDK wrapper preserves an explicit empty tool list", async () => {
		const { systemPrompt } = await buildSdkSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			tools: [],
		});
		const text = systemPrompt.join("\n\n");

		expect(text).not.toContain("# Inventory");
		expect(text).not.toContain("- `read`");
	});

	it("keeps visible skills when no tools map is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [
				{
					name: "prompt-authoring",
					description: "Prompt authoring workflow",
					filePath: path.join(tempDir, "SKILL.md"),
					baseDir: tempDir,
					source: "test",
				},
			],
			rules: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).toContain("- prompt-authoring: Prompt authoring workflow");
	});

	it("omits skills when active tool names exclude read", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [
				{
					name: "search-only-skill",
					description: "Should not render without read",
					filePath: path.join(tempDir, "SKILL.md"),
					baseDir: tempDir,
					source: "test",
				},
			],
			rules: [],
			toolNames: ["bash"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).not.toContain("search-only-skill");
	});

	it("omits hidden skills even when read is active", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [
				{
					name: "hidden-workflow",
					description: "Hidden prompt workflow",
					filePath: path.join(tempDir, "SKILL.md"),
					baseDir: tempDir,
					source: "test",
					hide: true,
				},
			],
			rules: [],
			toolNames: ["read"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).not.toContain("hidden-workflow");
	});

	it("tells the agent to read matching skills before work", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [
				{
					name: "frontend-design",
					description: "Frontend UI workflow",
					filePath: path.join(tempDir, "SKILL.md"),
					baseDir: tempDir,
					source: "test",
				},
			],
			rules: [],
			toolNames: ["read"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).toContain("<skills>");
		expect(text).toContain("- frontend-design: Frontend UI workflow");
	});

	it("renders the bundled frontend skill as a discoverable session skill", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			rules: [],
			toolNames: ["read"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).toContain("<skills>");
		expect(text).toMatch(/- frontend-design: [^\n]*(frontend|UI|UX|design)/i);
	});

	it("requires verify-before-done before completion claims when bundled skills are available", async () => {
		const { skills } = await loadSkills({ cwd: tempDir });
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills,
			rules: [],
			toolNames: ["read"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");

		expect(text).toMatch(/(?:skill:\/\/)?verify-before-done/i);
		expect(text).toMatch(
			/(?:MUST|REQUIRED|mandatory|required)[\s\S]{0,400}(?:skill:\/\/)?verify-before-done[\s\S]{0,400}(?:done|fixed|ready|complete|completion)|(?:skill:\/\/)?verify-before-done[\s\S]{0,400}(?:MUST|REQUIRED|mandatory|required)[\s\S]{0,400}(?:done|fixed|ready|complete|completion)/i,
		);
	});

	it("renders archive bundled skills and requires matching skill activation before work", async () => {
		const { skills } = await loadSkills({ cwd: tempDir });
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills,
			rules: [],
			toolNames: ["read"],
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		const text = systemPrompt.join("\n\n");
		const skillsBlockStart = text.indexOf("<skills>");
		const skillsBlockEnd = skillsBlockStart >= 0 ? text.indexOf("</skills>", skillsBlockStart) : -1;
		const skillsSection =
			skillsBlockStart >= 0
				? text.slice(skillsBlockStart, skillsBlockEnd >= 0 ? skillsBlockEnd + "</skills>".length : text.length)
				: "";
		const missingInSkillsSection = ARCHIVE_PROMPT_SKILL_NAMES.filter(name => !skillsSection.includes(`- ${name}:`));
		const activationContracts = {
			requiresReadingBeforeActing:
				/(?:MUST|REQUIRED|must|required)[\s\S]{0,260}(?:read|load|invoke|use)[\s\S]{0,180}(?:matching|relevant|listed|applicable)[\s\S]{0,140}skills?[\s\S]{0,260}(?:before|prior to)[\s\S]{0,180}(?:act|acting|work|respond|answer|implement)|(?:before|prior to)[\s\S]{0,180}(?:act|acting|work|respond|answer|implement)[\s\S]{0,260}(?:MUST|REQUIRED|must|required)[\s\S]{0,260}(?:read|load|invoke|use)[\s\S]{0,180}(?:matching|relevant|listed|applicable)[\s\S]{0,140}skills?/i.test(
					text,
				),
			requiresApplyingMatchingSkills:
				/(?:MUST|REQUIRED|must|required)[\s\S]{0,260}(?:apply|follow|use)[\s\S]{0,180}(?:matching|relevant|listed|applicable)[\s\S]{0,140}skills?|(?:apply|follow|use)[\s\S]{0,180}(?:matching|relevant|listed|applicable)[\s\S]{0,140}skills?[\s\S]{0,260}(?:MUST|REQUIRED|must|required)/i.test(
					text,
				),
		};

		expect({
			hasSkillsBlock: skillsSection !== "",
			missingInSkillsSection,
			activationContracts,
		}).toEqual({
			hasSkillsBlock: true,
			missingInSkillsSection: [],
			activationContracts: {
				requiresReadingBeforeActing: true,
				requiresApplyingMatchingSkills: true,
			},
		});
	});

	it("requires verify-before-done in independent QA gates when bundled skills and QA tooling are available", async () => {
		const { skills } = await loadSkills({ cwd: tempDir });
		const tools = new Map<string, SystemPromptToolMetadata>(TOOLS);
		tools.set("task", {
			label: "Task",
			description: "Runs subagents.",
			parameters: { type: "object", properties: { tasks: { type: "array" } } },
		});
		tools.set("browser_qa", {
			label: "Browser QA",
			description: "Runs browser QA.",
			parameters: { type: "object", properties: {} },
		});
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills,
			rules: [],
			toolNames: ["read", "bash", "task", "browser_qa"],
			tools,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: false,
			eagerTasks: true,
		});
		const text = systemPrompt.join("\n\n");

		expect(text).toMatch(/(?:independent QA|QA gate|QA handoff|handoff)/i);
		expect(text).toMatch(
			/(?:independent QA|QA gate|QA handoff|handoff)[\s\S]{0,700}(?:MUST|REQUIRED|mandatory|required|requires)[\s\S]{0,700}(?:skill:\/\/)?verify-before-done|(?:skill:\/\/)?verify-before-done[\s\S]{0,700}(?:MUST|REQUIRED|mandatory|required|requires)[\s\S]{0,700}(?:independent QA|QA gate|QA handoff|handoff)/i,
		);
	});

	it("autoloads frontend skill guidance that keeps internal feedback out of user UI copy", async () => {
		const { skills } = await loadSkills({ cwd: tempDir });
		const frontendSkill = skills.find(skill => skill.name === "frontend-design");
		expect(frontendSkill).toBeDefined();
		if (!frontendSkill) return;

		const { message } = await buildSkillPromptMessage(frontendSkill, "", "autoload");

		expect(message).toMatch(/No internal-note leakage in any rendered string/i);
		expect(message).toMatch(/frontend-ui-copy hard rule/i);
	});

	it("gates independent QA by lane and external observability", async () => {
		const text = await renderOrchestratorPrompt();

		expect(text).not.toContain("Completion claims REQUIRE the collected qa verdict");
		expect(text).toMatch(/Dispatch ONLY when at least one holds:[\s\S]{0,160}lane is L3/i);
		expect(text).toMatch(/externally observable[\s\S]{0,120}cannot exercise them yourself/i);
		expect(text).toMatch(/docs edit[\s\S]{0,160}policy violation/i);
	});

	it("renders work profiling, advisory interview, and done scorecard guidance", async () => {
		const text = await renderOrchestratorPrompt();

		expect(text).toContain("WORK PROFILE");
		expect(text).toMatch(/Codebase profile[\s\S]{0,200}measured, not vibed/i);
		expect(text).toMatch(/TEST POSTURE[\s\S]{0,240}TYPE SAFETY[\s\S]{0,240}GATES/i);
		expect(text).toMatch(/LEGACY-UNTESTED[\s\S]{0,220}characterization tests/i);
		expect(text).toContain("ADVISORY & INTERVIEW");
		expect(text).toMatch(/one batched round[\s\S]{0,120}max 4 questions/i);
		expect(text).toMatch(/Noticed:[\s\S]{0,240}file:symbol/i);
		expect(text).toContain("<done-scorecard>");
		expect(text).toMatch(/BUILD[\s\S]{0,240}GATES[\s\S]{0,240}TESTS/i);
		expect(text).toMatch(/done-scorecard is complete[\s\S]{0,120}NOT VERIFIED/i);
	});

	it("keeps work profile base guidance outside task-only delegation gates", async () => {
		const text = await render({ nativeTools: true, inlineToolDescriptors: false });

		expect(text).toContain("WORK PROFILE");
		expect(text).toContain("ADVISORY & INTERVIEW");
		expect(text).toContain("<done-scorecard>");
		expect(text).not.toContain("DELEGATION\n==========");
		expect(text.match(/<completeness>/g) ?? []).toHaveLength(1);
		expect(text.match(/<\/completeness>/g) ?? []).toHaveLength(1);
		expect(text.match(/<done-scorecard>/g) ?? []).toHaveLength(1);
		expect(text.match(/<\/done-scorecard>/g) ?? []).toHaveLength(1);
	});

	it("renders work profile tool references through toolRefs when available", async () => {
		const tools = new Map<string, SystemPromptToolMetadata>(TOOLS);
		tools.set("glob", {
			label: "Glob",
			description: "Globs files.",
			wireName: "repo_glob",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		});
		tools.set("lsp", {
			label: "LSP",
			description: "Queries language servers.",
			wireName: "code_lsp",
			parameters: { type: "object", properties: { method: { type: "string" } } },
		});

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "bash", "glob", "lsp"],
			tools,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: false,
		});
		const text = systemPrompt.join("\n\n");

		expect(text).toContain("`repo_glob` for test/spec files");
		expect(text).toContain("`code_lsp references`");
		expect(text).not.toContain("a references lookup on every symbol you will change");
	});

	it("renders execution harness rungs, recipes, and evidence format before execution", async () => {
		const text = await renderOrchestratorPrompt();
		const harnessStart = text.indexOf("EXECUTION HARNESS");
		expect(harnessStart).toBeGreaterThan(-1);
		expect(text.indexOf("EXECUTION\n=========", harnessStart)).toBeGreaterThan(harnessStart);
		const harness = text.slice(harnessStart, text.indexOf("EXECUTION\n=========", harnessStart));

		expect(harness).toMatch(/Evidence rungs[\s\S]{0,240}STATIC[\s\S]{0,240}DIRECT INVOCATION/i);
		expect(harness).toMatch(/ENTRY POINT[\s\S]{0,240}STATE & SIDE EFFECTS/i);
		expect(harness).toMatch(/Step 0[\s\S]{0,240}Manifest scripts[\s\S]{0,240}docker-compose/i);
		expect(harness).toMatch(/Recipe — HTTP API[\s\S]{0,1200}Authenticate like a real client/i);
		expect(harness).toMatch(/Anti-theater rules[\s\S]{0,240}Boot is not verification/i);
		expect(harness).toMatch(/Missing harness[\s\S]{0,1000}VERIFIED to rung N/i);
		expect(harness).toMatch(/Evidence format[\s\S]{0,240}RUNG 3\+4 — POST \/users/i);
	});

	it("keeps browser QA wording gated to task-capable prompts", async () => {
		const normalText = await render({ nativeTools: true, inlineToolDescriptors: false });
		const orchestratorText = await renderOrchestratorPrompt();

		expect(normalText).toContain("Run the dev server and drive the actual flow with browser/E2E tooling.");
		expect(normalText).not.toContain("browser_qa");
		expect(orchestratorText).toContain("browser/E2E tooling or dispatch `browser_qa`");
	});

	it("exempts non-behavioral L1 work from runtime harness rungs", async () => {
		const text = await renderOrchestratorPrompt();
		const harnessStart = text.indexOf("EXECUTION HARNESS");
		const harness = text.slice(harnessStart, text.indexOf("EXECUTION\n=========", harnessStart));

		expect(harness).toMatch(/BEHAVIOR=no L1 changes[\s\S]{0,160}do not require runtime rungs/i);
		expect(harness).toMatch(/targeted static\/render\/link gates/i);
	});

	it("uses eval guidance instead of inline interpreter scripts when eval is available", async () => {
		const tools = new Map<string, SystemPromptToolMetadata>(TOOLS);
		tools.set("eval", {
			label: "Eval",
			description: "Runs code cells.",
			wireName: "code_eval",
			parameters: { type: "object", properties: { language: { type: "string" } } },
		});

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "bash", "eval"],
			tools,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: false,
		});
		const text = systemPrompt.join("\n\n");

		expect(text).toContain("a `code_eval` cell for interpreter code");
		expect(text).not.toContain('python -c "from m import f; print(f(X))"');
		expect(text).not.toContain("`node -e`");
		expect(text).not.toContain("`npx tsx -e`");
	});

	it("routes design-team work to specialist agents before generic implementer tiers", async () => {
		const text = await renderOrchestratorPrompt();
		const selectionStart = text.indexOf("# Agent routing");
		expect(selectionStart).toBeGreaterThan(-1);
		const selectionEnd = text.indexOf("# Implementer tiers", selectionStart);
		expect(selectionEnd).toBeGreaterThan(selectionStart);
		const selection = text.slice(selectionStart, selectionEnd);

		expect(selection).toMatch(/(frontend|UI)[\s\S]{0,80}(implementation|implement|build)[\s\S]{0,120}`frontend_ui`/i);
		expect(selection).toMatch(/(UI|UX|design)[\s\S]{0,80}review[\s\S]{0,120}`ui_ux_reviewer`/i);
		expect(selection).toMatch(/(UX|UI)[\s\S]{0,80}(copy|copywriting|microcopy)[\s\S]{0,120}`ux_copywriter`/i);
		expect(selection).toMatch(/UI\/UX design[\s\S]{0,120}`designer`/i);

		const genericTierIndexes = ["`quick_task`", "`task`", "`heavy_task`"]
			.map(name => selection.indexOf(name))
			.filter(index => index >= 0);
		expect(genericTierIndexes.length).toBeGreaterThan(0);
		const firstGenericTier = Math.min(...genericTierIndexes);

		for (const specialist of ["`designer`", "`frontend_ui`", "`ui_ux_reviewer`", "`ux_copywriter`"]) {
			const specialistIndex = selection.indexOf(specialist);
			expect(specialistIndex).toBeGreaterThan(-1);
			expect(specialistIndex).toBeLessThan(firstGenericTier);
		}
		expect(text).not.toContain("Normal backend/frontend changes.");
		expect(text).not.toContain("frontend-design-system");
	});
});
