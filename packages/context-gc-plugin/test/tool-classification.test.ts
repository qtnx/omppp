import { describe, expect, test } from "bun:test";
import { classifyContextSurface, KNOWN_TOOL_POLICIES } from "../src/tool-classification";

const requiredTools = [
	"read",
	"bash",
	"edit",
	"ast_grep",
	"ast_edit",
	"render_mermaid",
	"ask",
	"debug",
	"eval",
	"ssh",
	"github",
	"find",
	"search",
	"lsp",
	"inspect_image",
	"browser",
	"checkpoint",
	"rewind",
	"task",
	"workflow",
	"job",
	"irc",
	"todo_write",
	"web_search",
	"search_tool_bm25",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"yield",
	"report_finding",
	"report_tool_issue",
	"resolve",
	"goal",
	"generate_image",
	"tts",
	"exa_search",
	"exa_search_code",
	"exa_crawl",
	"exa_linkedin",
	"exa_company",
	"exa_researcher_start",
	"exa_researcher_poll",
	"web_search_exa",
	"get_code_context_exa",
	"crawling_exa",
	"linkedin_search_exa",
	"company_research_exa",
	"deep_researcher_start",
	"deep_researcher_check",
	"webset_create",
	"webset_list",
	"webset_get",
	"webset_update",
	"webset_delete",
	"webset_items_list",
	"webset_item_get",
	"webset_search_create",
	"webset_search_get",
	"webset_search_cancel",
	"webset_enrichment_create",
	"webset_enrichment_get",
	"webset_enrichment_update",
	"webset_enrichment_delete",
	"webset_enrichment_cancel",
	"webset_monitor_create",
	"create_webset",
	"list_websets",
	"get_webset",
	"update_webset",
	"delete_webset",
	"list_webset_items",
	"get_item",
	"create_search",
	"get_search",
	"cancel_search",
	"create_enrichment",
	"get_enrichment",
	"update_enrichment",
	"delete_enrichment",
	"cancel_enrichment",
	"create_monitor",
] as const;

describe("classifyContextSurface", () => {
	test("covers every locked built-in and hidden tool with an explicit policy", () => {
		for (const toolName of requiredTools) {
			expect(KNOWN_TOOL_POLICIES[toolName], toolName).toBeDefined();
			expect(classifyContextSurface({ toolName })).toEqual(KNOWN_TOOL_POLICIES[toolName]);
		}
	});

	test("classifies dynamic MCP tools as MCP output", () => {
		expect(classifyContextSurface({ toolName: "mcp__github__search_issues" })).toEqual({
			kind: "mcp_output",
			policy: "candidate",
		});
	});

	test("classifies skill URI reads as skills instead of normal file reads", () => {
		expect(classifyContextSurface({ toolName: "read", input: { path: "skill://typescript-pro/SKILL.md" } })).toEqual({
			kind: "skill",
			policy: "conservative",
		});
	});

	test("classifies unknown tools as unloadable custom tool output", () => {
		expect(classifyContextSurface({ toolName: "company_internal_dump" })).toEqual({
			kind: "custom_tool_output",
			policy: "candidate",
		});
	});
});
