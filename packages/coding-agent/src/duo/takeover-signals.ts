import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/**
 * Completion-claim language patterns (case-insensitive, EN + VI). A match in the
 * final assistant message is one of the two AND-ed triggers for the advisor
 * done-review gate — combined with {@link hasMutationsSinceLastUserPrompt} so a
 * plain Q&A answer ("done reading, here's the answer") never trips the gate.
 * Word boundaries are used where they discriminate; short/accented VI tokens and
 * check-mark glyphs match literally.
 */
const DONE_CLAIM_PATTERNS: readonly RegExp[] = [
	/\bdone\b/i,
	/complet(?:e|ed|ion)/i,
	/\bfinished\b/i,
	/\bimplemented\b/i,
	/\bfixed\b/i,
	/\bresolved\b/i,
	/\bverified\b/i,
	/\btests?\s+pass(?:es|ed)?\b/i,
	/\bworks\b/i,
	/\bsuccessfully\b/i,
	/hoàn thành/i,
	/\bxong\b/i,
	/đã sửa/i,
	/chạy ok/i,
	/✅/,
	/✓/,
];

/**
 * Whether `text` contains completion-claim language (see {@link DONE_CLAIM_PATTERNS}).
 * Exported for unit tests.
 */
export function detectCompletionClaim(text: string): boolean {
	return DONE_CLAIM_PATTERNS.some(re => re.test(text));
}

/** Tool names whose successful result counts as a workspace mutation. */
const DONE_GATE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"ast_edit",
	"task",
	"workflow",
	"bash",
]);

/** Whether any successful mutating toolResult exists at or after `start` (clamped to 0). */
export function hasMutationsSince(messages: readonly AgentMessage[], start: number): boolean {
	for (let i = Math.max(0, start); i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "toolResult") continue;
		if (message.isError) continue;
		if (DONE_GATE_MUTATION_TOOLS.has(message.toolName)) return true;
	}
	return false;
}

/**
 * Whether any workspace mutation occurred since the last genuine user prompt.
 *
 * Scans backwards to the boundary — the last `role === "user"` message that is
 * NOT agent-attributed (synthetic/developer prompts carry `attribution: "agent"`
 * and must not reset the window) — then forward-scans that suffix for a
 * successful `toolResult` from a mutating tool. Exported for unit tests.
 */
export function hasMutationsSinceLastUserPrompt(messages: readonly AgentMessage[]): boolean {
	return hasMutationsSince(messages, lastUserPromptIndex(messages));
}

/** Index of the last genuine (non-agent-attributed) user prompt; 0 when none. */
function lastUserPromptIndex(messages: readonly AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" && message.attribution !== "agent") return i;
	}
	return 0;
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += `${block.text}\n`;
	}
	return text;
}

/** Scolding / frustration in the LAST genuine user message (EN + VI). Exported for unit tests. */
export const NEGATIVE_SENTIMENT_PATTERNS: readonly RegExp[] = [
	/\b(?:wtf|wth|ffs)\b/i,
	/\bstill\s+(?:broken|failing|wrong|not\s+work)/i,
	/\b(?:doesn'?t|does\s+not|isn'?t|not)\s+work(?:s|ing)?\b/i,
	/\byou\s+(?:broke|keep|failed|lied|ignored)\b/i,
	/\b(?:useless|wrong\s+again|same\s+bug\s+again)\b/i,
	/vẫn\s+(?:sai|lỗi|hỏng|chưa)/i,
	/(?:đã|toi|tôi)\s+bảo/i,
	/sao\s+vẫn/i,
	/làm\s+lại(?:\s+đi)?/i,
	/không\s+(?:chạy|hoạt\s+động|được)\b/i,
	/(?:quá\s+tệ|tệ\s+quá)/i,
];

export function detectNegativeSentiment(messages: readonly AgentMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user" || message.attribution === "agent") continue;
		const text = textOf(message);
		return NEGATIVE_SENTIMENT_PATTERNS.some(re => re.test(text));
	}
	return false;
}

