import { prompt } from "@oh-my-pi/pi-utils";
import workflowNoticeTemplate from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse, maskNonProse } from "./markdown-prose";

/**
 * "workflow" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a warm
 * amber→green gradient ({@link highlightWorkflow}). Broad lowercase prose
 * detection is kept for highlighting compatibility; hidden workflow steering
 * requires explicit directive intent via {@link requestsWorkflow}.
 * Code paths, code spans, and file extensions do not trigger either path.
 */

// Broad lowercase prose detection for highlighting compatibility, including
// legacy forms such as "workflowz". It is deliberately not an action signal.
const WORKFLOW_WORD = /(?<![/.])workflow(?!\.[A-Za-z0-9])/;

const WORKFLOW_HIGHLIGHT_WORD = new RegExp(
	["workflow", "workflows", "workflowz"].map(keyword => magicKeywordRegex(keyword).source).join("|"),
	"gu",
);

const WORKFLOW_DIRECT_REQUEST =
	/(?:^|[\n.!?;]\s*)(?:(?:[Pp]lease|pls|vui lòng|hãy|xin hãy)\s+|(?:[Cc]an|[Cc]ould|[Ww]ould)\s+you\s+|[Ii]\s+(?:want|need)\s+(?:you\s+)?to\s+)?workflow(?:s|z)?(?=$|[,:!?+]|[\s]+(?:this|that|it|these|those|the|my|our|all|everything)\b)/u;
const WORKFLOW_TOOL_REQUEST =
	/(?:^|[\n.!?;]\s*)(?:(?:[Pp]lease|pls|vui lòng|hãy|xin hãy)\s+|(?:[Cc]an|[Cc]ould|[Ww]ould)\s+you\s+|[Ii]\s+(?:want|need)\s+(?:you\s+)?to\s+)?(?:use|run|start|launch|execute|invoke|call|trigger|dùng|chạy|sử dụng|gọi|bật)\b[^.!?;\n]{0,48}\bworkflow(?:s|z)?(?=$|[\s,:!?])/u;

/** WORKFLOW_NOTICE is the default hidden notice for workflow-tool fan-out. */
export const WORKFLOW_NOTICE: string = renderWorkflowNotice({ taskBatch: true });

/** renderWorkflowNotice renders the workflow notice for the active task schema. */
export function renderWorkflowNotice({
	taskBatch,
	scoutAvailable,
	evalTools,
}: {
	taskBatch: boolean;
	scoutAvailable?: boolean;
	/** Advertise `@tool`-defined tools for subagents (`eval.tools.enabled`). */
	evalTools?: boolean;
}): string {
	return prompt
		.render(workflowNoticeTemplate, {
			taskBatch,
			scoutAvailable: scoutAvailable ?? true,
			evalTools: evalTools ?? true,
		})
		.trim();
}

/**
 * Whether `text` contains the lowercase substring "workflow" in prose. This is
 * broad detection for highlighting compatibility, not permission to invoke the
 * workflow tool.
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}

/**
 * Whether `text` explicitly asks to use workflow orchestration. Mere mentions,
 * complaints, negations, and generic workflow-design questions stay false.
 */
export function requestsWorkflow(text: string): boolean {
	const prose = maskNonProse(text);
	return WORKFLOW_DIRECT_REQUEST.test(prose) || WORKFLOW_TOOL_REQUEST.test(prose);
}

/**
 * Highlight every standalone "workflow"/"workflows" in `text` for editor display
 * with a warm amber→green gradient (hue 30..150), visually distinct from
 * ultrathink's rainbow and orchestrate's teal→violet.
 */
export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /workflow/,
	highlight: WORKFLOW_HIGHLIGHT_WORD,
	stops: 14,
	hue: t => 30 + t * 120,
});
