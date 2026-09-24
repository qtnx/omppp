import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { maskNonProse } from "@oh-my-pi/pi-tui/prompt/markdown-prose";
import { prompt } from "@oh-my-pi/pi-utils";
import jevifyNotice from "../prompts/system/jevify-notice.md" with { type: "text" };
import orchestrateNotice from "../prompts/system/orchestrate-notice.md" with { type: "text" };
import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };
import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };

/**
 * Magic keywords: standalone lowercase prose words in a user prompt that
 * append a hidden, user-attributed notice for that turn and glow in the TUI.
 *
 * This table is the single source of truth. Every downstream surface derives
 * from it: the `magicKeywords.<id>` settings (settings-schema), the notice
 * injection and `<id>-notice` message types (agent-session, queued-messages),
 * and the editor/bubble gradients (`setMagicKeywords` in pi-tui). Adding a
 * keyword means one row here plus its notice template under `prompts/system/`.
 */

/** Session facts a keyword notice may render against. */
export interface MagicKeywordContext {
	/** Enabled tool names for the turn. */
	tools: readonly string[];
	/** `task.batch`: whether `task` accepts a `tasks[]` array. */
	taskBatch: boolean;
	/** Whether the `scout` agent can be dispatched. */
	scoutAvailable: boolean;
	/** `eval.tools.enabled`: whether `@tool`-defined kernel tools exist. */
	evalTools: boolean;
	/** Whether Safe Orchestrator Mode is already active for the session. */
	orchestratorEnabled: boolean;
}

/** One magic keyword: trigger word, gradient, settings copy, and the notice it injects. */
export interface MagicKeyword {
	/** Settings key suffix (`magicKeywords.<id>`) and notice message type prefix (`<id>-notice`). */
	id: string;
	/** Exact lowercase trigger, matched only as standalone prose. */
	word: string;
	/** Editor/bubble gradient as an HSL hue sweep `[from, to]` in degrees; `to` may exceed 360 to wrap. */
	hue: readonly [number, number];
	/** Settings panel label. */
	label: string;
	/** Settings panel description. */
	description: string;
	/**
	 * Whether `text` triggers the keyword. Plain keywords fire on a standalone
	 * prose occurrence; OMPx fork keywords that gate behavior
	 * (orchestrate, workflow) demand explicit directive intent, so a mention,
	 * complaint, or negation never fires them.
	 */
	requests: (text: string) => boolean;
	/** Whether the session can honor the notice; it is skipped otherwise. */
	applies: (context: MagicKeywordContext) => boolean;
	/** Render the hidden notice queued ahead of the user message. */
	notice: (context: MagicKeywordContext) => string;
}

/** Hidden notice for "ultrathink": careful multi-step reasoning. */
export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();

/** Hidden notice for "jevify": bulk classification through the eval kernel's `judge()`. */
export const JEVIFY_NOTICE: string = jevifyNotice.trim();

/** Hidden notice for "orchestrate", naming only the tools the session actually exposes. */
export function renderOrchestrateNotice({ tools }: Pick<MagicKeywordContext, "tools">): string {
	return prompt.render(orchestrateNotice, { tools }).trim();
}

/** Hidden notice for "workflowz", shaped by the active task/eval capabilities. */
export function renderWorkflowNotice({
	taskBatch,
	scoutAvailable,
	evalTools,
}: Pick<MagicKeywordContext, "taskBatch" | "scoutAvailable" | "evalTools">): string {
	return prompt.render(workflowNotice, { taskBatch, scoutAvailable, evalTools }).trim();
}

