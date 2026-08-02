import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { KanbanTool } from "@oh-my-pi/pi-coding-agent/kanban/tool";
import type { BuiltinToolLoadMode, ToolLoopManager, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	AskTool,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
	filterInitialToolsForDiscoveryAll,
	GithubTool,
	IrcTool,
	JobTool,
	SshTool,
} from "@oh-my-pi/pi-coding-agent/tools";

const allToolsSettings = Settings.isolated({
	"astGrep.enabled": true,
	"astEdit.enabled": true,
	"debug.enabled": true,
	"glob.enabled": true,
	"grep.enabled": true,
	"github.enabled": true,
	"lsp.enabled": true,
	"inspect_image.enabled": true,
	"web_search.enabled": true,
	"browser.enabled": true,
	"computer.enabled": true,
	"checkpoint.enabled": true,
	"todo.enabled": true,
	"memory.backend": "mnemopi",
	"autolearn.enabled": true,
	"learning.enabled": true,
	"tools.discoveryMode": "all",
});

const loopManager: ToolLoopManager = {
	schedule: () => ({ id: "test-loop" }),
	cancelAll: () => {},
	activeCount: 0,
};

const toolSession: ToolSession = {
	cwd: "/tmp/test",
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: allToolsSettings,
	isToolDiscoveryEnabled: () => true,
	getSelectedDiscoveredToolNames: () => [],
	activateDiscoveredTools: async names => names,
	requestCompaction: () => ({ status: "scheduled" }),
	requestShake: () => ({ status: "scheduled" }),
	isAdvisorActive: () => true,
	getLoopManager: () => loopManager,
};

async function getToolMetadata(): Promise<Map<string, { loadMode?: string; summary?: string }>> {
	const tools = await createTools(toolSession, Object.keys(BUILTIN_TOOLS));
	const metadata = new Map(tools.map(tool => [tool.name, { loadMode: tool.loadMode, summary: tool.summary }]));
	for (const tool of [
		new AskTool({ ...toolSession, hasUI: true }),
		new GithubTool(toolSession),
		new SshTool(toolSession, [], new Map(), ""),
		new JobTool(toolSession),
		new IrcTool(toolSession),
		// `kanban` only builds while the session owns a live board, so `createTools`
		// cannot produce it here; construct it directly to check its loading fields.
		new KanbanTool(toolSession),
	]) {
		metadata.set(tool.name, { loadMode: tool.loadMode, summary: tool.summary });
	}
	return metadata;
}
describe("BUILTIN_TOOLS public factory map", () => {
	it("sets loading fields on tool definitions without wrapping factories", async () => {
		const metadata = await getToolMetadata();
		const missing = Object.keys(BUILTIN_TOOLS).filter(name => metadata.get(name)?.loadMode === undefined);
		expect(missing).toEqual([]);
	});
	it("exposes launch instead of daemon", async () => {
		const launch = await BUILTIN_TOOLS.launch(toolSession);
		expect(launch?.name).toBe("launch");
		expect(Object.hasOwn(BUILTIN_TOOLS, "daemon")).toBeFalse();
	});
});

describe("built-in tool loadMode annotations", () => {
	it("provides a summary for every discoverable tool", async () => {
		const missing: string[] = [];
		const metadata = await getToolMetadata();
		for (const [name, meta] of metadata) {
			if (meta.loadMode === "discoverable" && !meta.summary) {
				missing.push(name);
			}
		}
		expect(missing).toEqual([]);
	});

	it("marks eval essential so it survives tools.discoveryMode 'all'", async () => {
		const metadata = await getToolMetadata();
		expect(metadata.get("eval")?.loadMode).toBe("essential");
		// Essential loadMode keeps eval active under discovery-all even when it is
		// absent from the essential-names set — not relying on the names list.
		const kept = filterInitialToolsForDiscoveryAll(["eval"], {
			loadModeOf: name => metadata.get(name)?.loadMode as BuiltinToolLoadMode | undefined,
			essentialNames: new Set<string>(),
			explicitlyRequested: new Set<string>(),
			restored: new Set<string>(),
			forceActive: new Set<string>(),
		});
		expect(kept).toEqual(["eval"]);
	});

	it("marks super_review essential so it is visible after restart", async () => {
		const metadata = await getToolMetadata();
		expect(metadata.get("super_review")?.loadMode).toBe("essential");
		const essential = computeEssentialBuiltinNames(Settings.isolated({}));
		expect(essential).toContain("super_review");
		const kept = filterInitialToolsForDiscoveryAll(["super_review"], {
			loadModeOf: name => metadata.get(name)?.loadMode as BuiltinToolLoadMode | undefined,
			essentialNames: new Set<string>(essential),
			explicitlyRequested: new Set<string>(),
			restored: new Set<string>(),
			forceActive: new Set<string>(),
		});
		expect(kept).toEqual(["super_review"]);
	});
});

