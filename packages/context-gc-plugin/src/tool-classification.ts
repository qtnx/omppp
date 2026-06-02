import type { ContextKind, ContextPolicy } from "./schema";

export interface ToolPolicy {
	readonly kind: ContextKind;
	readonly policy: ContextPolicy;
}

export interface ClassifyInput {
	readonly toolName: string;
	readonly input?: Record<string, unknown>;
}

export const KNOWN_TOOL_POLICIES: Readonly<Record<string, ToolPolicy>> = {
	read: { kind: "file_read", policy: "conservative" },
	bash: { kind: "bash_execution", policy: "conservative" },
	edit: { kind: "tool_result", policy: "pinned" },
	ast_grep: { kind: "tool_result", policy: "candidate" },
	ast_edit: { kind: "tool_result", policy: "pinned" },
	render_mermaid: { kind: "tool_result", policy: "candidate" },
	ask: { kind: "subagent_output", policy: "conservative" },
	debug: { kind: "tool_result", policy: "conservative" },
	eval: { kind: "python_execution", policy: "conservative" },
	ssh: { kind: "bash_execution", policy: "conservative" },
	github: { kind: "mcp_output", policy: "candidate" },
	find: { kind: "tool_result", policy: "candidate" },
	search: { kind: "tool_result", policy: "candidate" },
	lsp: { kind: "tool_result", policy: "candidate" },
	inspect_image: { kind: "browser_output", policy: "candidate" },
	browser: { kind: "browser_output", policy: "candidate" },
	checkpoint: { kind: "tool_result", policy: "candidate" },
	rewind: { kind: "tool_result", policy: "pinned" },
	task: { kind: "subagent_output", policy: "conservative" },
	workflow: { kind: "subagent_output", policy: "conservative" },
	job: { kind: "subagent_output", policy: "conservative" },
	irc: { kind: "tool_result", policy: "candidate" },
	todo_write: { kind: "tool_result", policy: "pinned" },
	web_search: { kind: "browser_output", policy: "candidate" },
	search_tool_bm25: { kind: "tool_result", policy: "candidate" },
	write: { kind: "tool_result", policy: "pinned" },
	memory_edit: { kind: "tool_result", policy: "pinned" },
	retain: { kind: "tool_result", policy: "candidate" },
	recall: { kind: "tool_result", policy: "candidate" },
	reflect: { kind: "tool_result", policy: "candidate" },
	yield: { kind: "tool_result", policy: "pinned" },
	report_finding: { kind: "tool_result", policy: "candidate" },
	report_tool_issue: { kind: "tool_result", policy: "candidate" },
	resolve: { kind: "tool_result", policy: "pinned" },
	goal: { kind: "subagent_output", policy: "conservative" },
	generate_image: { kind: "tool_result", policy: "candidate" },
	tts: { kind: "tool_result", policy: "candidate" },
	exa_search: { kind: "browser_output", policy: "candidate" },
	exa_search_code: { kind: "browser_output", policy: "candidate" },
	exa_crawl: { kind: "browser_output", policy: "candidate" },
	exa_linkedin: { kind: "browser_output", policy: "candidate" },
	exa_company: { kind: "browser_output", policy: "candidate" },
	exa_researcher_start: { kind: "browser_output", policy: "candidate" },
	exa_researcher_poll: { kind: "browser_output", policy: "candidate" },
	web_search_exa: { kind: "browser_output", policy: "candidate" },
	get_code_context_exa: { kind: "browser_output", policy: "candidate" },
	crawling_exa: { kind: "browser_output", policy: "candidate" },
	linkedin_search_exa: { kind: "browser_output", policy: "candidate" },
	company_research_exa: { kind: "browser_output", policy: "candidate" },
	deep_researcher_start: { kind: "browser_output", policy: "candidate" },
	deep_researcher_check: { kind: "browser_output", policy: "candidate" },
	webset_create: { kind: "browser_output", policy: "candidate" },
	webset_list: { kind: "browser_output", policy: "candidate" },
	webset_get: { kind: "browser_output", policy: "candidate" },
	webset_update: { kind: "browser_output", policy: "candidate" },
	webset_delete: { kind: "browser_output", policy: "candidate" },
	webset_items_list: { kind: "browser_output", policy: "candidate" },
	webset_item_get: { kind: "browser_output", policy: "candidate" },
	webset_search_create: { kind: "browser_output", policy: "candidate" },
	webset_search_get: { kind: "browser_output", policy: "candidate" },
	webset_search_cancel: { kind: "browser_output", policy: "candidate" },
	webset_enrichment_create: { kind: "browser_output", policy: "candidate" },
	webset_enrichment_get: { kind: "browser_output", policy: "candidate" },
	webset_enrichment_update: { kind: "browser_output", policy: "candidate" },
	webset_enrichment_delete: { kind: "browser_output", policy: "candidate" },
	webset_enrichment_cancel: { kind: "browser_output", policy: "candidate" },
	webset_monitor_create: { kind: "browser_output", policy: "candidate" },
	create_webset: { kind: "browser_output", policy: "candidate" },
	list_websets: { kind: "browser_output", policy: "candidate" },
	get_webset: { kind: "browser_output", policy: "candidate" },
	update_webset: { kind: "browser_output", policy: "candidate" },
	delete_webset: { kind: "browser_output", policy: "candidate" },
	list_webset_items: { kind: "browser_output", policy: "candidate" },
	get_item: { kind: "browser_output", policy: "candidate" },
	create_search: { kind: "browser_output", policy: "candidate" },
	get_search: { kind: "browser_output", policy: "candidate" },
	cancel_search: { kind: "browser_output", policy: "candidate" },
	create_enrichment: { kind: "browser_output", policy: "candidate" },
	get_enrichment: { kind: "browser_output", policy: "candidate" },
	update_enrichment: { kind: "browser_output", policy: "candidate" },
	delete_enrichment: { kind: "browser_output", policy: "candidate" },
	cancel_enrichment: { kind: "browser_output", policy: "candidate" },
	create_monitor: { kind: "browser_output", policy: "candidate" },
} as const satisfies Record<string, ToolPolicy>;

export function classifyContextSurface(input: ClassifyInput): ToolPolicy {
	const toolName = input.toolName.trim();
	if (toolName === "read" && isSkillRead(input.input)) {
		return { kind: "skill", policy: "conservative" };
	}
	if (toolName.startsWith("mcp__")) {
		return { kind: "mcp_output", policy: "candidate" };
	}
	return KNOWN_TOOL_POLICIES[toolName] ?? { kind: "custom_tool_output", policy: "candidate" };
}

function isSkillRead(input: Record<string, unknown> | undefined): boolean {
	const path = input?.path;
	return typeof path === "string" && path.startsWith("skill://");
}
