import { prompt } from "@oh-my-pi/pi-utils";
import workflowNoticeTemplate from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * "workflow" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a warm
 * amber→green gradient ({@link highlightWorkflow}); submitting a message that
 * mentions it appends a hidden workflow notice that steers the model to author
 * and run a deterministic multi-subagent workflow through the workflow tool.
 * Matching is case-sensitive (lowercase only): lowercase "workflow" prose
 * substrings trigger for OMPx compatibility; code paths and file extensions do not.
 */

// Detection: fork compatibility keeps any lowercase "workflow" prose substring
// as a notice trigger (for example, "workflowz") while code/XML masking stays in
// `keywordInProse`. Highlighting remains standalone-word only for editor display.
const WORKFLOW_NOTICE_WORD = /(?<![/.])workflow(?!\.[A-Za-z0-9])/;

const WORKFLOW_HIGHLIGHT_WORD = new RegExp(
	["workflow", "workflows", "workflowz"].map(keyword => magicKeywordRegex(keyword).source).join("|"),
	"gu",
);

/** WORKFLOW_NOTICE is the default hidden notice for workflow-tool fan-out. */
export const WORKFLOW_NOTICE: string = renderWorkflowNotice({ taskBatch: true });

/** renderWorkflowNotice renders the workflow notice for the active task schema. */
export function renderWorkflowNotice({
	taskBatch,
	scoutAvailable,
}: {
	taskBatch: boolean;
	scoutAvailable?: boolean;
}): string {
	return prompt.render(workflowNoticeTemplate, { taskBatch, scoutAvailable: scoutAvailable ?? true }).trim();
}

/**
 * Whether `text` contains the lowercase substring "workflow" in prose — never
 * inside a code block, inline code span, or XML/HTML section. This intentionally
 * preserves the OMPx fork's notice compatibility for inputs like "workflowz".
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_NOTICE_WORD);
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