/** Trailing run of failed tool results (interleaved assistant messages ignored); resets at a success or the user boundary. */
export function countTrailingToolFailures(messages: readonly AgentMessage[]): number {
	let failures = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" && message.attribution !== "agent") break;
		if (message.role !== "toolResult") continue;
		if (message.isError) failures += 1;
		else break;
	}
	return failures;
}

/** True when the same tool call (name + arguments) repeats `threshold` times since the last user prompt. */
export function detectToolLoop(messages: readonly AgentMessage[], threshold: number): boolean {
	if (threshold <= 0) return false;
	const start = lastUserPromptIndex(messages);
	const counts = new Map<string, number>();
	for (let i = start; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const signature = `${block.name}:${JSON.stringify(block.arguments)}`;
			const next = (counts.get(signature) ?? 0) + 1;
			if (next >= threshold) return true;
			counts.set(signature, next);
		}
	}
	return false;
}

/** Tool results that count as verification evidence for a completion claim. */
const VERIFICATION_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/** Final assistant text claims done, the window mutated the workspace, and no successful verification ran. */
export function detectDoneClaimWithoutEvidence(messages: readonly AgentMessage[]): boolean {
	const last = messages.at(-1);
	if (last?.role !== "assistant") return false;
	const text = textOf(last);
	if (!text || !detectCompletionClaim(text)) return false;
	if (!hasMutationsSinceLastUserPrompt(messages)) return false;
	const start = lastUserPromptIndex(messages);
	for (let i = start; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "toolResult") continue;
		if (!message.isError && VERIFICATION_TOOLS.has(message.toolName)) return false;
	}
	return true;
}

const PLAN_DOC_PATH_PATTERN = /(?:^|\/)plans?\/|(?:^|[/._-])plan[^/]*\.md$/i;
const PLAN_HEADING_PATTERN = /^#{1,3}\s+(?:implementation\s+plan|phase\b|task\s+\d|milestone\b)/gim;

/** Executor doing planner work: plan-document writes or a plan-structured essay (soft R6 signal). */
export function detectPlanningShapedWork(messages: readonly AgentMessage[]): boolean {
	const start = lastUserPromptIndex(messages);
	for (let i = start; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (block.name !== "write" && block.name !== "edit" && block.name !== "ast_edit") continue;
			const pathArg = block.arguments.path ?? block.arguments.file_path;
			if (typeof pathArg === "string" && PLAN_DOC_PATH_PATTERN.test(pathArg)) return true;
		}
	}
	const last = messages.at(-1);
	if (last?.role !== "assistant") return false;
	const matches = textOf(last).match(PLAN_HEADING_PATTERN);
	return (matches?.length ?? 0) >= 3;
}

/** Detection result for {@link detectPlanningNeeded}. */
export interface PlanningNeededDetection {
	needed: boolean;
	evidence: string[];
}

/** Imperative build verbs (EN + VI). VI tokens use explicit separators because word boundaries are unreliable around accented chars. */
const PLANNING_IMPERATIVE_PATTERN =
	/\b(?:implement|build|add|create|refactor|redesign|migrate|integrate|rewrite|support)\b|(?:^|[\s,;:.!])(?:làm|thêm|xây(?:\s+dựng)?|tạo|viết|thiết\s+kế|tích\s+hợp)(?=$|[\s,;:.!])|tính\s+năng/iu;
const PLANNING_IMPERATIVE_PATTERN_G = new RegExp(PLANNING_IMPERATIVE_PATTERN.source, "giu");

/** Whole-message acknowledgements / continuations (never plan-shaped). */
const ACK_CONTINUATION_PATTERN =
	/^(?:ok(?:ay)?|yes|yep|no|nope|thanks?|thank\s+you|continue|proceed|resume|status|go(?:\s+on)?|(?:làm\s+)?tiếp(?:\s+tục)?(?:\s+đi)?|tiếp\s+đi|ừ|dạ|vâng|được)[\s.!]*$/iu;

/** Trivial one-off fixes (never plan-shaped). */
const TRIVIAL_FIX_PATTERN =
	/\b(?:fix|correct)(?:\s+\S+){0,3}\s+typos?\b|\bfix\s+typos?\b|\bone[- ]liner\b|\bquick\s+fix\b|sửa\s+(?:lỗi\s+)?chính\s+tả/iu;

