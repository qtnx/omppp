import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

/**
 * "workflow" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a warm
 * amber→green gradient ({@link highlightWorkflow}); submitting a message that
 * mentions it appends a hidden {@link WORKFLOW_NOTICE} that steers the model to
 * author and run a deterministic multi-subagent workflow through the workflow
 * tool. Matching is whitespace-delimited and case-sensitive (lowercase
 * only) — "workflow"/"workflows" trigger, but "workflowed", "Workflow", and
 * "workflow.ts" never do.
 */

// Detection: fork compatibility keeps any lowercase "workflow" prose substring
// as a notice trigger (for example, "workflowz") while code/XML masking stays in
// `keywordInProse`. Highlighting remains standalone-word only for editor display.
const WORKFLOW_NOTICE_WORD = /(?<![/.])workflow(?!\.[A-Za-z0-9])/;

/** Hidden system notice appended after a user message that mentions "workflow". */
export const WORKFLOW_NOTICE: string = workflowNotice.trim();

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
	highlight: /(?<!\S)workflows?(?!\S)/g,
	stops: 14,
	hue: t => 30 + t * 120,
});
