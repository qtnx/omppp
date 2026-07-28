import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type {
	TelegramApiFailure,
	TelegramBridgeHandle,
	TelegramBridgeOptions,
	TelegramBridgeStatus,
	TelegramUpdate,
} from "./types";
import {
	TELEGRAM_LONG_POLL_SECONDS,
	TELEGRAM_MAX_OUTBOUND_CHUNKS,
	TELEGRAM_MAX_SEND_RATE_LIMIT_ATTEMPTS,
	TELEGRAM_MAX_SEND_RATE_LIMIT_WAIT_MS,
	TELEGRAM_MESSAGE_CHUNK_CODE_POINTS,
} from "./types";

interface Generation {
	readonly id: number;
	readonly controller: AbortController;
	nextOffset: number | undefined;
	unsubscribe: (() => void) | undefined;
	pollPromise: Promise<void> | undefined;
	sendPromise: Promise<void> | undefined;
	outbound: string[];
	observedAgentStart: boolean;
}

const CONNECTED_MESSAGE = "Telegram bridge connected.";
const INPUT_REJECTED_MESSAGE = "Telegram could not queue that message.";
const USAGE_MESSAGE = "Use /steer <message> or /queue <message>.";
const OUTBOUND_OVERFLOW_MESSAGE = "Telegram bridge stopped because its outgoing queue is full.";

export class TelegramBridge implements TelegramBridgeHandle {
	#client: TelegramBridgeOptions["client"];
	#session: TelegramBridgeOptions["session"];
	#allowedChatId: number;
	#extractAssistantText: TelegramBridgeOptions["extractAssistantText"];
	#onStatus: TelegramBridgeOptions["onStatus"];
	#delay: NonNullable<TelegramBridgeOptions["delay"]>;
	#random: NonNullable<TelegramBridgeOptions["random"]>;
	#status: TelegramBridgeStatus = { phase: "disconnected" };
	#generation: Generation | undefined;
	#nextGenerationId = 0;
	#startPromise: Promise<void> | undefined;
	#stopPromise: Promise<void> | undefined;

	constructor(options: TelegramBridgeOptions) {
		this.#client = options.client;
		this.#session = options.session;
		this.#allowedChatId = options.allowedChatId;
		this.#extractAssistantText = options.extractAssistantText;
		this.#onStatus = options.onStatus;
		this.#delay = options.delay ?? (milliseconds => Bun.sleep(milliseconds));
		this.#random = options.random ?? Math.random;
	}

	get status(): TelegramBridgeStatus {
		return this.#status;
	}

