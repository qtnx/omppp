import { prompt } from "@oh-my-pi/pi-utils";
import orchestrateNotice from "../prompts/system/orchestrate-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse, maskNonProse } from "./markdown-prose";

/**
 * "orchestrate" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a cool
 * teal→violet gradient ({@link highlightOrchestrate}). Broad prose detection is
 * kept for highlighting; hidden steering and Safe Orchestrator Mode auto-entry
 * require explicit directive intent via {@link requestsOrchestrate}. Matching is
 * case-sensitive (lowercase only), so "orchestrated", "Orchestrate", or a path
 * like "orchestrate.ts" never trigger either behavior.
 */

// Detection: lowercase keyword flanked by prose punctuation, whitespace, or a string edge.
const ORCHESTRATE_WORD = magicKeywordRegex("orchestrate");

// Auto-entry is intentionally stricter than highlighting: a mention or complaint
// must never switch the session into delegation-only Safe Orchestrator Mode.
const ORCHESTRATE_REQUEST =
	/(?:^|[\n.!?;]\s*)(?:(?:[Pp]lease|pls|vui lòng|hãy|xin hãy)\s+|(?:[Cc]an|[Cc]ould|[Ww]ould)\s+you\s+|[Ii]\s+(?:want|need)\s+(?:you\s+)?to\s+)?orchestrate(?=$|[,:!?]|[\s]+(?:this|that|it|these|those|the|my|our|all|everything)\b)/u;

/** Hidden system notice appended after a user message that mentions "orchestrate". */
export function renderOrchestrateNotice(options: { tools: readonly string[] }): string {
	return prompt.render(orchestrateNotice, { tools: options.tools }).trim();
}

/**
 * Whether `text` contains the standalone keyword "orchestrate" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsOrchestrate(text: string): boolean {
	return keywordInProse(text, ORCHESTRATE_WORD);
}

/** Whether `text` explicitly asks to enter orchestration mode. */
export function requestsOrchestrate(text: string): boolean {
	return ORCHESTRATE_REQUEST.test(maskNonProse(text));
}

/**
 * Highlight every standalone "orchestrate" in `text` for editor display with a
 * cool teal→violet gradient (hue 150..280), visually distinct from ultrathink's
 * full-spectrum rainbow.
 */
export const highlightOrchestrate: KeywordHighlighter = createGradientHighlighter({
	probe: /orchestrate/,
	highlight: magicKeywordRegex("orchestrate", "g"),
	stops: 14,
	hue: t => 150 + t * 130,
});
