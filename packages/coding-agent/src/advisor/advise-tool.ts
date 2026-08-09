import { type } from "@oh-my-pi/omptype";
import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText } from "@oh-my-pi/pi-utils";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };

const adviseSchema = type({
	note: type("string").describe(
		"One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	),
	"severity?": type("'nit' | 'concern' | 'blocker'").describe("How strongly to weigh this. Omit for a plain nit."),
});

export type AdviseParams = typeof adviseSchema.infer;

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdviseDetails {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/** One queued advice note. */
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/** Details payload on the batched `advisor` custom message rendered in the transcript. */
export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
}

/**
 * Behavioral framing for the watched agent — advice, not orders. Carried as a
 * tag attribute (rather than a prose header) so the rendered agent-facing output
 * stays a clean `<advisory>` block. The primary agent's system prompt never
 * mentions advisories, so this is its only cue for how to treat them.
 */
const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

/**
 * Render a batch of advisor notes as the agent-facing message body: one
 * `<advisory>` element per note, severity as an attribute. Shared by the
 * non-interrupting YieldQueue dispatcher and the interrupting steer path so both
 * build byte-identical content.
 */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
	return notes
		.map(n => {
			const severity = n.severity ? ` severity="${n.severity}"` : "";
			const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
			return `<advisory${who}${severity} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

/**
 * Whether advice at this severity needs immediate handling when the primary is
 * idle. Active primary runs always receive advisor notes at the next safe aside
 * boundary; `concern` and `blocker` trigger an idle turn, while a plain `nit`
 * always queues.
 */
export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

/** How an advisor note is routed to the primary. */
export type AdvisorDeliveryChannel = "aside" | "boundary" | "steer" | "preserve";
/** Half-open turn-count fence for the post-interrupt cooldown. */
export function isAdvisorInterruptImmuneTurnActive(opts: {
	completedTurns: number;
	immuneTurnStart: number | undefined;
	immuneTurns: number;
}): boolean {
	if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
	return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

/**
 * Decide how one advisor note reaches the primary agent.
 *
 * - A `preserveOnly` caller records every note that arrives while the primary
 *   is idle as a visible card and never starts a new primary turn.
 * - A non-interrupting `nit` always rides the passive aside queue.
 * - A late `concern` is retained as a visible card when the primary has already
 *   ended with a terminal text answer and no queued work remains, so it cannot
 *   wake the primary merely to restate completion. A `blocker` still steers a
 *   corrective turn because it represents unexercised or broken work.
 * - After a deliberate user interrupt (`autoResumeSuppressed`), an interrupting
 *   note is preserved as a visible card while the agent is idle or tearing the
 *   interrupted turn down (`aborting`), so it cannot auto-resume the stopped run.
 *   During an active user-driven resume, it is delivered live.
 * - During the post-interrupt immune-turn window, remaining `concern`/`blocker`
 *   notes are downgraded to passive asides, including while the primary streams.
 * - Otherwise, while the primary agent's core loop is streaming,
 *   `concern`/`blocker` notes become boundary steering: they dequeue after the
 *   current tool batch without aborting or skipping its remaining calls.
 * - Only an idle, unsuppressed, non-immune `concern`/`blocker` is steered to
 *   trigger immediate handling.
 */
export function resolveAdvisorDeliveryChannel(opts: {
	severity: AdvisorSeverity | undefined;
	autoResumeSuppressed: boolean;
	streaming: boolean;
	aborting: boolean;
	terminalAnswerNoQueuedWork?: boolean;
	interruptImmuneTurnActive?: boolean;
	preserveOnly?: boolean;
}): AdvisorDeliveryChannel {
	if (opts.preserveOnly && !opts.streaming) return "preserve";
	if (!isInterruptingSeverity(opts.severity)) return "aside";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
	if (opts.terminalAnswerNoQueuedWork && opts.severity !== "blocker" && !opts.streaming && !opts.aborting)
		return "preserve";
	if (opts.interruptImmuneTurnActive) return "aside";
	if (opts.streaming) return "boundary";
	return "steer";
}

/**
 * Derive the advisor loop's telemetry from the primary session's config so the
 * advisor model's GenAI spans and usage/cost hooks (onChatUsage, onCostDelta,
 * costEstimator) fire under the same pipeline as every other model call —
 * stamped with the advisor's own agent identity. `conversationId` is cleared so
 * the advisor loop falls back to its own `-advisor` session id for
 * `gen_ai.conversation.id` instead of inheriting the primary's conversation.
 *
 * Returns undefined when the primary has no telemetry (instrumentation off), so
 * the advisor `Agent` stays a zero-overhead no-op as well.
 */
export function deriveAdvisorTelemetry(
	primaryTelemetry: AgentTelemetryConfig | undefined,
	identity: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!primaryTelemetry) return undefined;
	return { ...primaryTelemetry, agent: identity, conversationId: undefined };
}

/**
 * The tools an advisor receives by default when its config omits `tools` — the
 * safe investigative/review set. The full available pool is every built tool the
 * session has (the advisor is a full agent); a config's `tools` selects from it.
 */
export const ADVISOR_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "glob", "super_review"]);

function advisorNoteDedupeKey(note: string): string {
	return note.trim().replace(/\s+/g, " ");
}

/** Rank advisor severities so the dedupe state can detect a real escalation
 *  (nit → concern → blocker) versus a verbatim repeat. `undefined` defers to
 *  `nit` because the schema treats an omitted severity as a plain nit. */
const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
	return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;
	/** Highest delivered severity rank per normalized note. A new call passes
	 *  through only when its rank strictly exceeds the recorded one (a real
	 *  escalation: nit → concern → blocker), so an advisor cannot bypass dedupe
	 *  by retagging the same text at a lower or equal severity. */
	#deliveredNoteSeverities = new Map<string, number>();
	#inProgressUpdate = false;

	#consultAnswerExempt = false;

	constructor(private readonly onAdvice: (note: string, severity?: AdviseDetails["severity"]) => void) {}

	/**
	 * Mark whether the next advisor prompt reviews an in-progress primary turn.
	 * Non-blockers are withheld until a completed update so partial work does
	 * not interrupt the primary before it can finish its planned steps.
	 */
	beginUpdate(inProgress: boolean): void {
		this.#inProgressUpdate = inProgress;
	}

	/** Clear delivered-note memory when the advisor starts a fresh conversation. */
	resetDeliveredNotes(): void {
		this.#deliveredNoteSeverities.clear();
		this.#inProgressUpdate = false;
	}

	/** One-shot: the next advise bypasses this tool's own duplicate filter so an
	 *  async consult answer is never dropped upstream of the emission guard. Armed
	 *  and cleared each cycle via the host's beginAdvisorUpdate (mirrors the guard). */
	setConsultAnswerExemption(on: boolean): void {
		this.#consultAnswerExempt = on;
	}

	async execute(
		_toolCallId: string,
		args: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		if (this.#inProgressUpdate && args.severity !== "blocker") {
			return {
				content: [{ type: "text", text: "Recorded." }],
				details: { note: args.note, severity: args.severity },
				useless: true,
			};
		}
		const key = advisorNoteDedupeKey(args.note);
		const rank = advisorSeverityRank(args.severity);
		const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
		if (this.#consultAnswerExempt) {
			// Async consult answer: bypass this tool's own dedupe so the answer reaches the
			// primary; the emission guard's one-shot exemption delivers it past its dedupe
			// too. Not recorded here, so it can't poison later duplicate filtering.
			this.#consultAnswerExempt = false;
			this.onAdvice(args.note, args.severity);
			return {
				content: [{ type: "text", text: "Recorded." }],
				details: { note: args.note, severity: args.severity },
				useless: true,
			};
		}
		if (rank <= previousRank) {
			return {
				content: [{ type: "text", text: "Duplicate advice ignored." }],
				details: { note: args.note, severity: args.severity },
				useless: true,
			};
		}
		this.#deliveredNoteSeverities.set(key, rank);
		this.onAdvice(args.note, args.severity);
		return {
			content: [{ type: "text", text: "Recorded." }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}
}