export const MAGIC_KEYWORDS = [
	{
		id: "ultrathink",
		word: "ultrathink",
		hue: [0, 330],
		label: "Ultrathink Keyword",
		description: "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
		requests: text => containsMagicKeyword(text, "ultrathink"),
		applies: () => true,
		notice: () => ULTRATHINK_NOTICE,
	},
	{
		id: "orchestrate",
		word: "orchestrate",
		hue: [150, 280],
		label: "Orchestrate Keyword",
		description: "Let standalone orchestrate append its hidden multi-agent orchestration notice",
		requests: requestsOrchestrate,
		// The contract is entirely about `task` subagent dispatch; without the task
		// tool the notice would demand an unavailable capability. Already inside
		// Safe Orchestrator Mode, the session prompt already carries the contract.
		applies: context => context.tools.includes("task") && !context.orchestratorEnabled,
		notice: renderOrchestrateNotice,
	},
	{
		id: "workflow",
		word: "workflowz",
		hue: [30, 150],
		label: "Workflow Keyword",
		description: "Let standalone workflowz append its hidden eval workflow notice",
		requests: requestsWorkflow,
		// OMPx fork: the notice drives the fork's `workflow` tool, so that tool being
		// active is the gate; upstream's task+eval pair still honors it because the
		// fork's tool subsumes that path.
		applies: context =>
			context.tools.includes("workflow") || (context.tools.includes("task") && context.tools.includes("eval")),
		notice: renderWorkflowNotice,
	},
	{
		id: "jevify",
		word: "jevify",
		hue: [300, 420],
		label: "Jevify Keyword",
		description: "Let standalone jevify append its hidden bulk-judge classification notice",
		requests: text => containsMagicKeyword(text, "jevify"),
		// The contract is entirely about the eval kernel's `judge()` helper.
		applies: context => context.tools.includes("eval"),
		notice: () => JEVIFY_NOTICE,
	},
] as const satisfies readonly MagicKeyword[];

/** Settings key suffix of a registered keyword. */
export type MagicKeywordId = (typeof MAGIC_KEYWORDS)[number]["id"];

/** Hidden custom-message type carrying a keyword's notice. */
export type MagicKeywordNoticeType = `${MagicKeywordId}-notice`;

// OMPx fork: a magic keyword also gates behavior, not only highlighting. Entering
// Safe Orchestrator Mode and appending the workflow notice require explicit
// directive intent — a mere mention, complaint, or negation must never trigger
// either path. Detection runs on prose only (code spans, fenced blocks, and XML
// sections are masked out).

const ORCHESTRATE_REQUEST =
	/(?:^|[\n.!?;]\s*)(?:(?:[Pp]lease|pls|vui lòng|hãy|xin hãy)\s+|(?:[Cc]an|[Cc]ould|[Ww]ould)\s+you\s+|[Ii]\s+(?:want|need)\s+(?:you\s+)?to\s+)?orchestrate(?=$|[,:!?]|[\s]+(?:this|that|it|these|those|the|my|our|all|everything)\b)/u;

const WORKFLOW_DIRECT_REQUEST =
	/(?:^|[\n.!?;]\s*)(?:(?:[Pp]lease|pls|vui lòng|hãy|xin hãy)\s+|(?:[Cc]an|[Cc]ould|[Ww]ould)\s+you\s+|[Ii]\s+(?:want|need)\s+(?:you\s+)?to\s+)?workflow(?:s|z)?(?=$|[,:!?+]|[\s]+(?:this|that|it|these|those|the|my|our|all|everything)\b)/u;

const WORKFLOW_TOOL_REQUEST =
	/(?:^|[\n.!?;]\s*)(?:(?:[Pp]lease|pls|vui lòng|hãy|xin hãy)\s+|(?:[Cc]an|[Cc]ould|[Ww]ould)\s+you\s+|[Ii]\s+(?:want|need)\s+(?:you\s+)?to\s+)?(?:use|run|start|launch|execute|invoke|call|trigger|dùng|chạy|sử dụng|gọi|bật)\b[^.!?;\n]{0,48}\bworkflow(?:s|z)?(?=$|[\s,:!?])/u;

/** Whether `text` explicitly asks to enter orchestration mode. */
export function requestsOrchestrate(text: string): boolean {
	return ORCHESTRATE_REQUEST.test(maskNonProse(text));
}

/** Whether `text` explicitly asks to use workflow orchestration. */
export function requestsWorkflow(text: string): boolean {
	const prose = maskNonProse(text);
	return WORKFLOW_DIRECT_REQUEST.test(prose) || WORKFLOW_TOOL_REQUEST.test(prose);
}
