import { type AgentMessage, countTokens } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Effort, ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import consultationRequestTemplate from "../prompts/advisor/consultation-request.md" with { type: "text" };
import consultationRequestAsyncTemplate from "../prompts/advisor/consultation-request-async.md" with { type: "text" };
import fableNormalMessageFramesNote from "../prompts/advisor/fable-normal-message-frames-note.md" with { type: "text" };
import promptReviewTemplate from "../prompts/advisor/prompt-review.md" with { type: "text" };
import { obfuscateToolArguments } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import {
	formatExecutionSourcePreview,
	formatSessionHistoryMarkdown,
	formatToolResultErrorPreview,
	PRIMARY_CONTEXT_CUSTOM_TYPES,
} from "../session/session-history-format";

/**
 * Minimal slice of `Agent` the runtime drives — satisfied by pi-agent-core
 * `Agent`. `state.error` mirrors `Agent.state.error`: provider/stream failures
 * the loop catches internally never reject `prompt()`, so the runtime reads
 * this field after every prompt to detect a failed turn.
 */
export interface AdvisorAgent {
	prompt(input: string, images?: ImageContent[]): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;
	readonly model?: Model;
	setModel?(model: Model): void;
	setThinkingLevel?(level: Effort | undefined): void;
	setDisableReasoning?(disabled: boolean): void;
	readonly disableReasoning?: boolean;
	/**
	 * Drop messages appended past `count`. Called after a failed `prompt()` so a
	 * retry doesn't replay the failed user batch + synthetic assistant-error
	 * turn `Agent.#runLoop` records on its internal state.
	 */
	rollbackTo?(count: number): void;
	readonly state: { messages: AgentMessage[]; error?: string };
}

export interface AdvisorRuntimeHost {
	/** Live primary transcript (use `agent.state.messages`). */
	snapshotMessages(): AgentMessage[];
	/** Surface one advice note to the primary (enqueues into the session YieldQueue). */
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	/** Redact primary transcript bytes before they reach the advisor model. */
	obfuscator?: SecretObfuscator;
	/**
	 * Pre-prompt context maintenance for the advisor's own append-only context.
	 * Promotes the advisor model to a larger sibling when its context nears the
	 * window (mirroring the primary's promote-first policy) and resolves `true`
	 * when the advisor must clear its own context before sending the current
	 * incremental update. The cursor stays at the current primary position: this
	 * recovery path must never replay the full primary transcript.
	 * Optional: hosts that omit it get no proactive maintenance.
	 */
	maintainContext?(incomingTokens: number, signal: AbortSignal): Promise<boolean>;
	/**
	 * Called immediately before each `agent.prompt(batch)` cycle. Lets the host
	 * clear per-update advisor state and apply the in-progress delivery policy.
	 * The host owns these gates because it routes `advise()` results back to the
	 * primary.
	 */
	beginAdvisorUpdate?(inProgress: boolean, opts?: { consultAnswer?: boolean }): void;
	/** Render authoritative per-turn stats above the advisor's session update block. */
	renderStatsHeader?: () => string | undefined;
	/** Render persisted advisor seed context after a reset/re-prime without reading files in the runtime. */
	renderPrimeSeed?: () => string | undefined;
	/**
	 * Called with the error of every failed advisor turn, before the retry sleep
	 * or the dropped-after-3 path. Lets the host apply credential-level remedies
	 * and configured model fallback that the advisor loop cannot perform itself.
	 * Return `true` after switching models so the same clean batch is retried
	 * immediately with a fresh failure budget. `failedMessages` contains the
	 * failed prompt's appended turns before rollback. Errors thrown here are
	 * logged and swallowed.
	 */
	onTurnError?(
		error: unknown,
		model: Model | undefined,
		failedMessages: readonly AgentMessage[],
		signal: AbortSignal,
	): Promise<boolean | undefined> | boolean | undefined;
	/** Called after a successful advisor turn so the host can finish fallback lifecycle reporting. */
	onTurnSuccess?(): Promise<void> | void;
	/** Surface a non-recovering advisor failure to the host UI without adding model-visible context. */
	notifyFailure?(error: unknown): void;
	/** Signal that the advisor paused on a quota/rate-limit after host-level recovery declined. */
	notifyQuotaExhausted?(): void;
	/**
	 * Optional gist-substitution hook. Called once immediately before each
	 * `agent.prompt(batch)` with the final prompt string.
	 */
	resolveGists?(batch: string): Promise<string>;
	/** Optional renderer for primary thinking block bodies before they reach the advisor. */
	renderThinking?: (text: string) => string;
	/** Stable identity for the live advisor model. Used to restore full transcript rendering after a model switch. */
	getModelIdentity?(): string;
}

/** A request rejection that no retry can correct for this advisor configuration. */
function isPermanentAdvisorError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /invalid_request_error|model[_ ]not[_ ]found|is not supported when|does not exist/i.test(message);
}

const ADVISOR_QUARANTINE_PREFIX = "Advisor response quarantined";

/** Signals that an advisor response was discarded before it could become model-visible context. */
export class AdvisorOutputQuarantinedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdvisorOutputQuarantinedError";
	}
}

interface AdvisorOutputHazard {
	label: string;
	pattern: RegExp;
}

const ADVISOR_OUTPUT_ONLY_HAZARDS: readonly AdvisorOutputHazard[] = [
	{ label: "account-deletion claim", pattern: /\buser\b.{0,80}\b(?:deleted|erased)\b.{0,80}\baccount\b/i },
	{
		label: "instruction override",
		pattern: /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/i,
	},
	{
		label: "destructive shell command",
		pattern: /\brm\s+(?=(?:-[a-z]+\s*)*-[a-z]*r[a-z]*)(?=(?:-[a-z]+\s*)*-[a-z]*f[a-z]*)(?:-[a-z]+\s*)+/i,
	},
	{ label: "denial instruction", pattern: /\bdeny\s+(?:this|it|the\s+request)\s+if\s+(?:asked|questioned)\b/i },
];

/**
 * Replaces an advisor assistant turn that requested unavailable tools or generated
 * output-only destructive directives with a sanitized error before dispatch.
 *
 * The agent loop records assistant turns before dispatching tools. Without this
 * pre-dispatch rewrite, an advisor hallucination can leave unrelated text in the
 * advisor transcript even though the action itself never executes.
 */
export function quarantineAdvisorUnsafeOutput(
	message: AssistantMessage,
	availableToolNames: ReadonlySet<string>,
	sourceText = "",
): string | undefined {
	const reasons: string[] = [];
	const unavailableToolNames = new Set<string>();
	const generatedParts: string[] = [];
	for (const block of message.content) {
		// Cursor exec-channel native blocks (bash/read/grep/...) are stamped
		// kCursorExecResolved: they already ran server-side through the
		// advisor-scoped CursorExecHandlers bridge, which rejects ungranted
		// tools in-band ("Tool not available") and lets the model self-correct.
		// Quarantining them would discard the legitimate advise emitted in the
		// same turn (issue #5900). The scoped bridge is the grant gate here, not
		// this pre-dispatch check.
		if (
			block.type === "toolCall" &&
			!availableToolNames.has(block.name) &&
			(block as CursorExecResolvedCarrier)[kCursorExecResolved] !== true
		) {
			unavailableToolNames.add(block.name);
		}
		if (block.type === "toolCall" && block.name === "advise" && typeof block.arguments.note === "string") {
			generatedParts.push(block.arguments.note);
		}
		if (block.type === "text") generatedParts.push(block.text);
	}
	if (unavailableToolNames.size > 0) {
		const names = [...unavailableToolNames].sort();
		const toolLabel = names.length === 1 ? "tool" : "tools";
		reasons.push(`requested unavailable ${toolLabel} ${names.join(", ")}`);
	}

	const generatedText = generatedParts.join("\n");
	if (generatedText) {
		const labels: string[] = [];
		const matchedLabels: string[] = [];
		for (const hazard of ADVISOR_OUTPUT_ONLY_HAZARDS) {
			if (!hazard.pattern.test(generatedText)) continue;
			matchedLabels.push(hazard.label);
			if (!hazard.pattern.test(sourceText)) labels.push(hazard.label);
		}
		if (
			matchedLabels.includes("destructive shell command") &&
			labels.includes("instruction override") &&
			!labels.includes("destructive shell command")
		) {
			labels.push("destructive shell command");
		}
		if (labels.includes("destructive shell command") || labels.length >= 3) {
			reasons.push(`generated output-only destructive directives: ${labels.join(", ")}`);
		}
	}

	if (reasons.length === 0) return undefined;

	const messageText = `${ADVISOR_QUARANTINE_PREFIX}: ${reasons.join("; ")}`;
	message.content = [{ type: "text", text: messageText }];
	message.stopReason = "error";
	message.stopDetails = undefined;
	message.toolCallAbortMessages = undefined;
	message.providerPayload = undefined;
	message.errorMessage = messageText;
	return messageText;
}

/**
 * Builds the provenance text used to decide whether hazardous advisor output was
 * generated by the advisor or came from model-visible primary/tool context.
 */