	start(): Promise<void> {
		if (this.#status.phase === "connected") return Promise.resolve();
		if (this.#startPromise) return this.#startPromise;
		if (this.#stopPromise) return this.#stopPromise.then(() => this.start());

		const generation: Generation = {
			id: ++this.#nextGenerationId,
			controller: new AbortController(),
			nextOffset: undefined,
			unsubscribe: undefined,
			pollPromise: undefined,
			sendPromise: undefined,
			outbound: [],
			observedAgentStart: false,
		};
		this.#generation = generation;
		this.#setStatus(generation, { phase: "connecting" });
		this.#startPromise = this.#activate(generation).finally(() => {
			if (this.#generation === generation) this.#startPromise = undefined;
		});
		return this.#startPromise;
	}

	async stop(): Promise<void> {
		if (this.#stopPromise) return this.#stopPromise;
		const generation = this.#generation;
		if (!generation) return;

		this.#setStatus(generation, { phase: "stopping" }, true);
		generation.unsubscribe?.();
		generation.unsubscribe = undefined;
		generation.controller.abort();
		this.#stopPromise = Promise.allSettled([
			this.#startPromise ?? Promise.resolve(),
			generation.pollPromise ?? Promise.resolve(),
			generation.sendPromise ?? Promise.resolve(),
		])
			.then(() => {
				if (this.#generation !== generation) return;
				this.#generation = undefined;
				this.#publishStatus({ phase: "disconnected" });
			})
			.finally(() => {
				this.#stopPromise = undefined;
			});
		return this.#stopPromise;
	}

	dispose(): void {
		const generation = this.#generation;
		if (!generation) return;
		generation.unsubscribe?.();
		generation.unsubscribe = undefined;
		generation.controller.abort();
		this.#generation = undefined;
		this.#startPromise = undefined;
		this.#publishStatus({ phase: "disconnected" });
	}

	async #activate(generation: Generation): Promise<void> {
		try {
			if (!Number.isSafeInteger(this.#allowedChatId) || this.#allowedChatId <= 0)
				throw new Error("Invalid Telegram chat configuration.");
			const me = await this.#client.getMe(generation.controller.signal);
			if (!this.#isLive(generation) || !Number.isSafeInteger(me.id) || me.id <= 0 || me.is_bot !== true)
				throw new Error("Telegram bridge activation failed.");

			const webhook = await this.#client.getWebhookInfo(generation.controller.signal);
			if (!this.#isLive(generation) || typeof webhook.url !== "string" || webhook.url.length > 0)
				throw new Error("Telegram bridge activation failed.");

			const tail = await this.#client.getUpdates({
				offset: -1,
				limit: 1,
				timeoutSeconds: 0,
				allowedUpdates: ["message"],
				signal: generation.controller.signal,
			});
			if (!this.#isLive(generation)) return;
			generation.nextOffset = this.#discardTail(tail);

			await this.#client.sendMessage(this.#allowedChatId, CONNECTED_MESSAGE, generation.controller.signal);
			if (!this.#isLive(generation)) return;
			generation.unsubscribe = this.#session.subscribe(event => this.#handleSessionEvent(generation, event));
			if (!this.#isLive(generation)) {
				generation.unsubscribe();
				generation.unsubscribe = undefined;
				return;
			}
			this.#setStatus(generation, { phase: "connected", botUsername: me.username });
			generation.pollPromise = this.#poll(generation);
		} catch {
			if (this.#isCurrent(generation) && !generation.controller.signal.aborted)
				this.#fail(generation, "Telegram bridge could not start.");
			throw new Error("Telegram bridge could not start.");
		}
	}

	#discardTail(tail: TelegramUpdate[]): number | undefined {
		if (!Array.isArray(tail)) throw new Error("Malformed Telegram response.");
		let nextOffset: number | undefined;
		for (const update of tail) {
			if (!this.#isSafeUpdateId(update)) throw new Error("Malformed Telegram response.");
			const candidate = update.update_id + 1;
			if (nextOffset === undefined || candidate > nextOffset) nextOffset = candidate;
		}
		return nextOffset;
	}

	async #poll(generation: Generation): Promise<void> {
		let retryAttempt = 0;
		while (this.#isLive(generation)) {
			try {
				const updates = await this.#client.getUpdates({
					offset: generation.nextOffset,
					timeoutSeconds: TELEGRAM_LONG_POLL_SECONDS,
					allowedUpdates: ["message"],
					signal: generation.controller.signal,
				});
				if (!this.#isLive(generation)) return;
				await this.#processUpdates(generation, updates);
				retryAttempt = 0;
			} catch (error) {
				if (!this.#isLive(generation)) return;
				const retryAfterMs = this.#pollRetryDelay(error, retryAttempt);
				if (retryAfterMs === undefined) {
					this.#fail(generation, "Telegram bridge polling stopped.");
					return;
				}
				this.#setStatus(generation, { phase: "retrying", retryAfterMs });
				try {
					await this.#wait(retryAfterMs, generation.controller.signal);
				} catch {
					return;
				}
				if (!this.#isLive(generation)) return;
				this.#setStatus(generation, { phase: "connected" });
				retryAttempt++;
			}
		}
	}

	async #processUpdates(generation: Generation, updates: TelegramUpdate[]): Promise<void> {
		if (!Array.isArray(updates)) throw new Error("Malformed Telegram response.");
		for (const update of updates) {
			if (!this.#isSafeUpdateId(update)) throw new Error("Malformed Telegram response.");
		}
		for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
			if (!this.#isLive(generation)) return;
			if (generation.nextOffset !== undefined && update.update_id < generation.nextOffset) continue;
			generation.nextOffset = update.update_id + 1;
			const delivery = this.#processUpdate(generation, update);
			if (delivery) await delivery;
		}
	}

	#processUpdate(generation: Generation, update: TelegramUpdate): Promise<void> | undefined {
		const message = update.message;
		if (!message || typeof message !== "object") return;
		const chat = message.chat;
		if (chat?.type !== "private" || chat.id !== this.#allowedChatId || !Number.isSafeInteger(chat.id) || chat.id <= 0)
			return;
		if (typeof message.text !== "string") return;

		const parsed = this.#parseInput(message.text);
		if (parsed.kind === "usage") {
			this.#enqueueOutbound(generation, USAGE_MESSAGE);
			return;
		}
		return this.#deliverInbound(generation, parsed.text, parsed.deliverAs);
	}

	async #deliverInbound(generation: Generation, text: string, deliverAs: "steer" | "followUp"): Promise<void> {
		try {
			if (!this.#isLive(generation)) return;
			const accepted = await this.#session.enqueueUserMessage(text, deliverAs, generation.controller.signal);
			if (!this.#isLive(generation)) return;
			if (!accepted) this.#enqueueOutbound(generation, INPUT_REJECTED_MESSAGE);
		} catch {
			if (this.#isLive(generation)) this.#enqueueOutbound(generation, INPUT_REJECTED_MESSAGE);
		}
	}

	#parseInput(text: string): { kind: "message"; text: string; deliverAs: "steer" | "followUp" } | { kind: "usage" } {
		const command = text.match(/^\/(steer|queue)(?:\s+([\s\S]*))?$/);
		if (command) {
			const content = command[2]?.trim() ?? "";
			if (content.length === 0) return { kind: "usage" };
			return { kind: "message", text: content, deliverAs: command[1] === "queue" ? "followUp" : "steer" };
		}
		if (/^\/(start|help)(?:\s|$)/.test(text)) return { kind: "usage" };
		return { kind: "message", text, deliverAs: "steer" };
	}

	#handleSessionEvent(generation: Generation, event: AgentSessionEvent): void {
		if (!this.#isLive(generation)) return;
		if (event.type === "agent_start") {
			generation.observedAgentStart = true;
			return;
		}
		if (event.type !== "agent_end" || event.isTerminal === false || !generation.observedAgentStart) return;
		generation.observedAgentStart = false;
		let text = "";
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index];
			if (message.role !== "assistant") continue;
			try {
				text = this.#extractAssistantText(message as AssistantMessage);
			} catch {
				text = "";
			}
			if (text.length > 0) break;
		}
		if (text.length > 0 && this.#isLive(generation)) this.#enqueueOutbound(generation, text);
	}

	#enqueueOutbound(generation: Generation, text: string): void {
		if (!this.#isLive(generation)) return;
		const chunks = this.#chunk(text);
		if (chunks.length === 0) return;
		if (
			chunks.length > TELEGRAM_MAX_OUTBOUND_CHUNKS ||
			generation.outbound.length + chunks.length > TELEGRAM_MAX_OUTBOUND_CHUNKS
		) {
			this.#fail(generation, OUTBOUND_OVERFLOW_MESSAGE);
			return;
		}
		generation.outbound.push(...chunks);
		this.#startSender(generation);
	}

	#startSender(generation: Generation): void {
		if (!this.#isLive(generation) || generation.sendPromise || generation.outbound.length === 0) return;
		let drain: Promise<void>;
		drain = this.#send(generation).finally(() => {
			if (generation.sendPromise !== drain) return;
			generation.sendPromise = undefined;
			if (this.#isLive(generation) && generation.outbound.length > 0) this.#startSender(generation);
		});
		generation.sendPromise = drain;
	}

	#chunk(text: string): string[] {
		const codePoints = Array.from(text);
		const chunks: string[] = [];
		for (let index = 0; index < codePoints.length; index += TELEGRAM_MESSAGE_CHUNK_CODE_POINTS) {
			chunks.push(codePoints.slice(index, index + TELEGRAM_MESSAGE_CHUNK_CODE_POINTS).join(""));
		}
		return chunks;
	}

	async #send(generation: Generation): Promise<void> {
		while (this.#isLive(generation) && generation.outbound.length > 0) {
			const head = generation.outbound[0];
			let attempts = 0;
			let waitedMs = 0;
			while (this.#isLive(generation)) {
				attempts++;
				try {
					await this.#client.sendMessage(this.#allowedChatId, head, generation.controller.signal);
					if (!this.#isLive(generation)) return;
					generation.outbound.shift();
					break;
				} catch (error) {
					if (!this.#isLive(generation)) return;
					const retryAfterMs = this.#sendRetryDelay(error);
					if (
						retryAfterMs === undefined ||
						attempts >= TELEGRAM_MAX_SEND_RATE_LIMIT_ATTEMPTS ||
						waitedMs + retryAfterMs > TELEGRAM_MAX_SEND_RATE_LIMIT_WAIT_MS
					) {
						this.#fail(generation, "Telegram bridge could not send a response.");
						return;
					}
					waitedMs += retryAfterMs;
					try {
						await this.#wait(retryAfterMs, generation.controller.signal);
					} catch {
						return;
					}
				}
			}
		}
	}

	#pollRetryDelay(error: unknown, attempt: number): number | undefined {
		if (!this.#isTelegramFailure(error)) return undefined;
		if (error.httpStatus === 429 || error.errorCode === 429)
			return this.#validRetryAfter(error.retryAfterMs) ? Math.min(30_000, error.retryAfterMs) : undefined;
		if (
			error.transport === true ||
			(error.httpStatus !== undefined && error.httpStatus >= 500 && error.httpStatus <= 599)
		) {
			return Math.min(30_000, 250 * 2 ** attempt) * (0.5 + this.#random());
		}
		return undefined;
	}

	#sendRetryDelay(error: unknown): number | undefined {
		if (!this.#isTelegramFailure(error)) return undefined;
		if (error.httpStatus !== 429 && error.errorCode !== 429) return undefined;
		return this.#validRetryAfter(error.retryAfterMs) ? error.retryAfterMs : undefined;
	}

	#validRetryAfter(value: number | undefined): value is number {
		if (typeof value !== "number") return false;
		return Number.isSafeInteger(value) && value > 0 && value <= TELEGRAM_MAX_SEND_RATE_LIMIT_WAIT_MS;
	}

	#isTelegramFailure(value: unknown): value is TelegramApiFailure {
		if (!value || typeof value !== "object") return false;
		const candidate = value as Partial<TelegramApiFailure>;
		return (
			candidate.name === "TelegramApiError" &&
			typeof candidate.method === "string" &&
			typeof candidate.ambiguous === "boolean"
		);
	}

	async #wait(milliseconds: number, signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.reject(new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([this.#delay(milliseconds, signal), abort.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#isSafeUpdateId(update: TelegramUpdate): boolean {
		return (
			Boolean(update) &&
			Number.isSafeInteger(update.update_id) &&
			update.update_id >= 0 &&
			update.update_id < Number.MAX_SAFE_INTEGER
		);
	}

	#isCurrent(generation: Generation): boolean {
		return this.#generation === generation;
	}

	#isLive(generation: Generation): boolean {
		return (
			this.#isCurrent(generation) &&
			!generation.controller.signal.aborted &&
			this.#status.phase !== "failed" &&
			this.#status.phase !== "stopping"
		);
	}

	#setStatus(generation: Generation, status: TelegramBridgeStatus, allowStopping = false): void {
		if (!this.#isCurrent(generation) || generation.controller.signal.aborted) return;
		if (!allowStopping && !this.#isLive(generation)) return;
		this.#publishStatus(status);
	}

	#publishStatus(status: TelegramBridgeStatus): void {
		this.#status = status;
		try {
			this.#onStatus(status);
		} catch {
			// Status consumers must not destabilize the bridge.
		}
	}

	#fail(generation: Generation, message: string): void {
		if (!this.#isCurrent(generation) || generation.controller.signal.aborted) return;
		generation.unsubscribe?.();
		generation.unsubscribe = undefined;
		this.#publishStatus({ phase: "failed", message });
		generation.controller.abort();
	}
}
