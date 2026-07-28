import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSystemPrompt as buildSdkSystemPrompt } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	buildSystemPrompt,
	buildSystemPromptToolMetadata,
	DEFAULT_SYSTEM_PROMPT_TOOL_NAMES,
	projectSystemPromptToolMetadata,
	type SystemPromptToolMetadata,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
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

const DIRECT_WEB_SEARCH: SystemPromptToolMetadata = {
	label: "Direct Web",
	description: "Provider-callable direct search.",
	parameters: { type: "object", properties: {} },
};

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
interface MetadataGetterCounts {
	label: number;
	wireName: number;
	description: number;
	parameters: number;
	examples: number;
}

function emptyMetadataGetterCounts(): MetadataGetterCounts {
	return { label: 0, wireName: 0, description: 0, parameters: 0, examples: 0 };
}

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

	function executionHarnessFrom(text: string): string {
		const harnessStart = text.indexOf("EXECUTION HARNESS");
		expect(harnessStart).toBeGreaterThan(-1);
		const executionStart = text.indexOf("EXECUTION\n=========", harnessStart);
		expect(executionStart).toBeGreaterThan(harnessStart);
		return text.slice(harnessStart, executionStart);
	}

	function reportSectionFrom(text: string): string {
		expect(text.match(/^<report>$/gm) ?? []).toHaveLength(1);
		expect(text.match(/^<\/report>$/gm) ?? []).toHaveLength(1);
		const reportStart = /^<report>$/m.exec(text)?.index ?? -1;
		const reportEnd = /^<\/report>$/m.exec(text)?.index ?? -1;
		expect(reportStart).toBeGreaterThan(-1);
		expect(reportEnd).toBeGreaterThan(reportStart);
		return text.slice(reportStart, reportEnd + "</report>".length);
	}

	async function renderMountedWebSearch(opts: {
		nativeTools: boolean;
		directDefinition: boolean;
	}): Promise<{ text: string; inventory: string }> {
		const tools = new Map(TOOLS);
		if (opts.directDefinition) tools.set("web_search", DIRECT_WEB_SEARCH);
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "web_search"],
			tools,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: opts.nativeTools,
			inlineToolDescriptors: false,
			xdevTools: [{ name: "web_search", summary: "Searches the web." }],
			xdevDocs: "Mounted web search documentation.",
		});
		const text = systemPrompt.join("\n\n");
		return { text, inventory: opts.nativeTools ? inventoryFrom(text) : text };
	}

	function makeToolSession(settings: Settings): ToolSession {
		return {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		} as ToolSession;
	}

	it("preserves the one-argument full metadata builder", () => {
		const metadata = buildSystemPromptToolMetadata(new Map([[SDK_TOOL.name, SDK_TOOL]]));

		expect(Array.from(metadata.keys())).toEqual(["sdk_custom"]);
		expect(metadata.get("sdk_custom")).toMatchObject({
			label: "SDK Custom",
			description: "SDK-provided custom tool.",
			parameters: { type: "object", properties: {} },
		});
	});

	it("preserves the legacy metadata overrides map", () => {
		const metadata = buildSystemPromptToolMetadata(new Map([[SDK_TOOL.name, SDK_TOOL]]), {
			sdk_custom: {
				label: "Overridden label",
				description: "Overridden description.",
				wireName: "sdk_custom_wire",
			},
		});

		expect(metadata.get("sdk_custom")).toMatchObject({
			label: "Overridden label",
			description: "Overridden description.",
			parameters: { type: "object", properties: {} },
			wireName: "sdk_custom_wire",
		});
	});

	it("snapshots every full metadata getter once per rebuild and keeps fresh values", async () => {
		let revision = 1;
		const reads = new Map<string, MetadataGetterCounts>();
		const makeTool = (name: string): Tool => {
			const counts = emptyMetadataGetterCounts();
			reads.set(name, counts);
			return {
				name,
				approval: "read",
				get label() {
					counts.label += 1;
					return `${name} label r${revision}`;
				},
				get customWireName() {
					counts.wireName += 1;
					return `${name}_wire_r${revision}`;
				},
				get description() {
					counts.description += 1;
					return `${name} description r${revision}`;
				},
				get parameters() {
					counts.parameters += 1;
					return {
						type: "object",
						properties: { [`arg_r${revision}`]: { type: "string" } },
						required: [`arg_r${revision}`],
					};
				},
				get examples() {
					counts.examples += 1;
					return [{ caption: `${name} example r${revision}`, note: `note r${revision}` }];
				},
				async execute() {
					return { content: [{ type: "text", text: "ok" }] };
				},
			};
		};
		const tools = new Map<string, Tool>([
			["read", makeTool("read")],
			["edit", makeTool("edit")],
		]);

		const first = projectSystemPromptToolMetadata(tools, { mode: "full" });
		expect(Array.from(first.keys())).toEqual(["read", "edit"]);
		expect(first.get("edit")).toEqual({
			label: "edit label r1",
			description: "edit description r1",
			parameters: {
				type: "object",
				properties: { arg_r1: { type: "string" } },
				required: ["arg_r1"],
			},
			examples: [{ caption: "edit example r1", note: "note r1" }],
			wireName: "edit_wire_r1",
		});
		expect(Array.from(reads.values())).toEqual([
			{ label: 1, wireName: 1, description: 1, parameters: 1, examples: 1 },
			{ label: 1, wireName: 1, description: 1, parameters: 1, examples: 1 },
		]);

		const firstPrompt = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["edit", "read"],
			tools: first,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: false,
			inlineToolDescriptors: false,
		});
		const firstText = firstPrompt.systemPrompt.join("\n\n");
		expect(firstText.indexOf("# Tool: edit_wire_r1")).toBeLessThan(firstText.indexOf("# Tool: read_wire_r1"));
		expect(firstText).toContain("edit description r1");
		expect(firstText).toContain("arg_r1: string;");

		revision = 2;
		const second = projectSystemPromptToolMetadata(tools, { mode: "full" });
		expect(second.get("edit")?.description).toBe("edit description r2");
		expect(second.get("edit")?.wireName).toBe("edit_wire_r2");
		expect(first.get("edit")?.description).toBe("edit description r1");
		expect(Array.from(reads.values())).toEqual([
			{ label: 2, wireName: 2, description: 2, parameters: 2, examples: 2 },
			{ label: 2, wireName: 2, description: 2, parameters: 2, examples: 2 },
		]);

		const secondPrompt = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["edit", "read"],
			tools: second,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: false,
			inlineToolDescriptors: false,
		});
		const secondText = secondPrompt.systemPrompt.join("\n\n");
		expect(secondText.indexOf("# Tool: edit_wire_r2")).toBeLessThan(secondText.indexOf("# Tool: read_wire_r2"));
		expect(secondText).toContain("edit description r2");
		expect(secondText).toContain("arg_r2: string;");
		expect(secondText).not.toContain("edit description r1");
	});

	it("projects compact metadata in active order without reading descriptors or inactive tools", async () => {
		const reads = new Map<string, MetadataGetterCounts>();
		const makeTool = (name: string, label: string, wireName?: string): Tool => {
			const counts = emptyMetadataGetterCounts();
			reads.set(name, counts);
			return {
				name,
				approval: "read",
				get label() {
					counts.label += 1;
					return label;
				},
				get customWireName() {
					counts.wireName += 1;
					return wireName;
				},
				get description(): string {
					counts.description += 1;
					throw new Error(`${name} description getter was read`);
				},
				get parameters(): Tool["parameters"] {
					counts.parameters += 1;
					throw new Error(`${name} parameters getter was read`);
				},
				get examples(): Tool["examples"] {
					counts.examples += 1;
					throw new Error(`${name} examples getter was read`);
				},
				async execute() {
					return { content: [{ type: "text", text: "ok" }] };
				},
			};
		};
		const tools = new Map<string, Tool>([
			["inactive", makeTool("inactive", "Inactive")],
			["read", makeTool("read", "Read")],
			["edit", makeTool("edit", "Edit", "apply_patch")],
		]);

		const metadata = projectSystemPromptToolMetadata(tools, {
			mode: "compact",
			toolNames: ["edit", "read"],
		});
		expect(Array.from(metadata.keys())).toEqual(["edit", "read"]);
		expect(metadata.get("edit")).toMatchObject({ label: "Edit", wireName: "apply_patch" });
		expect(metadata.get("read")).toMatchObject({ label: "Read" });
		expect(reads.get("inactive")).toEqual(emptyMetadataGetterCounts());
		expect(reads.get("edit")).toEqual({
			label: 1,
			wireName: 1,
			description: 0,
			parameters: 0,
			examples: 0,
		});
		expect(reads.get("read")).toEqual({
			label: 1,
			wireName: 1,
			description: 0,
			parameters: 0,
			examples: 0,
		});

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["edit", "read"],
			tools: metadata,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: false,
		});
		expect(inventoryFrom(systemPrompt.join("\n\n")).trim()).toBe(
			"# Tool Inventory\n- Edit: `apply_patch`\n- Read: `read`",
		);
	});

	it("does not construct descriptor records for a compact native inventory", async () => {
		const reads = new Map<string, MetadataGetterCounts>();
		const makeMetadata = (name: string, label: string, wireName?: string): SystemPromptToolMetadata => {
			const counts = emptyMetadataGetterCounts();
			reads.set(name, counts);
			return {
				get label() {
					counts.label += 1;
					return label;
				},
				get wireName() {
					counts.wireName += 1;
					return wireName;
				},
				get description(): string {
					counts.description += 1;
					throw new Error(`${name} description getter was read`);
				},
				get parameters(): SystemPromptToolMetadata["parameters"] {
					counts.parameters += 1;
					throw new Error(`${name} parameters getter was read`);
				},
				get examples(): SystemPromptToolMetadata["examples"] {
					counts.examples += 1;
					throw new Error(`${name} examples getter was read`);
				},
			};
		};
		const metadata = new Map<string, SystemPromptToolMetadata>([
			["read", makeMetadata("read", "Read")],
			["edit", makeMetadata("edit", "Edit", "apply_patch")],
		]);

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["edit", "read"],
			tools: metadata,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: false,
		});
		expect(inventoryFrom(systemPrompt.join("\n\n")).trim()).toBe(
			"# Tool Inventory\n- Edit: `apply_patch`\n- Read: `read`",
		);
		expect(Array.from(reads.values())).toEqual([
			{ label: 1, wireName: 1, description: 0, parameters: 0, examples: 0 },
			{ label: 1, wireName: 1, description: 0, parameters: 0, examples: 0 },
		]);
	});

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

	it("keeps enabled computer routing explicit in compact native-tool mode", async () => {
		const tools = new Map(TOOLS);
		tools.set("computer", {
			label: "Computer",
			description: "Controls the host desktop.",
			parameters: { type: "object", properties: {} },
		});
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "computer"],
			tools,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: false,
		});
		const text = systemPrompt.join("\n\n");
		expect(text).toContain("# Computer Use");
		expect(text).toContain("The `computer` tool is explicitly enabled and available");
		expect(text).toContain("MUST use `computer` for requests to view or control host desktop applications");
		expect(text).toContain("NEVER claim Computer Use is unavailable");
		expect(text).toContain("Inspect the fresh screenshot returned by every successful `computer` call");
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

	it.each([
		["compact", true],
		["inline", false],
	] as const)("omits xd-only tools from the %s inventory", async (_mode, nativeTools) => {
		const { text, inventory } = await renderMountedWebSearch({ nativeTools, directDefinition: false });

		expect(inventory).toContain(nativeTools ? "`read`" : "# Tool: read");
		expect(inventory).not.toContain(nativeTools ? "`web_search`" : "# Tool: web_search");
		expect(text).toContain("# xd:// Tool Devices");
		expect(text).toContain("Mounted web search documentation.");
	});

	it.each([
		["compact", true],
		["inline", false],
	] as const)("keeps direct tools that share an xd device name in the %s inventory", async (_mode, nativeTools) => {
		const { inventory } = await renderMountedWebSearch({ nativeTools, directDefinition: true });

		expect(inventory).toContain(nativeTools ? "- Direct Web: `web_search`" : "# Tool: web_search");
		if (!nativeTools) expect(inventory).toContain(DIRECT_WEB_SEARCH.description);
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
		expect(inventory).not.toContain("- `eval`");
	});

	it("omits eval prompt guidance when every eval backend is disabled", async () => {
		const settings = Settings.isolated({
			"eval.py": false,
			"eval.js": false,
			"eval.rb": false,
			"eval.jl": false,
		});
		const session = makeToolSession(settings);
		const tools = await createTools(session, ["bash", "eval"]);
		const toolNames = tools.map(tool => tool.name);
		const bash = tools.find(tool => tool.name === "bash");

		expect(toolNames).toContain("bash");
		expect(toolNames).not.toContain("eval");
		expect(bash?.description).toContain("purpose-built tool");
		expect(bash?.description).not.toContain("eval` cell");
		expect(bash?.description).not.toContain("use `eval` cells");
		expect(bash?.description).not.toContain("Prefer `eval`");
		expect(bash?.description).not.toContain("`grep` tool");
		expect(bash?.description).not.toContain("`ls` → `read`");
		expect(bash?.description).not.toContain("`find` → the `glob` tool");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames,
			tools: buildSystemPromptToolMetadata(new Map(tools.map(tool => [tool.name, tool]))),
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			nativeTools: true,
			inlineToolDescriptors: true,
		});
		const text = systemPrompt.join("\n\n");

		expect(text).not.toContain("Default for any compute");
		expect(text).not.toContain("use `eval` cells");
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

	it("renders super_review critique and debate guidance in the normal prompt", async () => {
		const text = await render({ nativeTools: true, inlineToolDescriptors: false });
		const exactPricePattern = /(?:~?\$1\/(?:call|task)|~?\$5\/call)/;
		const superReviewGuidance = text.match(/`super_review`[\s\S]{0,2000}/)?.[0] ?? "";
		const superReviewPolicyViolations: string[] = [];

		if (!superReviewGuidance) {
			superReviewPolicyViolations.push("missing `super_review` guidance");
		}
		if (exactPricePattern.test(text)) {
			superReviewPolicyViolations.push("mentions exact super_review price/cost strings");
		}
		if (!/(?:final|locked)[\s\S]{0,80}plan[\s\S]{0,120}before[\s\S]{0,80}implementation/i.test(superReviewGuidance)) {
			superReviewPolicyViolations.push("missing final or locked plan review before implementation");
		}
		if (!/before[\s\S]{0,80}QA[\s\S]{0,80}(?:strategy|execution)/i.test(superReviewGuidance)) {
			superReviewPolicyViolations.push("missing QA strategy or execution review checkpoint");
		}
		if (!/before[\s\S]{0,80}(?:claiming|yielding)[\s\S]{0,120}(?:done|completion)/i.test(superReviewGuidance)) {
			superReviewPolicyViolations.push("missing done or completion evidence checkpoint");
		}
		if (
			!/(?=[\s\S]*(?:business|product|market))(?=[\s\S]*(?:strategy|review))(?=[\s\S]*\b(?:AC|acceptance criteria)\b)(?=[\s\S]*(?:\bcases\b[\s\S]{0,120}\bedge cases\b|\bedge cases\b[\s\S]{0,120}\bcases\b))/i.test(
				superReviewGuidance,
			)
		) {
			superReviewPolicyViolations.push(
				"missing business/product/market strategy review with AC, cases, and edge cases",
			);
		}
		if (
			!/brainstorm(?:ing)?[\s\S]{0,120}(?:options|approaches|choices)|(?:options|approaches|choices)[\s\S]{0,120}brainstorm(?:ing)?/i.test(
				superReviewGuidance,
			)
		) {
			superReviewPolicyViolations.push("missing brainstorming options guidance");
		}
		if (
			!/(?=[\s\S]*adversarial)(?=[\s\S]*(?:review|debate))(?=[\s\S]*(?:solution|choice|choices|approach|option))/i.test(
				superReviewGuidance,
			)
		) {
			superReviewPolicyViolations.push("missing adversarial review or debate of solution choices");
		}
		if (
			!/(?=[\s\S]*(?:compact|concise|lean)[\s\S]{0,120}(?:summary|context))(?=[\s\S]*(?:decision|options?|choices?)[\s\S]{0,120}(?:debate|review|decide|choose))(?=[\s\S]*constraints?)(?=[\s\S]*evidence)(?=[\s\S]*focused[\s\S]{0,80}questions?)/i.test(
				superReviewGuidance,
			)
		) {
			superReviewPolicyViolations.push(
				"missing lean context requirements: summary, decision/options, constraints/evidence, and focused questions",
			);
		}
		if (
			!/(?:avoid|do not|don't|unless|only)[\s\S]{0,180}(?:raw|full)[\s\S]{0,100}(?:context|history|file)[\s\S]{0,100}dumps?[\s\S]{0,180}(?:exact bytes|bytes matter)|(?:exact bytes|bytes matter)[\s\S]{0,180}(?:raw|full)[\s\S]{0,100}(?:context|history|file)[\s\S]{0,100}dumps?/i.test(
				superReviewGuidance,
			)
		) {
			superReviewPolicyViolations.push("missing raw context/history/file dump warning unless exact bytes matter");
		}

		expect(superReviewPolicyViolations).toEqual([]);
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

	it("renders concise report guidance", async () => {
		const text = await renderOrchestratorPrompt();
		const report = reportSectionFrom(text);

		expect(report).toMatch(/Lead with outcome[\s\S]{0,80}1-3 sentences/i);
		expect(report).toMatch(/Default final report\s*<=10 human prose lines/i);
		expect(report).toMatch(
			/NEVER restate the task[\s\S]{0,120}narrate process[\s\S]{0,120}preamble[\s\S]{0,120}ceremony[\s\S]{0,120}mechanical headers/i,
		);
		expect(report).toMatch(/Evidence bullets:\s*`command\/check -> decisive output`/i);
		expect(report).toMatch(
			/NEVER mention internal skill[\s\S]{0,80}rule[\s\S]{0,80}tool[\s\S]{0,80}prompt mechanics/i,
		);
		expect(text).not.toContain("Yield with `Self-verified:");
		expect(text).not.toContain("yield with `Self-verified: <gates>`");
		expect(report).toMatch(/All gates verified\?[\s\S]{0,80}Collapse scorecard to one line/i);
		expect(report).toMatch(
			/Expand ONLY caveats[\s\S]{0,80}action-needed[\s\S]{0,80}blockers[\s\S]{0,80}NOT VERIFIED/i,
		);
		expect(report).toMatch(
			/ASCII tables\/diagrams[\s\S]{0,80}replace prose[\s\S]{0,80}<=12 lines[\s\S]{0,80}<=80 cols[\s\S]{0,80}no decoration/i,
		);
		expect(report).toMatch(/two competent devs talking[\s\S]{0,80}direct[\s\S]{0,80}concrete/i);
		expect(report).toMatch(
			/Good report:[\s\S]{0,500}\| path\s+\|\s+result \|[\s\S]{0,120}\|[-\s]+\|[-\s]+\|[\s\S]{0,220}\| valid refresh\s+\|\s+200\s+\|/i,
		);
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

	it("classifies coding-agent prompt configuration as behavioral and requires installed ompx evidence", async () => {
		const text = await renderOrchestratorPrompt();
		const harness = executionHarnessFrom(text);

		expect(text).toMatch(
			/Executable configuration exception:[\s\S]{0,260}packages\/coding-agent\/src[\s\S]{0,260}(?:system\/agent prompts|tool definitions|model routing|orchestrator\/duo\/advisor|workers|TUI)[\s\S]{0,80}YES/i,
		);
		expect(harness).toMatch(
			/Prompt\/tool\/agent\/routing\/orchestrator\/TUI changes under `packages\/coding-agent\/src` require this installed-entrypoint evidence/i,
		);
	});

	it("requires production-equivalent installed ompx for CLI and agent rung 3 evidence", async () => {
		const harness = executionHarnessFrom(await renderOrchestratorPrompt());

		expect(harness).toMatch(
			/Recipe — CLI \(rung 3\)[\s\S]{0,360}PRODUCTION-EQUIVALENT entrypoint[\s\S]{0,180}clean shell outside the repo[\s\S]{0,180}build\/package[\s\S]{0,180}install into a clean prefix[\s\S]{0,180}installed `ompx`\/published bin/i,
		);
		expect(harness).toMatch(
			/Dev-tree invocations[\s\S]{0,220}`node dist\/cli\.js`[\s\S]{0,160}`tsx src`[\s\S]{0,160}workspace links[\s\S]{0,160}`bun link`[\s\S]{0,160}below rung 3/i,
		);
		expect(harness).toMatch(/`--help`\/`--version`[\s\S]{0,140}smoke only[\s\S]{0,140}not verification/i);
		expect(harness).toMatch(
			/Recipe — TUI \/ interactive agent \(rung 3\)[\s\S]{0,260}installed `ompx`[\s\S]{0,260}changed path/i,
		);
	});

	it("requires changed-path evidence that is revert-sensitive, not adjacent smoke output", async () => {
		const harness = executionHarnessFrom(await renderOrchestratorPrompt());

		expect(harness).toMatch(/BANNED:[\s\S]{0,220}changed path[\s\S]{0,220}adjacent output/i);
		expect(harness).toMatch(/revert-sensitive:[\s\S]{0,180}reverting the diff[\s\S]{0,180}asserted output\/state/i);
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

		expect(selection).toMatch(
			/small[\s\S]{0,80}normal[- ]mode[\s\S]{0,80}L1[\s\S]{0,80}(?:frontend|UI)[\s\S]{0,160}(?:main[\s\S]{0,60}direct|direct[\s\S]{0,60}main)/i,
		);
		expect(selection).toMatch(
			/larger[\s\S]{0,120}(?:frontend|UI)[\s\S]{0,160}exactly one[\s\S]{0,120}`(?:designer|frontend_ui)`[\s\S]{0,200}(?:direction|scoped implementation)/i,
		);
		expect(selection).toMatch(
			/(?:design direction[\s\S]{0,120}`designer`[\s\S]{0,160}scoped implementation[\s\S]{0,120}`frontend_ui`|scoped implementation[\s\S]{0,120}`frontend_ui`[\s\S]{0,160}design direction[\s\S]{0,120}`designer`)/i,
		);
		expect(selection).toMatch(
			/(?:one|single)[\s\S]{0,100}`ui_ux_reviewer`[\s\S]{0,160}(?:final integration|integration final)|(?:final integration|integration final)[\s\S]{0,160}(?:one|single)[\s\S]{0,100}`ui_ux_reviewer`/i,
		);
		expect(selection).not.toMatch(/`designer`\s*\+\s*`frontend_ui`/);
		expect(selection).not.toMatch(/two independent\s+`ui_ux_reviewer`\s+passes/i);

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