export function buildAdvisorQuarantineSourceText(currentInput: string, messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	if (currentInput) parts.push(currentInput);
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** Maximum maintain-and-coalesce rounds per drain cycle; later arrivals defer. */
const MAX_COALESCE_ROUNDS = 3;

/**
 * Consecutive quarantined advisor turns tolerated before the failure is surfaced
 * to the host UI. A quarantine discards the advisor's whole turn before dispatch,
 * so its advice never reaches the primary; one silent re-prime is allowed to
 * recover a one-off hallucination, but a persistent quarantine loop is a real
 * supervision gap the user must see (issue #6661). Reset on any successful turn.
 */
const MAX_QUARANTINE_RETRIES = 2;

/** A queued advisor session-update delta (one or more coalesced primary turns). */
const ADVISOR_RENDER_OPTIONS = {
	includeToolIntent: true,
	watchedRoles: true,
	expandPrimaryContext: true,
	expandEditDiffs: true,
} as const;
interface PendingDelta {
	kind: "delta";
	text: string;
	rawMessages: AgentMessage[];
	renderRevision: number;
	turns: number;
	fallbackAttempted?: boolean;
	/** Whether the primary was mid-turn (willContinue:true) when this delta was rendered. */
	wip: boolean;
	overflowRecovery?: boolean;
}

/** One actual advisor model prompt attempt for a blocking consult. */
export interface AdvisorConsultAttempt {
	attempt: number;
	error?: string;
}

/**
 * Discriminated settlement of a blocking consult. Every variant carries the
 * per-prompt attempt history so callers can report exactly what happened.
 */
export type AdvisorConsultResult =
	| { status: "answered"; answer: string; attempts: readonly AdvisorConsultAttempt[] }
	| { status: "unavailable"; attempts: readonly AdvisorConsultAttempt[] }
	| { status: "paused"; attempts: readonly AdvisorConsultAttempt[] }
	| { status: "disposed"; attempts: readonly AdvisorConsultAttempt[] }
	| { status: "aborted"; attempts: readonly AdvisorConsultAttempt[] }
	| { status: "timed_out"; attempts: readonly AdvisorConsultAttempt[]; elapsedMs: number; timeoutMs: number }
	| { status: "queue_cleared"; attempts: readonly AdvisorConsultAttempt[]; reason: string }
	| { status: "rate_limited"; attempts: readonly AdvisorConsultAttempt[]; error: string; requeued: true }
	| { status: "provider_error"; attempts: readonly AdvisorConsultAttempt[]; error: string; retryable: boolean }
	| { status: "empty_response"; attempts: readonly AdvisorConsultAttempt[] };

function consultErrorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function snapshotConsultAttempts(attempts: readonly AdvisorConsultAttempt[]): AdvisorConsultAttempt[] {
	return attempts.map(({ attempt, error }) => (error === undefined ? { attempt } : { attempt, error }));
}

/**
 * A queued "phone a friend" consultation. Carries its own `resolve` so the
 * primary agent (blocked in the consult tool) is answered exactly once —
 * whichever settles first (answer, timeout, abort, disposal/reset) wins.
 */
interface PendingConsult {
	kind: "consult";
	question: string;
	turns: 0;
	epoch: number;
	resolve: (result: AdvisorConsultResult) => void;
	attempts: AdvisorConsultAttempt[];
	/** Abort/timeout settled this consult; the drain loop must never requeue or retry it. */
	terminated?: boolean;
	fallbackAttempted?: boolean;
	overflowRecovery?: boolean;
	async?: boolean;
}

interface CatchupWaiter {
	threshold: number;
	finish: (caughtUp: boolean) => void;
	timer?: NodeJS.Timeout;
}

type PendingItem = PendingDelta | PendingConsult;

interface DeliveredMessage {
	message: AgentMessage;
	fingerprint: bigint | undefined;
}

function fingerprintMessage(message: AgentMessage): bigint | undefined {
	try {
		const serialized = JSON.stringify(message);
		return serialized === undefined ? undefined : Bun.hash.wyhash(serialized);
	} catch {
		return undefined;
	}
}

export interface AdvisorRuntimeOptions {
	fallbackModel?: Model;
	escalationModel?: Model;
	normalThinkingLevel?: Effort;
	normalDisableReasoning?: boolean;
	escalationThinkingLevel?: Effort;
	escalationDisableReasoning?: boolean;
}

// Blocking consult ceiling: the advisor is a strong, slow model; the consult tool is interruptible so a generous wait is safe.
const BLOCKING_CONSULT_TIMEOUT_MS = 300_000;

const MIN_FABLE_ADVISOR_IMAGE_TOKENS = 3000;
const FABLE_ADVISOR_IMAGE_SAVINGS_MARGIN = 0.9;
const CONSULTATION_HEADING_PATTERN = /\n\n### Consultation request(?: \(async\))?\n/;

interface AdvisorPromptPayload {
	text: string;
	images?: ImageContent[];
	estimatedTokens?: number;
}

function isFableVisionAdvisorModel(model: Model | undefined): model is Model {
	if (!model?.input.includes("image")) return false;
	const id = model.id.toLowerCase();
	const name = model.name.toLowerCase();
	return id.includes("fable") || name.includes("fable");
}

function splitAdvisorImageMaterial(batch: string): { imageMaterial: string; preservedText: string } {
	const match = CONSULTATION_HEADING_PATTERN.exec(batch);
	if (!match) return { imageMaterial: batch, preservedText: "" };
	return {
		imageMaterial: batch.slice(0, match.index).trimEnd(),
		preservedText: batch.slice(match.index).trimStart(),
	};
}

function passesFableAdvisorImageGate(text: string, model: Model, shape: snapcompact.Shape): boolean {
	const textTokens = countTokens(text);
	if (textTokens < MIN_FABLE_ADVISOR_IMAGE_TOKENS) return false;
	const frameCount = snapcompact.frames(text, { shape });
	if (frameCount <= 0) return false;
	if (frameCount > snapcompact.providerImageBudget(model.provider)) return false;
	return frameCount * shape.frameTokenEstimate <= textTokens * FABLE_ADVISOR_IMAGE_SAVINGS_MARGIN;
}

async function prepareFableAdvisorPromptPayload(batch: string, model: Model): Promise<AdvisorPromptPayload> {
	try {
		const { imageMaterial, preservedText } = splitAdvisorImageMaterial(batch);
		if (!imageMaterial.trim()) return { text: batch };
		const shape = snapcompact.resolveShape(model);
		if (!passesFableAdvisorImageGate(imageMaterial, model, shape)) return { text: batch };
		const frames = await snapcompact.renderMany(imageMaterial, {
			shape,
			maxFrames: snapcompact.providerImageBudget(model.provider),
		});
		if (frames.length === 0) return { text: batch };
		const note = prompt.render(fableNormalMessageFramesNote).trim();
		const text = preservedText ? `${note}\n\n${preservedText}` : note;
		return {
			text,
			images: frames,
			estimatedTokens: countTokens(text) + frames.length * shape.frameTokenEstimate,
		};
	} catch (err) {
		logger.debug("advisor Fable message imaging failed; falling back to text", { err: String(err) });
		return { text: batch };
	}
}

function getSafeguardRefusalMessage(err: unknown, seen = new Set<unknown>()): string | undefined {
	if (err === null || err === undefined || seen.has(err)) return undefined;
	seen.add(err);
	if (typeof err === "string") return err;
	if (typeof err !== "object") return undefined;
	const message = "message" in err && typeof err.message === "string" ? err.message : undefined;
	if (message && (message === "Content flagged by safety filters" || /^Refusal\b/.test(message))) return message;
	return "cause" in err ? (getSafeguardRefusalMessage(err.cause, seen) ?? message) : message;
}

export function isSafeguardRefusal(err: unknown): boolean {
	const message = getSafeguardRefusalMessage(err);
	return message === "Content flagged by safety filters" || /^Refusal\b/.test(message ?? "");
}
export class AdvisorRuntime {
	#lastCount = 0;
	/**
	 * Delivered prefix identities. References make the normal append-only path
	 * allocation-free; fingerprints preserve identity across equivalent clones.
	 */
	#deliveredPrefix: DeliveredMessage[] = [];
	/** Last-shown body, keyed by primary-context customType (plan/goal mode rules,
	 *  approved plan). These prompts are re-injected verbatim every primary turn;
	 *  this lets {@link #renderDelta} collapse an unchanged copy to a one-line
	 *  marker so the advisor isn't re-fed the full ~1k-token rules each turn.
	 *  Cleared on every re-prime/seed and when a failed batch is dropped. */
	#seenContext = new Map<string, string>();
	/** Incremented after re-prime so queued raw deltas can be rendered against fresh dedupe state. */
	#renderRevision = 0;
	/** Regex secret values observed in primary deltas and retained until advisor context resets. */
	#advisorRegexSecretValues = new Set<string>();
	#pending: PendingItem[] = [];
	#busy = false;
	#paused = false;
	#sessionTransitionPaused = false;
	#promptInFlight: Promise<void> | undefined;
	#iterationAbort: AbortController | undefined;
	#backlog = 0;
	#consecutiveFailures = 0;
	#failureNotified = false;
	#primeSeedPending = true;
	/** Consecutive quarantined turns since the last success/reset (issue #6661). */
	#consecutiveQuarantines = 0;
	/**
	 * Model identities this refusal cascade has already tried. The cascade walks
	 * the fallback chain to exhaustion — that is what the chain is for — but
	 * visits each model at most once, so a chain whose keys point back at each
	 * other (A→B, B→A) cannot ping-pong forever. Cleared when a successful or
	 * terminal turn ends the cascade, or on reset, so a later refusal starts fresh.
	 */
	readonly #refusalModelsTried = new Set<string>();
	/** Whether primary reasoning is included in advisor deltas for the current model. */
	#includeThinking = true;
	#modelIdentity: string | undefined;
	/** Completed 3-failure backlog-drop cycles since the last success/reset. */
	#droppedBacklogs = 0;
	/** Stop retrying after repeated dropped backlogs or a permanent request rejection. */
	#halted = false;
	/** A failure releases catch-up waiters until a later turn succeeds. */
	#failing = false;
	#latestMessages?: AgentMessage[];
	#waiters: CatchupWaiter[] = [];
	#primaryModel?: Model;
	#fallbackModel?: Model;
	#onFallbackModel = false;
	#escalationModel?: Model;
	#normalThinkingLevel?: Effort;
	#normalDisableReasoning?: boolean;
	#escalationThinkingLevel?: Effort;
	#escalationDisableReasoning?: boolean;
	#fallbackRetryItemCount = 0;
	/** Bumped by every external {@link reset}/{@link dispose}. A drain iteration
	 *  captures it before its awaits; a mismatch on resume means a reset aborted
	 *  the in-flight advisor prompt, so the stale batch is dropped instead of
	 *  being retried/requeued into the post-reset conversation. */
	#epoch = 0;
	disposed = false;
	/** Quota/rate-limit pause state. When `true`, the advisor stops processing
	 *  turns and drops new deltas until an explicit {@link reset} clears it
	 *  (triggered by `/new`, config rebuild, or session restart). There is no
	 *  timer-based auto-resume: provider quota windows (5h/7d) are far longer
	 *  than any reasonable timer, and premature retries waste calls and
	 *  re-trigger the same error. */
	#quotaExhausted = false;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
		private readonly retryDelayMs = 1000,
		options: AdvisorRuntimeOptions = {},
	) {
		this.#primaryModel = agent.model;
		this.#fallbackModel = options.fallbackModel;
		this.#escalationModel = options.escalationModel;
		this.#normalThinkingLevel = options.normalThinkingLevel;
		this.#normalDisableReasoning = options.normalDisableReasoning;
		this.#escalationThinkingLevel = options.escalationThinkingLevel;
		this.#escalationDisableReasoning = options.escalationDisableReasoning;
	}

	#switchToEscalationModel(): (() => void) | undefined {
		const escalationModel = this.#escalationModel;
		if (!escalationModel) return undefined;
		const normalModel = this.agent.model;
		const normalDisableReasoning = this.agent.disableReasoning ?? this.#normalDisableReasoning ?? false;
		const restoreDisableReasoning =
			this.#normalDisableReasoning !== undefined || this.#escalationDisableReasoning !== undefined;
		this.agent.setModel?.(escalationModel);
		this.agent.setThinkingLevel?.(this.#escalationThinkingLevel);
		if (this.#escalationDisableReasoning !== undefined) {
			this.agent.setDisableReasoning?.(this.#escalationDisableReasoning);
		}
		return () => {
			if (normalModel) this.agent.setModel?.(normalModel);
			this.agent.setThinkingLevel?.(this.#normalThinkingLevel);
			if (restoreDisableReasoning) {
				this.agent.setDisableReasoning?.(normalDisableReasoning);
			}
		};
	}

	get backlog(): number {
		return this.#backlog;
	}
	get quotaExhausted(): boolean {
		return this.#quotaExhausted;
	}
	get failureNotified(): boolean {
		return this.#failureNotified;
	}
	/** True after the runtime hard-stopped on repeated or permanent failures. */
	get halted(): boolean {
		return this.#halted;
	}

	get paused(): boolean {
		return this.#paused;
	}

	/**
	 * True when `#pending` is non-empty while the drain loop is busy — i.e., newer

	 * primary turns arrived after the current batch's transcript window was fixed
	 * but before the advisor model finished processing it. The delivery path uses
	 * this to annotate advice that was generated without seeing those newer turns.
	 */
	get hasFreshBacklog(): boolean {
		return this.#busy && this.#pending.length > 0;
	}

	#createPendingDelta(text: string, turns: number, wip: boolean, rawMessages: AgentMessage[] = []): PendingDelta {
		return { kind: "delta", text, rawMessages, renderRevision: this.#renderRevision, turns, wip };
	}

	pause(): void {
		this.#paused = true;
	}

	resume(): void {
		this.#paused = false;
		void this.#drain();
	}
	onUserPrompt(text: string): void {
		if (this.disposed || this.#paused || text.trim().length === 0) return;
		this.#pending.push(this.#createPendingDelta(prompt.render(promptReviewTemplate, { text }), 0, false));
		void this.#drain();
	}

	/**
	 * Called after each primary turn ends. Renders the incremental delta and
	 * queues it for the advisor model. `willContinue` marks a tool-in-progress
	 * update so the advisor does not critique partial work as terminal output.
	 */
	onTurnEnd(messages?: AgentMessage[], opts?: { willContinue?: boolean }): void {
		if (this.disposed || this.#quotaExhausted || this.#halted) return;
		const all = messages ?? this.host.snapshotMessages();
		this.#latestMessages = all;
		const wip = opts?.willContinue ?? false;
		const cursorBefore = this.#lastCount;
		const prefixBefore = this.#deliveredPrefix.slice();
		const seenBefore = [...this.#seenContext];
		try {
			const pending = this.#renderPendingDelta(all, 1, wip);
			if (!pending) return;
			this.#pending.push(pending);
			this.#backlog++;
			this.#notifyWaiters();
			void this.#drain();
		} catch (err) {
			// A malformed transcript must never break the primary turn or advance
			// this cursor: a replacement message can be rendered on the next turn.
			this.#lastCount = cursorBefore;
			this.#deliveredPrefix = prefixBefore;
			this.#seenContext.clear();
			for (const [key, value] of seenBefore) this.#seenContext.set(key, value);
			this.#failing = true;
			this.#wakeAllWaiters();
			logger.warn("advisor delta render failed", { err: String(err) });
		}
	}

	/**
	 * "Phone a friend": ask the advisor a question mid-turn and block until it
	 * settles. Always resolves with a discriminated {@link AdvisorConsultResult}
	 * carrying the per-prompt attempt history — `answered` on success, otherwise
	 * the precise failure cause. Renders a fresh mid-turn delta first so the
	 * advisor sees current context alongside the question, then enqueues the
	 * consult and drains. Abort and timeout are terminal for the consult: it is
	 * removed from the queue and never retried.
	 */
	consult(question: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<AdvisorConsultResult> {
		if (this.disposed) return Promise.resolve({ status: "disposed", attempts: [] });
		if (this.#paused) return Promise.resolve({ status: "paused", attempts: [] });

		// Render a fresh mid-turn delta so the advisor sees everything up to the
		// current (possibly still-streaming) point before the question. `turns: 0`
		// because the enclosing primary turn is counted by its own later
		// `onTurnEnd`; adding turns here would double-count the backlog.
		const snapshot = this.host.snapshotMessages();
		const pending = this.#renderPendingDelta(snapshot, 0, true);
		if (pending) {
			this.#pending.push(pending);
		}
		// Point `#latestMessages` at this snapshot so a mid-consult re-prime
		// (`#renderDelta(this.#latestMessages)`) renders current context rather
		// than a stale transcript.
		this.#latestMessages = snapshot;

		const { promise, resolve } = Promise.withResolvers<AdvisorConsultResult>();
		let settled = false;
		const signal = opts?.signal;
		let timer: NodeJS.Timeout | undefined;
		// First resolution wins; later ones (a late model answer racing a timeout,
		// or a reset that already resolved the item) are no-ops.
		const settle = (result: AdvisorConsultResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const item: PendingConsult = {
			kind: "consult",
			question,
			turns: 0,
			epoch: this.#epoch,
			attempts: [],
			resolve: settle,
		};
		// Abort/timeout are terminal for THIS consult: mark it so the drain loop
		// never requeues/retries it, and drop it from the queue if still waiting.
		const terminate = (result: AdvisorConsultResult): void => {
			item.terminated = true;
			this.#pending = this.#pending.filter(p => p !== item);
			settle(result);
		};
		const onAbort = (): void => {
			terminate({ status: "aborted", attempts: snapshotConsultAttempts(item.attempts) });
		};

		this.#pending.push(item);
		void this.#drain();

		const timeoutMs = opts?.timeoutMs ?? BLOCKING_CONSULT_TIMEOUT_MS;
		const startedAt = Date.now();
		timer = setTimeout(
			() =>
				terminate({
					status: "timed_out",
					attempts: snapshotConsultAttempts(item.attempts),
					elapsedMs: Date.now() - startedAt,
					timeoutMs,
				}),
			timeoutMs,
		);
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		return promise;
	}

	/**
	 * Background consult: enqueue the same fresh-context question but let the
	 * advisor answer later through its `advise` tool instead of a promise result.
	 */
	consultAsync(question: string): void {
		if (this.disposed || this.#paused) return;

		// Keep async consult context parity with blocking consults without counting
		// the still-running primary turn as a completed backlog turn.
		const snapshot = this.host.snapshotMessages();
		const pending = this.#renderPendingDelta(snapshot, 0, true);
		if (pending) {
			this.#pending.push(pending);
		}
		this.#latestMessages = snapshot;

		this.#pending.push({
			kind: "consult",
			question,
			async: true,
			turns: 0,
			epoch: this.#epoch,
			attempts: [],
			resolve: () => {},
		});
		void this.#drain();
	}

	#lastClearReason = "reset";
	/** The consult currently being prompted (popped off `#pending`), so an
	 *  external reset/dispose can settle it instead of letting it outlive the
	 *  epoch until its own timer fires. */
	#inFlightConsult?: PendingConsult;

	/** Terminal result for a consult invalidated by a queue clear / epoch bump. */
	#clearedResult(attempts: readonly AdvisorConsultAttempt[]): AdvisorConsultResult {
		const snapshot = snapshotConsultAttempts(attempts);
		return this.#lastClearReason === "dispose"
			? { status: "disposed", attempts: snapshot }
			: { status: "queue_cleared", attempts: snapshot, reason: this.#lastClearReason };
	}

	/**
	 * Route every `#pending` clear through here so an orphaned consult never
	 * leaves the primary agent hanging: settle every queued consult with a
	 * terminal `disposed`/`queue_cleared` result before dropping the queue.
	 */
	#clearPending(reason: string): void {
		this.#lastClearReason = reason;
		if (this.#pending.length) {
			for (const item of this.#pending) {
				if (item.kind === "consult") {
					try {
						item.resolve(this.#clearedResult(item.attempts));
					} catch (err) {
						logger.debug("advisor consult resolve failed during clear", { reason, err: String(err) });
					}
				}
			}
		}
		this.#pending = [];
	}

	/**
	 * Wait until the advisor backlog falls below `threshold`.
	 *
	 * Returns `false` when the deadline, abort signal, or a runtime failure releases
	 * the waiter before the requested backlog was drained.
	 */
	waitForCatchup(maxMs: number, threshold: number, signal?: AbortSignal): Promise<boolean> {
		if (
			this.disposed ||
			signal?.aborted ||
			this.#backlog < threshold ||
			this.#quotaExhausted ||
			this.#halted ||
			// An advisor mid-failure/retry must NEVER gate the primary agent:
			// its backlog cannot drain until the retry cycle resolves, and the
			// primary would otherwise park for the full catch-up budget.
			this.#failing
		)
			return Promise.resolve(this.#backlog < threshold);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let waiter!: CatchupWaiter;
		const finish = (caughtUp: boolean): void => {
			const idx = this.#waiters.indexOf(waiter);
			if (idx >= 0) this.#waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			signal?.removeEventListener("abort", abort);
			resolve(caughtUp);
		};
		const abort = (): void => finish(false);
		waiter = {
			threshold,
			finish,
			timer: setTimeout(abort, maxMs),
		};
		this.#waiters.push(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
		}
		return promise;
	}

	dispose(): void {
		this.#iterationAbort?.abort("advisor disposed");
		this.disposed = true;
		this.#epoch++;
		this.#clearPending("dispose");
		if (this.#inFlightConsult) {
			this.#inFlightConsult.resolve(this.#clearedResult(this.#inFlightConsult.attempts));
			this.#inFlightConsult = undefined;
		}
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#advisorRegexSecretValues.clear();
		this.#wakeAllWaiters();
		try {
			this.agent.abort("advisor disposed");
		} catch {}
	}

	#resetAdvisorContext(clearBacklog: boolean, wakeWaiters: boolean): void {
		this.#lastCount = 0;
		this.#clearPending("reset");
		this.#consecutiveFailures = 0;
		if (this.#onFallbackModel) {
			this.#restorePrimaryModel();
		}
		this.#fallbackRetryItemCount = 0;
		this.#clearContextReplayState();
		if (clearBacklog) {
			this.#backlog = 0;
		}
		if (wakeWaiters) {
			this.#wakeAllWaiters();
		}
		try {
			this.agent.reset();
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	#clearContextReplayState(): void {
		this.#deliveredPrefix = [];
		this.#seenContext.clear();
		this.#advisorRegexSecretValues.clear();
		this.#renderRevision++;
		// The next rendered full-context replay is the host's chance to re-seed
		// the advisor from durable brief state without this runtime reading files.
		this.#primeSeedPending = true;
	}

	#invalidateRenderedContext(): void {
		this.#seenContext.clear();
		this.#advisorRegexSecretValues.clear();
		this.#renderRevision++;
		this.#primeSeedPending = true;
	}

	/** Clear only the advisor's private conversation. Primary cursor and queued
	 * deltas stay intact so maintenance/overflow recovery never replays history. */
	#clearAdvisorContextAtCurrentCursor(): void {
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#invalidateRenderedContext();
		try {
			this.agent.reset();
		} catch {}
		try {
			this.agent.abort("advisor reset");
		} catch {}
	}

	#formatDeltaMarkdown(delta: AgentMessage[]): string | null {
		const obfuscator = this.host.obfuscator;
		let md = formatSessionHistoryMarkdown(delta, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: this.#includeThinking,
			renderThinking: this.host.renderThinking,
			errorResultLines: 10,
			expandAsyncResults: true,
		});
		if (!md.trim()) return null;
		if (!obfuscator?.hasSecrets()) return md;

		let discoveredNewRegexSecretValue = false;
		const addRegexValues = (text: string): void => {
			for (const secretValue of obfuscator.collectRegexSecretValuesForObfuscation(text)) {
				if (this.#advisorRegexSecretValues.has(secretValue)) continue;
				this.#advisorRegexSecretValues.add(secretValue);
				discoveredNewRegexSecretValue = true;
			}
		};
		for (const message of delta) {
			if (
				message.role === "custom" &&
				PRIMARY_CONTEXT_CUSTOM_TYPES.has(message.customType) &&
				typeof message.content === "string"
			) {
				addRegexValues(message.content);
			}
		}
		addRegexValues(md);
		scrubAdvisorHistory(obfuscator, this.agent.state.messages, this.#advisorRegexSecretValues);
		if (discoveredNewRegexSecretValue) {
			this.#pending = this.#pending.map(item =>
				item.kind === "delta"
					? {
							...item,
							text: obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(item.text, this.#advisorRegexSecretValues),
						}
					: item,
			);
		}
		md = formatSessionHistoryMarkdown(
			delta.map(message =>
				message.role === "custom" && PRIMARY_CONTEXT_CUSTOM_TYPES.has(message.customType)
					? obfuscateAdvisorMessage(obfuscator, message, this.#advisorRegexSecretValues)
					: message,
			),
			{
				...ADVISOR_RENDER_OPTIONS,
				includeThinking: this.#includeThinking,
				renderThinking: this.host.renderThinking,
				errorResultLines: 10,
				expandAsyncResults: true,
			},
		);
		return obfuscator.obfuscate(md, this.#advisorRegexSecretValues);
	}

	#formatRawDelta(rawMessages: readonly AgentMessage[], wip: boolean): string | null {
		const delta = rawMessages
			.filter(message => !(message.role === "custom" && message.customType === "advisor"))
			.map(message => this.#dedupContextMessage(message));
		if (delta.length === 0) return null;
		const md = this.#formatDeltaMarkdown(delta);
		if (!md) return null;
		const statsHeader = this.host.renderStatsHeader?.()?.trim();
		const seed = this.#takePrimeSeed();
		const heading = wip ? "### Session update [in progress — more steps follow]" : "### Session update";
		const sessionUpdate = `${heading}\n\n${md}`;
		const withSeed = seed ? `${sessionUpdate}\n\n${seed}` : sessionUpdate;
		return statsHeader ? `${statsHeader}\n\n${withSeed}` : withSeed;
	}

	/** Stop new advisor work and wait only for the active prompt's recorder-visible events. */
	pauseForSessionTransition(): Promise<void> {
		if (!this.#sessionTransitionPaused) {
			this.#sessionTransitionPaused = true;
			this.#wakeAllWaiters();
			this.#iterationAbort?.abort("advisor session transition");
			try {
				this.agent.abort("advisor session transition");
			} catch {}
		}
		return (
			this.#promptInFlight?.then(
				() => {},
				() => {},
			) ?? Promise.resolve()
		);
	}

	/** Continue queued work after a session transition rolls back or preserves the conversation. */
	resumeAfterSessionTransition(): void {
		if (!this.#sessionTransitionPaused) return;
		this.#sessionTransitionPaused = false;
		if (!this.#quotaExhausted && !this.#halted) void this.#drain();
	}

	/**
	 * Re-prime the advisor after a history rewrite (compaction, session
	 * switch/resume, branch). Clears the advisor's own (non-persisted) context
	 * and rewinds the cursor to 0 so the NEXT turn replays the full current —
	 * post-compaction — transcript, giving the advisor fresh context instead of
	 * leaving it blind to everything before the rewrite.
	 */
	reset(): void {
		this.#iterationAbort?.abort("advisor reset");
		this.#epoch++;
		this.#sessionTransitionPaused = false;
		this.#quotaExhausted = false;
		this.#halted = false;
		this.#failing = false;
		this.#droppedBacklogs = 0;
		this.#consecutiveQuarantines = 0;
		this.#refusalModelsTried.clear();
		this.#failureNotified = false;
		this.#resetAdvisorContext(true, true);
		if (this.#inFlightConsult) {
			this.#inFlightConsult.resolve(this.#clearedResult(this.#inFlightConsult.attempts));
			this.#inFlightConsult = undefined;
		}
	}

	/**
	 * Seed the cursor to the current transcript length when the advisor is enabled
	 * mid-session. Prevents the next turn from replaying the entire history to the
	 * advisor (which would be expensive and likely stale).
	 */
	seedTo(count: number): void {
		this.#clearPending("seedTo");
		this.#clearContextReplayState();
		const messages = this.host.snapshotMessages().slice(0, count);
		this.#lastCount = messages.length;
		this.#deliveredPrefix = messages.map(message => ({ message, fingerprint: fingerprintMessage(message) }));
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failing = false;
		this.#droppedBacklogs = 0;
		this.#failureNotified = false;
		this.#wakeAllWaiters();
	}

	/**
	 * Align the delivered-prefix cursor after a semantics-preserving primary
	 * history rewrite without clearing the advisor's private conversation.
	 *
	 * Automatic pruning replaces already-delivered message objects to shrink the
	 * primary prompt. Replaying that rewritten transcript would duplicate context
	 * the advisor already saw and can turn frequent pruning into unbounded prompt
	 * persistence. Pending updates and advisor-local dedupe state intentionally
	 * remain intact.
	 */
	rebaseToCurrentTranscript(): void {
		if (this.disposed) return;
		const messages = this.host.snapshotMessages();
		this.#latestMessages = messages;
		const last = messages.at(-1);
		const effectiveEnd =
			last?.role === "assistant" && last.stopReason === undefined ? messages.length - 1 : messages.length;
		this.#lastCount = effectiveEnd;
		this.#deliveredPrefix = messages
			.slice(0, effectiveEnd)
			.map(message => ({ message, fingerprint: fingerprintMessage(message) }));
	}

	#syncModelIdentity(): void {
		const identity = this.host.getModelIdentity?.();
		if (identity === undefined || identity === this.#modelIdentity) return;
		this.#modelIdentity = identity;
		this.#includeThinking = true;
	}

	#renderPendingDelta(messages: AgentMessage[], turns: number, wip: boolean): PendingDelta | null {
		const cursorBefore = this.#lastCount;
		const revisionBefore = this.#renderRevision;
		const text = this.#renderDelta(messages, wip);
		if (!text) return null;
		const rawStart = revisionBefore === this.#renderRevision ? cursorBefore : 0;
		const rawMessages = messages
			.slice(rawStart, this.#lastCount)
			.filter(message => message.role !== "custom" || message.customType !== "advisor");
		return this.#createPendingDelta(text, turns, wip, rawMessages);
	}

	#renderDelta(messages?: AgentMessage[], wip = false): string | null {
		const all = messages ?? this.#latestMessages ?? this.host.snapshotMessages();
		const transcriptShrank = all.length < this.#lastCount;
		let prefixChanged = transcriptShrank;
		for (let index = 0; !prefixChanged && index < this.#lastCount; index++) {
			const delivered = this.#deliveredPrefix[index];
			const current = all[index];
			if (delivered === undefined || current === undefined) {
				prefixChanged = true;
				break;
			}
			if (delivered.message !== current && delivered.fingerprint !== fingerprintMessage(current)) {
				prefixChanged = true;
			} else {
				delivered.message = current;
			}
		}
		if (prefixChanged) {
			this.#resetAdvisorContext(true, true);
			// A compaction may temporarily expose only a truncated prefix. Wait
			// for its explicit reset/reprime instead of sending stale history.
			if (transcriptShrank) return null;
		}
		// An assistant message without a stop reason is still streaming. Never
		// advance past it: the provider may mutate the same object in place when
		// the turn completes, and an advanced cursor would lose the final content.
		let effectiveEnd = all.length;
		const last = all[all.length - 1];
		if (last?.role === "assistant" && last.stopReason === undefined) {
			effectiveEnd = all.length - 1;
		}
		const firstUnseen = this.#lastCount;
		const delta = all
			.slice(firstUnseen, effectiveEnd)
			.filter(m => m.role !== "custom" || m.customType !== "advisor")
			.map(m => this.#dedupContextMessage(m));
		for (let index = firstUnseen; index < effectiveEnd; index++) {
			const message = all[index];
			if (message) this.#deliveredPrefix.push({ message, fingerprint: fingerprintMessage(message) });
		}
		this.#lastCount = effectiveEnd;
		if (delta.length === 0) return null;
		const md = this.#formatDeltaMarkdown(delta);
		if (!md) return null;
		const statsHeader = this.host.renderStatsHeader?.()?.trim();
		const seed = this.#takePrimeSeed();
		const heading = wip ? "### Session update [in progress — more steps follow]" : "### Session update";
		const sessionUpdate = `${heading}\n\n${md}`;
		const withSeed = seed ? `${sessionUpdate}\n\n${seed}` : sessionUpdate;
		return statsHeader ? `${statsHeader}\n\n${withSeed}` : withSeed;
	}

	#takePrimeSeed(): string | undefined {
		if (!this.#primeSeedPending) return undefined;
		this.#primeSeedPending = false;
		const seed = this.host.renderPrimeSeed?.()?.trim();
		return seed || undefined;
	}

	/**
	 * Collapse a re-injected primary-context prompt (plan/goal mode rules, the
	 * approved plan) to a short marker when its body is byte-identical to the
	 * copy already shown to the advisor since the last re-prime. The primary
	 * re-injects these verbatim every turn; without this the advisor re-reads the
	 * full rules (~1k tokens) each turn. Returns a CLONE when collapsing — the
	 * input shares the live primary transcript and must never be mutated.
	 */
	#dedupContextMessage(msg: AgentMessage): AgentMessage {
		if (msg.role !== "custom") return msg;
		const customType = msg.customType;
		if (
			typeof customType !== "string" ||
			(customType !== "advisor-brief-context" &&
				customType !== "advisor-state-context" &&
				!PRIMARY_CONTEXT_CUSTOM_TYPES.has(customType))
		) {
			return msg;
		}
		const { content } = msg;
		if (typeof content !== "string") return msg;
		if (this.#seenContext.get(customType) === content) {
			return { ...msg, content: "(unchanged — still in effect)" };
		}
		this.#seenContext.set(customType, content);
		return msg;
	}

	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.#backlog < w.threshold) {
				w.finish(true);
			}
		}
	}

	#wakeAllWaiters(): void {
		for (const w of [...this.#waiters]) {
			w.finish(false);
		}
	}

	/**
	 * Drop the user batch + synthetic assistant-error turn `Agent.#runLoop`
	 * appended for a failed prompt so a retry replays a clean baseline and the
	 * dropped-after-3 path never leaks orphan failures into the next successful
	 * run. Prefers the agent's own `rollbackTo` (which also re-syncs its
	 * append-only context); falls back to truncating `state.messages` for tests
	 * that hand-roll a minimal facade.
	 */
	#rollbackFailedTurn(snapshot: number): void {
		const messages = this.agent.state.messages;
		if (messages.length <= snapshot) return;
		try {
			if (this.agent.rollbackTo) {
				this.agent.rollbackTo(snapshot);
				return;
			}
			messages.length = snapshot;
		} catch (err) {
			logger.debug("advisor rollback failed", { err: String(err) });
		}
	}

	/**
	 * Extract a consultation answer from the advisor turns appended past
	 * `snapshot`. The advisor may make read/grep tool calls (multiple assistant
	 * messages) and the final message may be thinking-only, so scan BACKWARDS for
	 * the last assistant message carrying at least one non-empty text block and
	 * join its text blocks. Returns `null` when no textual answer was produced.
	 */
	#extractConsultAnswer(snapshot: number): string | null {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= snapshot; i--) {
			const msg = messages[i];
			if (msg.role !== "assistant") continue;
			const texts = (msg as AssistantMessage).content
				.filter((b): b is TextContent => b.type === "text" && b.text.trim().length > 0)
				.map(b => b.text);
			if (texts.length > 0) return texts.join("\n");
		}
		return null;
	}

	/**
	 * Detect whether an async consult was already delivered via the advisor's
	 * tool channel. pi-ai ToolCall blocks use discriminant `type: "toolCall"`
	 * with a top-level `name` field (verified in node_modules/@oh-my-pi/pi-ai/src/types.ts).
	 */
	#advisorCalledAdviseSince(snapshot: number): boolean {
		for (const msg of this.agent.state.messages.slice(snapshot)) {
			if (msg.role !== "assistant") continue;
			if ((msg as AssistantMessage).content.some(block => block.type === "toolCall" && block.name === "advise")) {
				return true;
			}
		}
		return false;
	}

	/** Surface an advisor failure to the host at most once until the next reset (issue #6661). */
	#notifyFailureOnce(error: unknown): void {
		if (this.#failureNotified) return;
		this.#failureNotified = true;
		try {
			this.host.notifyFailure?.(error);
		} catch (notifyErr) {
			logger.warn("advisor failure notification failed", { err: String(notifyErr) });
		}
	}

	async #invokeTurnError(
		error: unknown,
		failedMessages: readonly AgentMessage[],
		signal: AbortSignal,
	): Promise<boolean> {
		const handler = this.host.onTurnError;
		if (!handler) return false;
		const result =
			handler.length === 2 || handler.length >= 4
				? handler(error, this.agent.model, failedMessages, signal)
				: (
						handler as unknown as (
							error: unknown,
							failedMessages: readonly AgentMessage[],
							signal: AbortSignal,
						) => Promise<boolean | undefined> | boolean | undefined
					)(error, failedMessages, signal);
		return (await raceWithSignal(Promise.resolve(result), signal)) === true;
	}

	async #drain(): Promise<void> {
		if (this.#paused || this.#busy || this.#sessionTransitionPaused) return;
		this.#busy = true;
		try {
			this.#syncModelIdentity();
			while (!this.#paused && !this.disposed && !this.#sessionTransitionPaused && this.#pending.length) {
				this.#syncModelIdentity();
				if (this.#onFallbackModel && this.#fallbackRetryItemCount === 0) {
					this.#restorePrimaryModel();
				}
				const fallbackRetryItemCount = this.#fallbackRetryItemCount;
				this.#fallbackRetryItemCount = 0;
				const epoch = this.#epoch;
				const iterationAbort = new AbortController();
				this.#iterationAbort = iterationAbort;
				// Chunk at the first consult boundary: coalesce the leading deltas,
				// attach at most ONE consult so its answer maps to a single prompt;
				// anything queued after that consult goes back to the FRONT (order
				// preserved) for the next loop iteration.
				const retryOnly = fallbackRetryItemCount > 0 || this.#pending[0]?.overflowRecovery === true;
				const popped = retryOnly ? this.#pending.splice(0, fallbackRetryItemCount || 1) : this.#pending.splice(0);
				const deltaItems: PendingDelta[] = [];
				let consult: PendingConsult | undefined;
				let cut = popped.length;
				for (let i = 0; i < popped.length; i++) {
					const item = popped[i];
					if (item.kind === "consult") {
						consult = item;
						cut = i + 1;
						break;
					}
					deltaItems.push(item);
				}
				if (cut < popped.length) {
					this.#pending.unshift(...popped.slice(cut));
				}
				this.#inFlightConsult = consult;
				const batchAlreadyUsedFallback = popped.some(item => item.fallbackAttempted);
				const recoveringOverflow = popped.some(item => item.overflowRecovery === true);

				// Each delta already opens with a `### Session update` heading, so
				// join with a blank line rather than a `---` rule. The consultation
				// question stays STRUCTURAL (kept off `deltasText`) so it survives a
				// re-prime and can be re-appended identically for prompt-cache stability.
				for (const item of deltaItems) {
					if (item.renderRevision === this.#renderRevision || item.rawMessages.length === 0) continue;
					item.text = this.#formatRawDelta(item.rawMessages, item.wip) ?? item.text;
					item.renderRevision = this.#renderRevision;
				}
				let deltasText = deltaItems.map(b => b.text).join("\n\n");
				let rawMessages = deltaItems.flatMap(item => item.rawMessages);
				let turnsCovered = deltaItems.reduce((sum, b) => sum + b.turns, 0) + (consult?.turns ?? 0);
				let wip = deltaItems.at(-1)?.wip ?? false;
				const buildBatch = (deltaPart: string): string | null => {
					if (!consult) return deltaPart || null;
					const suffix = prompt.render(
						consult.async ? consultationRequestAsyncTemplate : consultationRequestTemplate,
						{ question: consult.question },
					);
					return deltaPart ? `${deltaPart}\n\n${suffix}` : suffix;
				};
				let restoreEscalation: (() => void) | undefined;
				const restoreEscalationIfNeeded = () => {
					restoreEscalation?.();
					restoreEscalation = undefined;
				};

				let candidatePrepared: { source: string; payload: AdvisorPromptPayload } | undefined;
				let shouldReprime = false;
				let reprimeAfterCoalesce = false;
				let batchInvalidated = false;
				for (let round = 0; round < MAX_COALESCE_ROUNDS; round++) {
					let candidateBatch = buildBatch(deltasText);
					const batchObfuscator = this.host.obfuscator;
					if (candidateBatch !== null && batchObfuscator?.hasSecrets()) {
						candidateBatch = batchObfuscator.stripUnsafeFriendlyPlaceholderPrefixes(
							candidateBatch,
							this.#advisorRegexSecretValues,
						);
					}
					if (candidateBatch !== null) {
						const model = this.agent.model;
						candidatePrepared = {
							source: candidateBatch,
							payload: isFableVisionAdvisorModel(model)
								? await prepareFableAdvisorPromptPayload(candidateBatch, model)
								: { text: candidateBatch },
						};
						if (this.#epoch !== epoch) {
							batchInvalidated = true;
							break;
						}
					}
					const incomingTokens =
						candidatePrepared?.payload.estimatedTokens ??
						estimateTokens({
							role: "user",
							content: candidatePrepared?.payload.text ?? "",
							timestamp: Date.now(),
						});
					if (this.host.maintainContext) {
						try {
							shouldReprime = await this.host.maintainContext(incomingTokens, iterationAbort.signal);
						} catch (err) {
							logger.debug("advisor context maintenance failed", { err: String(err) });
						}
					}
					if (this.#epoch !== epoch) {
						batchInvalidated = true;
						break;
					}
					if (shouldReprime || round === MAX_COALESCE_ROUNDS - 1 || consult || batchAlreadyUsedFallback) break;

					const lateDeltas: PendingDelta[] = [];
					while (this.#pending[0]?.kind === "delta") {
						lateDeltas.push(this.#pending.shift() as PendingDelta);
					}
					if (lateDeltas.length === 0) break;
					reprimeAfterCoalesce = true;
					deltasText = [deltasText, ...lateDeltas.map(item => item.text)].filter(Boolean).join("\n\n");
					rawMessages = rawMessages.concat(lateDeltas.flatMap(item => item.rawMessages));
					turnsCovered += lateDeltas.reduce((sum, item) => sum + item.turns, 0);
					wip = lateDeltas.at(-1)!.wip;
				}
				if (batchInvalidated) {
					restoreEscalationIfNeeded();
					if (consult) consult.resolve(this.#clearedResult(consult.attempts));
					continue;
				}

				let deltaPart: string;
				let finalTurns: number;
				if (shouldReprime && !reprimeAfterCoalesce) {
					this.#clearAdvisorContextAtCurrentCursor();
					deltaPart = this.#formatRawDelta(rawMessages, wip) ?? deltasText;
					finalTurns = turnsCovered;
				} else if (shouldReprime) {
					const remaining = this.#pending;
					const newTurns = remaining.reduce((sum, item) => sum + item.turns, 0);
					const survivingConsults = remaining.filter((item): item is PendingConsult => item.kind === "consult");
					this.#pending = [];
					this.#resetAdvisorContext(false, false);
					this.#pending = survivingConsults;
					deltaPart = this.#renderDelta(this.#latestMessages, wip) ?? "";
					finalTurns = turnsCovered + newTurns;
				} else {
					deltaPart = deltasText;
					finalTurns = turnsCovered;
				}

				let finalBatchBase = buildBatch(deltaPart);
				if (this.disposed || finalBatchBase === null) {
					restoreEscalationIfNeeded();
					if (consult)
						consult.resolve({ status: "disposed", attempts: snapshotConsultAttempts(consult.attempts) });
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
				}
				const finalBatchObfuscator = this.host.obfuscator;
				if (finalBatchObfuscator?.hasSecrets()) {
					finalBatchBase = finalBatchObfuscator.stripUnsafeFriendlyPlaceholderPrefixes(
						finalBatchBase,
						this.#advisorRegexSecretValues,
					);
				}

				// Gist substitution: single point, after the re-prime branch and after
				// the consultation suffix is baked in. Failure falls back to the
				// unsubstituted batch. The retried delta text below stays PRE-substitution
				// (resolveGists is idempotent/cached upstream) so the retry re-substitutes
				// to the identical string.
				let finalBatch = finalBatchBase;
				if (this.host.resolveGists) {
					try {
						finalBatch = await this.host.resolveGists(finalBatchBase);
					} catch (err) {
						logger.debug("advisor gist substitution failed", { err: String(err) });
						finalBatch = finalBatchBase;
					}
					// A reset/dispose during substitution invalidates this batch.
					if (this.#epoch !== epoch) {
						restoreEscalationIfNeeded();
						if (consult) consult.resolve(this.#clearedResult(consult.attempts));
						continue;
					}
				}
				if (consult && !consult.async && !batchAlreadyUsedFallback) {
					restoreEscalation = this.#switchToEscalationModel();
				}
				const escalationActive = restoreEscalation !== undefined;
				const finalModel = this.agent.model;
				const promptPayload =
					!escalationActive && candidatePrepared && candidatePrepared.source === finalBatch
						? candidatePrepared.payload
						: isFableVisionAdvisorModel(finalModel)
							? await prepareFableAdvisorPromptPayload(finalBatch, finalModel)
							: { text: finalBatch };
				if (this.#epoch !== epoch) {
					restoreEscalationIfNeeded();
					if (consult) consult.resolve(this.#clearedResult(consult.attempts));
					continue;
				}
				// An abort/timeout during batch assembly must never reach the model:
				// the caller is already settled, so requeue the deltas (their context
				// is still pending) and drop the consult without prompting.
				if (consult && !consult.async && consult.terminated) {
					restoreEscalationIfNeeded();
					if (deltaPart) {
						this.#pending.unshift({
							...this.#createPendingDelta(deltaPart, finalTurns, wip),
							fallbackAttempted: batchAlreadyUsedFallback || undefined,
						});
					}
					continue;
				}

				let success = false;
				// Capture the advisor's message count BEFORE the prompt so a failure can
				// roll back the user batch + synthetic assistant-error turn `Agent.#runLoop`
				// appends to internal state. Without this, a retry would replay the
				// failed batch on top of the stale turns and the dropped-after-3 path
				// would leak orphan failures into the next successful run's context. It
				// also bounds the answer-extraction scan to this consult's turns.
				const messageSnapshot = this.agent.state.messages.length;
				const consultAttempt: AdvisorConsultAttempt | undefined = consult
					? { attempt: consult.attempts.length + 1 }
					: undefined;
				try {
					// Reset the host's per-update advisor state (one-advise-per-update
					// gate) before each model cycle, so the new batch starts with a
					// fresh budget. Dedupe history persists across cycles.
					this.host.beginAdvisorUpdate?.(wip, { consultAnswer: consult?.async === true });
					if (consult && consultAttempt) consult.attempts.push(consultAttempt);
					const promptInFlight = this.agent.prompt(promptPayload.text, promptPayload.images);
					this.#promptInFlight = promptInFlight;
					try {
						await promptInFlight;
					} finally {
						if (this.#promptInFlight === promptInFlight) this.#promptInFlight = undefined;
					}
					// `Agent.#runLoop` catches provider/stream failures internally and
					// resolves `prompt()` cleanly with the assistant turn ending in
					// `stopReason: "error"` and the message recorded on `state.error`.
					// Treat that as a failed turn so OpenRouter ZDR-style endpoint
					// rejections trip the retry/notify path instead of looking like a
					// successful empty cycle.
					const promptError = this.agent.state.error;
					if (promptError) throw new Error(promptError);
					// A content-less stop is a deliberate silent review — the documented
					// verifier behavior ("prefer silence when the agent is on track") — and
					// completes the turn. Sessions can legitimately have nothing to advise
					// on for any number of consecutive turns, so silence is never warned
					// about (#5216 did, spamming "Advisor unavailable" at quiet models).
					const turnError = getAdvisorTurnError(this.agent.state.messages.slice(messageSnapshot));
					if (turnError) throw turnError;
					success = true;
					this.#failing = false;
					this.#consecutiveFailures = 0;
					this.#failureNotified = false;
					this.#droppedBacklogs = 0;
					// The blocked caller must observe restored state, not the temporary
					// escalation/fallback model while this drain yields to host hooks.
					restoreEscalationIfNeeded();
					if (this.#onFallbackModel) this.#restorePrimaryModel();
					if (consult?.async) {
						if (!this.#advisorCalledAdviseSince(messageSnapshot)) {
							const answer = this.#extractConsultAnswer(messageSnapshot);
							if (answer) this.host.enqueueAdvice(answer);
						}
					} else if (consult) {
						const answer = this.#extractConsultAnswer(messageSnapshot);
						consult.resolve(
							answer
								? { status: "answered", answer, attempts: snapshotConsultAttempts(consult.attempts) }
								: { status: "empty_response", attempts: snapshotConsultAttempts(consult.attempts) },
						);
					}
					this.#consecutiveQuarantines = 0;
					this.#refusalModelsTried.clear();
					if (this.host.onTurnSuccess) {
						try {
							await raceWithSignal(Promise.resolve(this.host.onTurnSuccess()), iterationAbort.signal);
						} catch (hookErr) {
							logger.debug("advisor onTurnSuccess hook failed", { err: String(hookErr) });
						}
					}
				} catch (err) {
					// A reset/dispose abort belongs to the discarded epoch, never to the
					// next advisor conversation.
					if (consultAttempt) consultAttempt.error = consultErrorText(err);

					const requeue = (
						text = deltaPart,
						options: { fallbackAttempted?: boolean; overflowRecovery?: boolean } = {},
					): void => {
						const fallbackAttempted = options.fallbackAttempted ?? (batchAlreadyUsedFallback || undefined);
						const overflowRecovery = options.overflowRecovery ?? (recoveringOverflow || undefined);
						const pending: PendingItem[] = [];
						if (text) {
							pending.push({
								...this.#createPendingDelta(text, finalTurns, wip, rawMessages),
								fallbackAttempted,
								overflowRecovery,
							});
						}
						if (consult && !consult.terminated) {
							if (fallbackAttempted) consult.fallbackAttempted = true;
							if (overflowRecovery) consult.overflowRecovery = true;
							pending.push(consult);
						}
						if (pending.length) this.#pending.unshift(...pending);
					};

					if (this.#sessionTransitionPaused) {
						restoreEscalationIfNeeded();
						this.#rollbackFailedTurn(messageSnapshot);
						requeue();
						continue;
					}
					if (this.#epoch !== epoch) {
						restoreEscalationIfNeeded();
						if (consult) consult.resolve(this.#clearedResult(consult.attempts));
						continue;
					}

					// Never hold the primary at the advisor catch-up gate while recovery
					// hooks, retry delay, or provider quota are pending.
					this.#failing = true;
					this.#wakeAllWaiters();
					const failedMessages = this.agent.state.messages.slice(messageSnapshot);
					const terminalFailure = [...failedMessages]
						.reverse()
						.find(
							(message): message is AssistantMessage =>
								message.role === "assistant" && message.stopReason === "error",
						);
					const rawErrorId = AIError.classify(err);
					const terminalFailureId =
						terminalFailure === undefined ? undefined : AIError.classifyMessage(terminalFailure);
					const classifierRefusal =
						(terminalFailure !== undefined && isClassifierRefusal(terminalFailure)) ||
						(!AIError.is(rawErrorId, AIError.Flag.AccountPolicy) &&
							AIError.is(rawErrorId, AIError.Flag.ContentBlocked));
					const contextOverflow =
						(terminalFailureId !== undefined && AIError.is(terminalFailureId, AIError.Flag.ContextOverflow)) ||
						AIError.is(rawErrorId, AIError.Flag.ContextOverflow);
					const terminalFailureRetriable =
						terminalFailureId === undefined ||
						AIError.retriable(terminalFailureId) ||
						AIError.is(terminalFailureId, AIError.Flag.ContextOverflow);
					this.#rollbackFailedTurn(messageSnapshot);

					const fallbackModel = this.#shouldRetryOnFallback(err, batchAlreadyUsedFallback)
						? this.#fallbackModel
						: undefined;
					if (fallbackModel) {
						restoreEscalationIfNeeded();
						this.agent.setModel?.(fallbackModel);
						this.#onFallbackModel = true;
						const requeueCount = (deltaPart ? 1 : 0) + (consult && !consult.terminated ? 1 : 0);
						requeue(deltaPart, { fallbackAttempted: true });
						this.#fallbackRetryItemCount = requeueCount;
						continue;
					}

					if (classifierRefusal && this.#includeThinking) {
						this.#includeThinking = false;
						const strippedBatch = this.#formatRawDelta(rawMessages, wip);
						if (strippedBatch) {
							requeue(strippedBatch);
							logger.debug("advisor refusal recovered by stripping primary reasoning");
							continue;
						}
					}

					let recovered = false;
					const refusalModel = this.host.getModelIdentity?.() ?? this.#modelIdentity ?? "";
					try {
						if (classifierRefusal) {
							if (!this.#refusalModelsTried.has(refusalModel)) {
								this.#refusalModelsTried.add(refusalModel);
								recovered = await this.#invokeTurnError(err, failedMessages, iterationAbort.signal);
							} else {
								logger.debug("advisor refusal chain exhausted", { model: refusalModel });
							}
						} else {
							recovered = await this.#invokeTurnError(err, failedMessages, iterationAbort.signal);
						}
					} catch (hookErr) {
						logger.debug("advisor onTurnError hook failed", { err: String(hookErr) });
					}
					if (this.#epoch !== epoch) {
						restoreEscalationIfNeeded();
						if (consult) consult.resolve(this.#clearedResult(consult.attempts));
						continue;
					}
					if (this.#sessionTransitionPaused) {
						restoreEscalationIfNeeded();
						requeue();
						continue;
					}
					if (err instanceof AdvisorOutputQuarantinedError) {
						// A quarantine discards the advisor's whole turn before dispatch, so
						// its advice never reaches the primary. One re-prime is allowed to
						// recover a one-off hallucination silently; a persistent quarantine
						// loop is a supervision gap the user must see in the main UI — not an
						// unbounded silent retry. Surface it (deduped by #notifyFailureOnce)
						// and drop the batch to break the loop (issue #6661).
						this.#consecutiveQuarantines++;
						if (this.#consecutiveQuarantines >= MAX_QUARANTINE_RETRIES) {
							this.#notifyFailureOnce(err);
							this.#consecutiveQuarantines = 0;
							this.#resetAdvisorContext(true, true);
							if (consult && !consult.terminated) {
								consult.resolve({
									status: "provider_error",
									attempts: snapshotConsultAttempts(consult.attempts),
									error: consultErrorText(err),
									retryable: false,
								});
							}
							continue;
						}
						const rePrime = this.#pending.length > 0 ? this.#latestMessages : undefined;
						this.#resetAdvisorContext(true, !rePrime);
						if (rePrime) this.onTurnEnd(rePrime);
						if (consult && !consult.terminated) this.#pending.push(consult);
						continue;
					}
					if (classifierRefusal) {
						if (recovered) {
							this.#consecutiveFailures = 0;
							this.#failureNotified = false;
							requeue();
							logger.debug("advisor refusal recovered by model fallback");
							continue;
						}
						this.#refusalModelsTried.clear();
						restoreEscalationIfNeeded();
						this.#notifyFailureOnce(err);
						this.#seenContext.clear();
						if (consult && !consult.terminated) {
							consult.resolve({
								status: "provider_error",
								attempts: snapshotConsultAttempts(consult.attempts),
								error: consultErrorText(err),
								retryable: false,
							});
						}
						this.#backlog = Math.max(0, this.#backlog - finalTurns);
						this.#notifyWaiters();
						continue;
					}
					if (recovered) {
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						requeue();
						continue;
					}
					if (AIError.isUsageLimit(err)) {
						this.#quotaExhausted = true;
						this.#consecutiveFailures = 0;
						this.#failureNotified = false;
						this.#clearContextReplayState();
						// The blocked caller settles immediately, but the requeued prompt must
						// later arrive as advice rather than resolving its settled promise.
						if (consult) consult.async = true;
						requeue();
						// The requeue keeps today's quota behavior, but the blocked caller
						// must not sit on the 300s timer for an already-known quota wall.
						if (consult) {
							consult.resolve({
								status: "rate_limited",
								attempts: snapshotConsultAttempts(consult.attempts),
								error: consultErrorText(err),
								requeued: true,
							});
						}
						this.#wakeAllWaiters();
						try {
							this.host.notifyQuotaExhausted?.();
						} catch (notifyErr) {
							logger.warn("advisor quota notification failed", { err: String(notifyErr) });
						}
						break;
					}
					if (!terminalFailureRetriable) {
						this.#halted = true;
						this.#clearPending("terminal advisor failure");
						this.#backlog = 0;
						this.#invalidateRenderedContext();
						if (!this.#failureNotified) {
							this.#failureNotified = true;
							this.host.notifyFailure?.(err);
						}
						if (consult) {
							consult.resolve({
								status: "provider_error",
								attempts: snapshotConsultAttempts(consult.attempts),
								error: consultErrorText(err),
								retryable: false,
							});
						}
						this.#wakeAllWaiters();
						success = true;
					} else if (contextOverflow) {
						this.#clearAdvisorContextAtCurrentCursor();
						if (recoveringOverflow) {
							if (!this.#failureNotified) {
								this.#failureNotified = true;
								this.host.notifyFailure?.(err);
							}
							if (consult) {
								consult.resolve({
									status: "provider_error",
									attempts: snapshotConsultAttempts(consult.attempts),
									error: consultErrorText(err),
									retryable: false,
								});
							}
							success = true;
						} else {
							const pending: PendingItem[] = [];
							if (deltaPart) {
								const recoveryDelta = this.#formatRawDelta(rawMessages, wip) ?? deltaPart;
								pending.push({
									...this.#createPendingDelta(recoveryDelta, finalTurns, wip, rawMessages),
									overflowRecovery: true,
								});
							}
							if (consult && !consult.terminated) {
								consult.overflowRecovery = true;
								pending.push(consult);
							}
							if (pending.length) this.#pending.unshift(...pending);
							restoreEscalationIfNeeded();
							continue;
						}
					} else {
						this.#consecutiveFailures++;
						if (this.#consecutiveFailures >= 3) {
							this.#consecutiveFailures = 0;
							this.#droppedBacklogs++;
							if (isPermanentAdvisorError(err) || this.#droppedBacklogs >= 3) this.#halted = true;
							this.#clearPending("advisor failure backlog dropped");
							this.#backlog = 0;
							this.#invalidateRenderedContext();
							if (!this.#failureNotified) {
								this.#failureNotified = true;
								this.host.notifyFailure?.(err);
							}
							if (consult) {
								consult.resolve({
									status: "provider_error",
									attempts: snapshotConsultAttempts(consult.attempts),
									error: consultErrorText(err),
									retryable: terminalFailureRetriable,
								});
							}
							success = true;
						} else {
							requeue();
							if (this.retryDelayMs <= 0) {
								await Bun.sleep(0);
							} else {
								try {
									await raceWithSignal(Bun.sleep(this.retryDelayMs), iterationAbort.signal);
								} catch (sleepError) {
									if (!iterationAbort.signal.aborted) throw sleepError;
								}
							}
						}
					}
				}
				restoreEscalationIfNeeded();

				if (success && this.#epoch === epoch) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
				}
			}
		} finally {
			// After a fallback retry drains the batch, restore immediately so idle
			// advisor state reflects the primary model before another update arrives.
			if (!this.disposed && this.#onFallbackModel && this.#fallbackRetryItemCount === 0) {
				this.#restorePrimaryModel();
			}
			this.#iterationAbort = undefined;
			this.#busy = false;
			this.#inFlightConsult = undefined;
		}
	}

	#restorePrimaryModel(): void {
		if (this.#primaryModel) this.agent.setModel?.(this.#primaryModel);
		this.agent.setThinkingLevel?.(this.#normalThinkingLevel);
		if (this.#normalDisableReasoning !== undefined || this.#escalationDisableReasoning !== undefined) {
			this.agent.setDisableReasoning?.(this.#normalDisableReasoning ?? false);
		}
		this.#onFallbackModel = false;
	}

	#shouldRetryOnFallback(err: unknown, batchAlreadyUsedFallback: boolean): boolean {
		if (!isSafeguardRefusal(err)) return false;
		if (batchAlreadyUsedFallback) return false;
		if (!this.#fallbackModel || !this.#primaryModel || !this.agent.model || !this.agent.setModel) return false;
		const onEscalationModel = this.#escalationModel ? modelsAreEqual(this.agent.model, this.#escalationModel) : false;
		if (this.#onFallbackModel && !onEscalationModel) return false;
		if (modelsAreEqual(this.agent.model, this.#primaryModel)) return true;
		return onEscalationModel;
	}
}

/** Mirrors turn recovery's refusal classification without treating account eligibility as a model refusal. */
function isClassifierRefusal(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const id = AIError.classifyMessage(message);
	if (AIError.is(id, AIError.Flag.AccountPolicy)) return false;
	const stopType = message.stopDetails?.type;
	if (stopType === "refusal" || stopType === "sensitive") return true;
	return AIError.is(id, AIError.Flag.ContentBlocked);
}

/**
 * The only malformed advisor turn shape: the prompt resolved but produced no
 * assistant response at all. Everything an assistant message carries — advice,
 * reasoning, or deliberate silence (empty `stop`) — is a completed review.
 */
function getAdvisorTurnError(messages: readonly AgentMessage[]): Error | undefined {
	if (messages.length === 0) return undefined;
	if (messages.some(message => message.role === "assistant")) return undefined;
	return new Error("Advisor turn ended without an assistant response");
}

type TextualContent = string | readonly (TextContent | ImageContent)[];

function obfuscateTextualContent(
	obfuscator: SecretObfuscator,
	content: TextualContent,
	sharedRegexSecretValues: ReadonlySet<string>,
): TextualContent {
	if (typeof content === "string") return obfuscator.obfuscate(content, sharedRegexSecretValues);
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text, sharedRegexSecretValues);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

function firstAdvisorToolResultErrorLine(content: TextualContent): string | undefined {
	if (typeof content === "string") return content.split("\n", 1)[0];
	const first = content[0];
	if (first?.type !== "text") return undefined;
	return first.text.split("\n", 1)[0];
}

function obfuscateAdvisorToolResultErrorContent(
	obfuscator: SecretObfuscator,
	content: TextualContent,
	sharedRegexSecretValues: ReadonlySet<string>,
): TextualContent {
	const firstLine = firstAdvisorToolResultErrorLine(content);
	if (firstLine === undefined) return content;
	const preview = formatToolResultErrorPreview(content);
	const obfuscatedPreview = obfuscator.obfuscate(preview, sharedRegexSecretValues);
	if (obfuscatedPreview === firstLine) return content;
	if (typeof content === "string") return obfuscatedPreview + content.slice(firstLine.length);
	const first = content[0]!;
	if (first.type !== "text") return content;
	return [{ ...first, text: obfuscatedPreview + first.text.slice(firstLine.length) }, ...content.slice(1)];
}

function obfuscateAssistantMessage(
	obfuscator: SecretObfuscator,
	message: AssistantMessage,
	sharedRegexSecretValues: ReadonlySet<string>,
): AssistantMessage {
	let changed = false;
	const content = message.content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscator.obfuscate(block.text, sharedRegexSecretValues);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "thinking") {
			const thinking = obfuscator.obfuscate(block.thinking, sharedRegexSecretValues);
			if (thinking === block.thinking) return block;
			changed = true;
			return { ...block, thinking, thinkingSignature: undefined };
		}
		if (block.type === "toolCall") {
			const args = obfuscateToolArguments(obfuscator, block.arguments, sharedRegexSecretValues);
			if (args === block.arguments) return block;
			changed = true;
			return { ...block, arguments: args };
		}
		return block;
	});
	return changed ? { ...message, content } : message;
}

function obfuscateDetails(
	obfuscator: SecretObfuscator,
	details: Record<string, unknown> | undefined,
	sharedRegexSecretValues: ReadonlySet<string>,
): Record<string, unknown> | undefined {
	if (!details) return details;
	// Walk strings at every depth: `customOneLiner` renders nested fields
	// (e.g. `async-result` reads `details.jobs[].label`/`jobId`), so a shallow
	// pass leaks any secret a background job's label happens to contain.
	return obfuscateToolArguments(obfuscator, details, sharedRegexSecretValues);
}

function obfuscateAdvisorMessage(
	obfuscator: SecretObfuscator,
	message: AgentMessage,
	sharedRegexSecretValues: ReadonlySet<string>,
): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer": {
			const content = obfuscateTextualContent(
				obfuscator,
				message.content as TextualContent,
				sharedRegexSecretValues,
			);
			return content === message.content ? message : ({ ...(message as object), content } as AgentMessage);
		}
		case "toolResult": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
				isError?: boolean;
			};
			const content = msg.isError
				? obfuscateAdvisorToolResultErrorContent(obfuscator, msg.content, sharedRegexSecretValues)
				: msg.content;
			let details = msg.details;
			if (typeof details?.diff === "string") {
				const diff = obfuscator.obfuscate(details.diff, sharedRegexSecretValues);
				if (diff !== details.diff) details = { ...details, diff };
			}
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "assistant":
			return obfuscateAssistantMessage(
				obfuscator,
				message as AssistantMessage,
				sharedRegexSecretValues,
			) as AgentMessage;
		case "custom":
		case "hookMessage": {
			if (!formatSessionHistoryMarkdown([message], { expandPrimaryContext: true }).trim()) return message;
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content, sharedRegexSecretValues);
			const details = obfuscateDetails(obfuscator, msg.details, sharedRegexSecretValues);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "bashExecution": {
			const msg = message as AgentMessage & { command: string };
			const command = obfuscator.obfuscate(formatExecutionSourcePreview(msg.command), sharedRegexSecretValues);
			return command === msg.command ? message : ({ ...(message as object), command } as AgentMessage);
		}
		case "pythonExecution": {
			const msg = message as AgentMessage & { code: string };
			const code = obfuscator.obfuscate(formatExecutionSourcePreview(msg.code), sharedRegexSecretValues);
			return code === msg.code ? message : ({ ...(message as object), code } as AgentMessage);
		}
		case "branchSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary, sharedRegexSecretValues);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "compactionSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary, sharedRegexSecretValues);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "fileMention": {
			const msg = message as AgentMessage & {
				files: Array<{ path: string; content: string; image?: unknown }>;
			};
			let changed = false;
			const files = msg.files.map(file => {
				const path = obfuscator.obfuscate(file.path, sharedRegexSecretValues);
				if (path === file.path) return file;
				changed = true;
				return { ...file, path };
			});
			return changed ? ({ ...(message as object), files } as AgentMessage) : message;
		}
		default:
			return message;
	}
}

function scrubAdvisorHistory(
	obfuscator: SecretObfuscator,
	messages: AgentMessage[],
	sharedRegexSecretValues: ReadonlySet<string>,
): void {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const next = obfuscateAdvisorMessage(obfuscator, message, sharedRegexSecretValues);
		if (next !== message) messages[index] = next;
	}
}
