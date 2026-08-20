export const BUILTIN_TOOL_NAMES = [
	"orchestrator_mode",
	"duo_handoff",
	"duo_escalate",
	"read",
	"bash",
	"launch",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"eval",
	"ssh",
	"github",
	"glob",
	"grep",
	"lsp",
	"codegraph_init",
	"codegraph_index",
	"codegraph_explore",
	"kanban",
	"inspect_image",
	"browser",
	"computer",
	"checkpoint",
	"rewind",
	"compact",
	"shake",
	"workflow",
	"security_scan",
	"task",
	"hub",
	"job",
	"loop",
	"irc",
	"todo",
	"secrets",
	"web_search",
	"search_tool_bm25",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
	"consult",
	"super_review",
	"present",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/** Hidden built-ins: constructible and `--tools`-addressable, but never part of the default active set. */
export const HIDDEN_TOOL_NAMES = [
	"yield",
	"report_finding",
	"report_tool_issue",
	"resolve",
	"goal",
	"get_goal",
	"create_goal",
	"update_goal",
	"think",
] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([
	["search", "grep"],
	["find", "glob"],
]);

const CANONICAL_TOOL_NAMES: Record<string, true> = Object.fromEntries(
	[...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map(name => [name, true]),
);

/** Canonicalize built-in IDs and legacy aliases. Leave plugin names unchanged. */
export function normalizeToolName(name: string): string {
	const lower = name.toLowerCase();
	return LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(lower) ?? (Object.hasOwn(CANONICAL_TOOL_NAMES, lower) ? lower : name);
}

/** Normalize and deduplicate tool names while preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}