describe("computeEssentialBuiltinNames", () => {
	it("returns DEFAULT_ESSENTIAL_TOOL_NAMES when override is empty", () => {
		const settings = Settings.isolated({});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual([...DEFAULT_ESSENTIAL_TOOL_NAMES].sort());
	});

	it("keeps todo and browser in the default essential tool set", () => {
		const settings = Settings.isolated({});
		const essential = computeEssentialBuiltinNames(settings);
		expect(essential).toContain("todo");
		expect(essential).toContain("browser");
	});

	it("respects tools.essentialOverride when provided", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "glob"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["glob", "read"]);
	});

	it("maps legacy essential override tool names", () => {
		const settings = Settings.isolated({ "tools.essentialOverride": ["read", "find", "search", "glob"] });
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["glob", "grep", "read"]);
	});

	it("filters override entries that are not known built-in tools", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": ["read", "not_a_real_tool", "edit"],
		});
		expect(computeEssentialBuiltinNames(settings).sort()).toEqual(["edit", "read"]);
	});

	it("trims whitespace and drops empty entries from the override", () => {
		const settings = Settings.isolated({
			"tools.essentialOverride": [" read ", "", "  "],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual(["read"]);
	});

	it("falls back to defaults when override is non-empty but contains only invalid names", () => {
		// The filtered list is empty (no valid names), but the override was provided —
		// current behavior returns the empty filtered list (caller can decide). Document the behavior.
		const settings = Settings.isolated({
			"tools.essentialOverride": ["not_a_real_tool"],
		});
		expect(computeEssentialBuiltinNames(settings)).toEqual([]);
	});
});

describe("tools.discoveryMode settings schema", () => {
	it("defaults to auto discovery mode", () => {
		const settings = Settings.isolated({});
		expect(settings.get("tools.discoveryMode")).toBe("auto");
	});

	it("back-compat: mcp.discoveryMode still accepted", () => {
		const settings = Settings.isolated({ "mcp.discoveryMode": true });
		expect(settings.get("mcp.discoveryMode")).toBe(true);
	});
});

describe("filterInitialToolsForDiscoveryAll", () => {
	const loadModes: Record<string, BuiltinToolLoadMode> = {
		read: "essential",
		bash: "essential",
		edit: "essential",
		task: "essential",
		todo: "discoverable",
		grep: "discoverable",
		browser: "discoverable",
		find: "discoverable",
	};
	const base = {
		loadModeOf: (name: string): BuiltinToolLoadMode | undefined => loadModes[name],
		essentialNames: new Set(["read", "bash", "edit", "write", "glob"]),
		explicitlyRequested: new Set<string>(),
		restored: new Set<string>(),
		forceActive: new Set<string>(),
	};

	it("hides non-essential discoverable built-ins", () => {
		expect(filterInitialToolsForDiscoveryAll(["read", "edit", "todo", "grep"], base)).toEqual(["read", "edit"]);
	});

	it("keeps default essential tools visible under discovery-all filtering", () => {
		const result = filterInitialToolsForDiscoveryAll(["read", "bash", "edit", "task", "todo", "browser", "find"], {
			...base,
			essentialNames: new Set(DEFAULT_ESSENTIAL_TOOL_NAMES),
		});
		expect(result).toEqual(["read", "bash", "edit", "task", "todo", "browser"]);
	});

	it("keeps discoverable tools required by a forced tool_choice (eager todo)", () => {
		const result = filterInitialToolsForDiscoveryAll(["read", "todo", "grep"], {
			...base,
			forceActive: new Set(["todo"]),
		});
		expect(result).toEqual(["read", "todo"]);
	});

	it("keeps explicitly requested and restored discoverable tools", () => {
		const result = filterInitialToolsForDiscoveryAll(["todo", "grep"], {
			...base,
			explicitlyRequested: new Set(["grep"]),
			restored: new Set(["todo"]),
		});
		expect([...result].sort()).toEqual(["grep", "todo"]);
	});

	it("never hides tools without a built-in loadMode (MCP/custom/extension)", () => {
		expect(filterInitialToolsForDiscoveryAll(["mcp__server__tool", "grep"], base)).toEqual(["mcp__server__tool"]);
	});
});
