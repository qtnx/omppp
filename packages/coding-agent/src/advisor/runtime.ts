import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { obfuscateToolArguments, type SecretObfuscator } from "../secrets/obfuscator";
import { formatSessionHistoryMarkdown, PRIMARY_CONTEXT_CUSTOM_TYPES } from "../session/session-history-format";

/**
 * Minimal slice of `Agent` the runtime drives — satisfied by pi-agent-core
 * `Agent`. `state.error` mirrors `Agent.state.error`: provider/stream failures
 * the loop catches internally never reject `prompt()`, so the runtime reads
 * this field after every prompt to detect a failed turn.
 */
export interface AdvisorAgent {
	prompt(input: string): Promise<void>;
	abort(reason?: unknown): void;
	reset(): void;
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
	 * when the advisor should re-prime — reset and replay the current
	 * primary-bounded transcript — because promotion did not free enough room.
	 * Optional: hosts that omit it get no maintenance (context only shrinks when
	 * the primary's next compaction triggers {@link AdvisorRuntime.reset}).
	 */
	maintainContext?(incomingTokens: number): Promise<boolean>;
	/**
	 * Called immediately before each `agent.prompt(batch)` cycle. Lets the host
	 * clear per-update advisor state — currently the one-advise-per-update gate
	 * in {@link AdvisorEmissionGuard}, which the host owns because it is the
	 * one that routes `advise()` results back to the primary.
	 */
	beginAdvisorUpdate?(): void;
	/** Surface a non-recovering advisor failure to the host UI without adding model-visible context. */
	notifyFailure?(error: unknown): void;
	/**
	 * Optional gist-substitution hook. Called once immediately before each
	 * `agent.prompt(batch)` with the final prompt string; returns the same string
	 * with any `{{GIST:<hash>}}` placeholders (emitted by the thinking-artifact
	 * clamp) replaced by resolved gist text. Only placeholders whose hash the host
	 * knows are substituted; text that merely resembles the marker passes through
	 * untouched. Implementations must be idempotent + cache-stable so a retried
	 * batch re-substitutes to the identical string (prompt-cache safe). A rejection
	 * leaves the batch unsubstituted.
	 */
	resolveGists?(batch: string): Promise<string>;
	/**
	 * Optional renderer for primary `thinking` block bodies before they reach the
	 * advisor (clamp head/tail + gist marker). Defined here for host wiring; the
	 * session-history formatter consumes it in a later wave, so the runtime does
	 * not yet forward it into `formatSessionHistoryMarkdown` opts.
	 */
	renderThinking?: (text: string) => string;
}

/** A queued advisor session-update delta (one or more coalesced primary turns). */
interface PendingDelta {
	kind: "delta";
	text: string;
	turns: number;
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
	resolve: (answer: string | null) => void;
}

type PendingItem = PendingDelta | PendingConsult;

interface CatchupWaiter {
	threshold: number;
	resolve: () => void;
	finish: () => void;
	timer?: NodeJS.Timeout;
}

export class AdvisorRuntime {
	#lastCount = 0;
	/** Last-shown body, keyed by primary-context customType (plan/goal mode rules,
	 *  approved plan). These prompts are re-injected verbatim every primary turn;
	 *  this lets {@link #renderDelta} collapse an unchanged copy to a one-line
	 *  marker so the advisor isn't re-fed the full ~1k-token rules each turn.
	 *  Cleared on every re-prime/seed and when a failed batch is dropped. */
	#seenContext = new Map<string, string>();
	#pending: PendingItem[] = [];
	#busy = false;
	#paused = false;
	#backlog = 0;
	#consecutiveFailures = 0;
	#failureNotified = false;
	#latestMessages?: AgentMessage[];
	#waiters: CatchupWaiter[] = [];
	/** Bumped by every external {@link reset}/{@link dispose}. A drain iteration
	 *  captures it before its awaits; a mismatch on resume means a reset aborted
	 *  the in-flight advisor prompt, so the stale batch is dropped instead of
	 *  being retried/requeued into the post-reset conversation. */
	#epoch = 0;
	disposed = false;

	constructor(
		private readonly agent: AdvisorAgent,
		private readonly host: AdvisorRuntimeHost,
		private readonly retryDelayMs = 1000,
	) {}

	get backlog(): number {
		return this.#backlog;
	}

	get paused(): boolean {
		return this.#paused;
	}