const LIST_MARKER_PATTERN = /^\s*(?:\d+[.)]|[-*+•])\s+\S/m;
const INLINE_ENUM_PATTERN = /(?:^|\s)\d+[.)]\s/g;
const FILE_MENTION_PATTERN = /\b[\w./-]+\.[a-z]{1,4}\b/gi;

/**
 * Whether an incoming user message is plan-shaped: imperative build language
 * (EN+VI) combined with at least one scope marker. Pure; drives the automatic
 * duo planning takeover at message receipt.
 */
export function detectPlanningNeeded(text: string): PlanningNeededDetection {
	const none: PlanningNeededDetection = { needed: false, evidence: [] };
	const trimmed = text.trim();
	if (!trimmed) return none;
	if (trimmed.startsWith("/")) return none;
	if (ACK_CONTINUATION_PATTERN.test(trimmed)) return none;
	if (TRIVIAL_FIX_PATTERN.test(trimmed)) return none;

	const sentences = trimmed.split(/(?<=[.!?])\s+|\n+/).filter(sentence => sentence.trim().length > 0);
	const declarative = sentences.filter(sentence => !sentence.trimEnd().endsWith("?"));
	if (declarative.length === 0) return none;
	const declarativeText = declarative.join("\n");
	if (!PLANNING_IMPERATIVE_PATTERN.test(declarativeText)) return none;

	const evidence: string[] = ["imperative build verb"];
	if (LIST_MARKER_PATTERN.test(trimmed) || (trimmed.match(INLINE_ENUM_PATTERN)?.length ?? 0) >= 2) {
		evidence.push("itemized scope list");
	}
	if (declarative.length >= 2) evidence.push("multiple task clauses");
	if ((declarativeText.match(PLANNING_IMPERATIVE_PATTERN_G)?.length ?? 0) >= 2) evidence.push("multiple build verbs");
	if ((trimmed.match(FILE_MENTION_PATTERN)?.length ?? 0) >= 2) evidence.push("multiple file/feature mentions");
	if (trimmed.length > 200) evidence.push("long imperative request");
	if (evidence.length < 2) return none;
	return { needed: true, evidence };
}

export interface TakeoverSignalThresholds {
	failureThreshold: number;
	loopThreshold: number;
	sentimentEnabled: boolean;
}

export interface TakeoverSignalReport {
	sentiment: boolean;
	consecutiveFailures: number;
	loop: boolean;
	doneClaimWithoutEvidence: boolean;
	planningShapedWork: boolean;
	/** Scolding combined with a failure streak or loop: bypasses the recover cooldown. */
	strong: boolean;
	evidence: string[];
}

export function evaluateTakeoverSignals(
	messages: readonly AgentMessage[],
	thresholds: TakeoverSignalThresholds,
): TakeoverSignalReport {
	const sentiment = thresholds.sentimentEnabled && detectNegativeSentiment(messages);
	const consecutiveFailures = countTrailingToolFailures(messages);
	const loop = detectToolLoop(messages, thresholds.loopThreshold);
	const doneClaimWithoutEvidence = detectDoneClaimWithoutEvidence(messages);
	const planningShapedWork = detectPlanningShapedWork(messages);
	const failing = consecutiveFailures >= thresholds.failureThreshold;
	const evidence: string[] = [];
	if (sentiment) evidence.push("negative user sentiment in the last prompt");
	if (failing) evidence.push(`${consecutiveFailures} consecutive failed tool results`);
	if (loop) evidence.push(`the same tool call repeated >=${thresholds.loopThreshold}x with no new approach`);
	if (doneClaimWithoutEvidence) evidence.push("completion claimed after mutations with no verification run");
	if (planningShapedWork) evidence.push("executor produced planning-shaped work");
	return {
		sentiment,
		consecutiveFailures,
		loop,
		doneClaimWithoutEvidence,
		planningShapedWork,
		strong: sentiment && (failing || loop),
		evidence,
	};
}