	pause(): void {
		this.#paused = true;
	}

	resume(): void {
		this.#paused = false;
		void this.#drain();
	}

	onTurnEnd(messages?: AgentMessage[]): void {
		if (this.disposed) return;
		const all = messages ?? this.host.snapshotMessages();
		this.#latestMessages = all;
		const render = this.#renderDelta(all);
		if (render) {
			this.#pending.push({ kind: "delta", text: render, turns: 1 });
			this.#backlog++;
			this.#notifyWaiters();
			void this.#drain();
		}
	}

	/**
	 * "Phone a friend": ask the advisor a question mid-turn and block until it
	 * answers. Resolves with the advisor's plain-text reply, or `null` on timeout
	 * (default 120s), `opts.signal` abort, or disposal/reset. Renders a fresh
	 * mid-turn delta first so the advisor sees current context alongside the
	 * question, then enqueues the consult and drains.
	 */
	consult(question: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string | null> {
		if (this.disposed || this.#paused) return Promise.resolve(null);

		// Render a fresh mid-turn delta so the advisor sees everything up to the
		// current (possibly still-streaming) point before the question. `turns: 0`
		// because the enclosing primary turn is counted by its own later
		// `onTurnEnd`; adding turns here would double-count the backlog.
		const snapshot = this.host.snapshotMessages();
		const render = this.#renderDelta(snapshot);
		if (render) {
			this.#pending.push({ kind: "delta", text: render, turns: 0 });
		}
		// Point `#latestMessages` at this snapshot so a mid-consult re-prime
		// (`#renderDelta(this.#latestMessages)`) renders current context rather
		// than a stale transcript.
		this.#latestMessages = snapshot;

		const { promise, resolve } = Promise.withResolvers<string | null>();
		let settled = false;
		const signal = opts?.signal;
		let timer: NodeJS.Timeout | undefined;
		// First resolution wins; later ones (a late model answer racing a timeout,
		// or a reset that already resolved the item) are no-ops.
		const settle = (answer: string | null): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(answer);
		};
		function onAbort(): void {
			settle(null);
		}

		this.#pending.push({ kind: "consult", question, turns: 0, epoch: this.#epoch, resolve: settle });
		void this.#drain();

		const timeoutMs = opts?.timeoutMs ?? 120_000;
		timer = setTimeout(() => settle(null), timeoutMs);
		if (signal) {
			if (signal.aborted) settle(null);
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		return promise;
	}

	/**
	 * Route every `#pending` clear through here so an orphaned consult never
	 * leaves the primary agent hanging: resolve `null` on every queued consult
	 * before dropping the queue.
	 */
	#clearPending(reason: string): void {
		if (this.#pending.length) {
			for (const item of this.#pending) {
				if (item.kind === "consult") {
					try {
						item.resolve(null);
					} catch (err) {
						logger.debug("advisor consult resolve failed during clear", { reason, err: String(err) });
					}
				}
			}
		}
		this.#pending = [];
	}

	waitForCatchup(maxMs: number, threshold: number, signal?: AbortSignal): Promise<void> {
		if (this.disposed || signal?.aborted || this.#backlog < threshold) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		let waiter!: CatchupWaiter;
		const finish = (): void => {
			const idx = this.#waiters.indexOf(waiter);
			if (idx >= 0) this.#waiters.splice(idx, 1);
			clearTimeout(waiter.timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		waiter = { threshold, resolve, finish, timer: setTimeout(finish, maxMs) };
		this.#waiters.push(waiter);
		signal?.addEventListener("abort", finish, { once: true });
		if (signal?.aborted) {
			finish();
		}
		return promise;
	}

	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#clearPending("dispose");
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#wakeAllWaiters();
		try {
			this.agent.abort("advisor disposed");
		} catch {}
	}

	#resetAdvisorContext(clearBacklog: boolean, wakeWaiters: boolean): void {
		this.#lastCount = 0;
		this.#clearPending("reset");
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#seenContext.clear();
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

	/**
	 * Re-prime the advisor after a history rewrite (compaction, session
	 * switch/resume, branch). Clears the advisor's own (non-persisted) context
	 * and rewinds the cursor to 0 so the NEXT turn replays the full current —
	 * post-compaction — transcript, giving the advisor fresh context instead of
	 * leaving it blind to everything before the rewrite.
	 */
	reset(): void {
		this.#epoch++;
		this.#resetAdvisorContext(true, true);
	}

	/**
	 * Seed the cursor to the current transcript length when the advisor is enabled
	 * mid-session. Prevents the next turn from replaying the entire history to the
	 * advisor (which would be expensive and likely stale).
	 */
	seedTo(count: number): void {
		this.#lastCount = count;
		this.#clearPending("seedTo");
		this.#backlog = 0;
		this.#consecutiveFailures = 0;
		this.#failureNotified = false;
		this.#seenContext.clear();
		this.#wakeAllWaiters();
	}

	#renderDelta(messages?: AgentMessage[]): string | null {
		const all = messages ?? this.#latestMessages ?? this.host.snapshotMessages();
		if (all.length < this.#lastCount) {
			this.#lastCount = all.length;
			this.#seenContext.clear();
			return null;
		}
		// `onTurnEnd`/`consult` can hand a live array whose last message is a
		// still-streaming PARTIAL assistant turn (no `stopReason` set yet).
		// Exclude it and DON'T advance the cursor past it, so its finalized form
		// renders exactly once on the next delta instead of being frozen partial.
		let effectiveEnd = all.length;
		const last = all[all.length - 1];
		if (last?.role === "assistant" && (last as AssistantMessage).stopReason === undefined) {
			effectiveEnd = all.length - 1;
		}
		const delta = all
			.slice(this.#lastCount, effectiveEnd)
			.filter(m => !(m.role === "custom" && (m as { customType?: string }).customType === "advisor"))
			.map(m => this.#dedupContextMessage(m));
		this.#lastCount = effectiveEnd;
		if (delta.length === 0) return null;
		const obfuscator = this.host.obfuscator;
		const formattedDelta = obfuscator?.hasSecrets() ? obfuscateAdvisorDelta(obfuscator, delta) : delta;
		const md = formatSessionHistoryMarkdown(formattedDelta, {
			includeThinking: true,
			includeToolIntent: true,
			watchedRoles: true,
			expandPrimaryContext: true,
			renderThinking: this.host.renderThinking,
			errorResultLines: 10,
			expandAsyncResults: true,
			expandEditDiffs: true,
		});
		if (!md.trim()) return null;
		return `### Session update\n\n${md}`;
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
		const type = (msg as { customType?: string }).customType;
		if (!type || !PRIMARY_CONTEXT_CUSTOM_TYPES.has(type)) return msg;
		const content = (msg as { content?: unknown }).content;
		if (typeof content !== "string") return msg;
		if (this.#seenContext.get(type) === content) {
			return { ...(msg as object), content: "(unchanged — still in effect)" } as AgentMessage;
		}
		this.#seenContext.set(type, content);
		return msg;
	}

	#notifyWaiters(): void {
		for (let i = this.#waiters.length - 1; i >= 0; i--) {
			const w = this.#waiters[i];
			if (this.#backlog < w.threshold) {
				w.finish();
			}
		}
	}

	#wakeAllWaiters(): void {
		for (const w of [...this.#waiters]) {
			w.finish();
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

	async #drain(): Promise<void> {
		if (this.#paused || this.#busy) return;
		this.#busy = true;
		try {
			while (!this.#paused && !this.disposed && this.#pending.length) {
				const epoch = this.#epoch;
				// Chunk at the first consult boundary: coalesce the leading deltas,
				// attach at most ONE consult so its answer maps to a single prompt;
				// anything queued after that consult goes back to the FRONT (order
				// preserved) for the next loop iteration.
				const popped = this.#pending.splice(0);
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

				// Each delta already opens with a `### Session update` heading, so
				// join with a blank line rather than a `---` rule. The consultation
				// question stays STRUCTURAL (kept off `deltasText`) so it survives a
				// re-prime and can be re-appended identically for prompt-cache stability.
				const deltasText = deltaItems.map(b => b.text).join("\n\n");
				const turnsCovered = deltaItems.reduce((sum, b) => sum + b.turns, 0) + (consult?.turns ?? 0);
				const buildBatch = (deltaPart: string): string | null => {
					if (consult) {
						const suffix = `### Consultation request\n${consult.question}\n\nReply with your consultation answer as plain text.`;
						return deltaPart ? `${deltaPart}\n\n${suffix}` : suffix;
					}
					return deltaPart || null;
				};

				const candidateBatch = buildBatch(deltasText);
				const incomingTokens = estimateTokens({
					role: "user",
					content: candidateBatch ?? "",
					timestamp: Date.now(),
				});

				let shouldReprime = false;
				if (this.host.maintainContext) {
					try {
						shouldReprime = await this.host.maintainContext(incomingTokens);
					} catch (err) {
						logger.debug("advisor context maintenance failed", { err: String(err) });
					}
				}
				// A reset/dispose during context maintenance invalidates this batch.
				if (this.#epoch !== epoch) {
					consult?.resolve(null);
					continue;
				}

				let deltaPart: string;
				let finalTurns: number;
				if (shouldReprime) {
					// Promotion could not fit the advisor's context — re-prime. The full
					// re-render subsumes any remaining pending deltas, so fold their turns
					// and drop them; but PRESERVE queued consults (they carry resolvers the
					// primary is blocked on). Clear #pending before the reset so
					// #clearPending inside it has no consults to null out, then restore them.
					const remaining = this.#pending;
					const newTurns = remaining.reduce((sum, b) => sum + b.turns, 0);
					const survivingConsults = remaining.filter((b): b is PendingConsult => b.kind === "consult");
					this.#pending = [];
					this.#resetAdvisorContext(false, false);
					this.#pending = survivingConsults;
					deltaPart = this.#renderDelta(this.#latestMessages) ?? "";
					finalTurns = turnsCovered + newTurns;
				} else {
					deltaPart = deltasText;
					finalTurns = turnsCovered;
				}

				const finalBatchBase = buildBatch(deltaPart);
				if (this.disposed || finalBatchBase === null) {
					consult?.resolve(null);
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
					continue;
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
						consult?.resolve(null);
						continue;
					}
				}

				let success = false;
				// Capture the advisor's message count BEFORE the prompt so a failure can
				// roll back the user batch + synthetic assistant-error turn `Agent.#runLoop`
				// appends to internal state. Without this, a retry would replay the
				// failed batch on top of the stale turns and the dropped-after-3 path
				// would leak orphan failures into the next successful run's context. It
				// also bounds the answer-extraction scan to this consult's turns.
				const messageSnapshot = this.agent.state.messages.length;
				try {
					// Reset the host's per-update advisor state (one-advise-per-update
					// gate) before each model cycle, so the new batch starts with a
					// fresh budget. Dedupe history persists across cycles.
					this.host.beginAdvisorUpdate?.();
					await this.agent.prompt(finalBatch);
					// `Agent.#runLoop` catches provider/stream failures internally and
					// resolves `prompt()` cleanly with the assistant turn ending in
					// `stopReason: "error"` and the message recorded on `state.error`.
					// Treat that as a failed turn so OpenRouter ZDR-style endpoint
					// rejections trip the retry/notify path instead of looking like a
					// successful empty cycle.
					const promptError = this.agent.state.error;
					if (promptError) throw new Error(promptError);
					success = true;
					this.#consecutiveFailures = 0;
					this.#failureNotified = false;
					consult?.resolve(this.#extractConsultAnswer(messageSnapshot));
				} catch (err) {
					// reset()/dispose() aborts the in-flight prompt; the rejection is the
					// reset itself, not a transient advisor failure. Drop the stale batch
					// (reset already cleared #pending and rewound the cursor) instead of
					// requeuing it into the post-reset conversation.
					if (this.#epoch !== epoch) {
						consult?.resolve(null);
						continue;
					}
					this.#rollbackFailedTurn(messageSnapshot);
					logger.debug("advisor turn failed", { err: String(err) });
					this.#consecutiveFailures++;
					if (this.#consecutiveFailures >= 3) {
						logger.warn("advisor failed consecutively 3 times; dropping backlog to prevent stall");
						if (!this.#failureNotified) {
							this.#failureNotified = true;
							try {
								this.host.notifyFailure?.(err);
							} catch (notifyErr) {
								logger.warn("advisor failure notification failed", { err: String(notifyErr) });
							}
						}
						this.#consecutiveFailures = 0;
						// The dropped batch may carry primary-context we never delivered; drop
						// the seen-state too so the next turn re-expands it instead of marking
						// it "unchanged" against content the advisor never received.
						this.#seenContext.clear();
						// The consult is part of the dropped batch — unblock the primary.
						consult?.resolve(null);
						success = true;
					} else {
						// Unshift the STRUCTURAL items so the resolver survives the retry and
						// the next attempt re-appends the suffix identically. The delta item
						// carries all the covered turns; the consult carries 0.
						const requeue: PendingItem[] = [];
						if (deltaPart) requeue.push({ kind: "delta", text: deltaPart, turns: finalTurns });
						if (consult) requeue.push(consult);
						if (requeue.length) this.#pending.unshift(...requeue);
						await Bun.sleep(this.retryDelayMs);
					}
				}

				if (success && this.#epoch === epoch) {
					this.#backlog = Math.max(0, this.#backlog - finalTurns);
					this.#notifyWaiters();
				}
			}
		} finally {
			this.#busy = false;
		}
	}
}

type TextualContent = string | readonly (TextContent | ImageContent)[];

function obfuscateTextualContent(obfuscator: SecretObfuscator, content: TextualContent): TextualContent {
	if (typeof content === "string") return obfuscator.obfuscate(content);
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

function obfuscateAssistantMessage(obfuscator: SecretObfuscator, message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscator.obfuscate(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "toolCall") {
			const args = obfuscateToolArguments(obfuscator, block.arguments);
			if (args === block.arguments) return block;
			changed = true;
			return { ...block, arguments: args };
		}
		if (block.type === "thinking") {
			const thinking = obfuscator.obfuscate(block.thinking);
			if (thinking === block.thinking) return block;
			changed = true;
			return { ...block, thinking };
		}
		return block;
	});
	return changed ? { ...message, content } : message;
}

function obfuscateDetails(
	obfuscator: SecretObfuscator,
	details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!details) return details;
	// Walk strings at every depth: `customOneLiner` renders nested fields
	// (e.g. `async-result` reads `details.jobs[].label`/`jobId`), so a shallow
	// pass leaks any secret a background job's label happens to contain.
	return obfuscateToolArguments(obfuscator, details);
}

function obfuscateAdvisorMessage(obfuscator: SecretObfuscator, message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer": {
			const content = obfuscateTextualContent(obfuscator, message.content as TextualContent);
			return content === message.content ? message : ({ ...(message as object), content } as AgentMessage);
		}
		case "toolResult": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content);
			const details = obfuscateDetails(obfuscator, msg.details);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "assistant":
			return obfuscateAssistantMessage(obfuscator, message as AssistantMessage) as AgentMessage;
		case "custom":
		case "hookMessage": {
			const msg = message as AgentMessage & {
				content: TextualContent;
				details?: Record<string, unknown>;
			};
			const content = obfuscateTextualContent(obfuscator, msg.content);
			const details = obfuscateDetails(obfuscator, msg.details);
			if (content === msg.content && details === msg.details) return message;
			return { ...(message as object), content, details } as AgentMessage;
		}
		case "bashExecution": {
			const msg = message as AgentMessage & { command: string; output: string };
			const command = obfuscator.obfuscate(msg.command);
			const output = obfuscator.obfuscate(msg.output);
			return command === msg.command && output === msg.output
				? message
				: ({ ...(message as object), command, output } as AgentMessage);
		}
		case "pythonExecution": {
			const msg = message as AgentMessage & { code: string; output: string };
			const code = obfuscator.obfuscate(msg.code);
			const output = obfuscator.obfuscate(msg.output);
			return code === msg.code && output === msg.output
				? message
				: ({ ...(message as object), code, output } as AgentMessage);
		}
		case "branchSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "compactionSummary": {
			const msg = message as AgentMessage & { summary: string };
			const summary = obfuscator.obfuscate(msg.summary);
			return summary === msg.summary ? message : ({ ...(message as object), summary } as AgentMessage);
		}
		case "fileMention": {
			const msg = message as AgentMessage & {
				files: Array<{ path: string; content: string; image?: unknown }>;
			};
			let changed = false;
			const files = msg.files.map(file => {
				const path = obfuscator.obfuscate(file.path);
				const content = obfuscator.obfuscate(file.content);
				if (path === file.path && content === file.content) return file;
				changed = true;
				return { ...file, path, content };
			});
			return changed ? ({ ...(message as object), files } as AgentMessage) : message;
		}
		default:
			return message;
	}
}

function obfuscateAdvisorDelta(obfuscator: SecretObfuscator, messages: AgentMessage[]): AgentMessage[] {
	let changed = false;
	const result = messages.map(message => {
		const next = obfuscateAdvisorMessage(obfuscator, message);
		if (next !== message) changed = true;
		return next;
	});
	return changed ? result : messages;
}
