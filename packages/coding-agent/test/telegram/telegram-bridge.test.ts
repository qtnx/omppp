import { describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import { TelegramBridge } from "../../src/telegram/bridge";
import { TelegramApiError, telegramApiErrorMessage } from "../../src/telegram/client";
import type {
	TelegramApiFailure,
	TelegramBotClientContract,
	TelegramBridgeOptions,
	TelegramBridgeStatus,
	TelegramUpdate,
} from "../../src/telegram/types";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

interface BridgeFixture {
	bridge: TelegramBridge;
	client: FakeClient;
	session: FakeSession;
	statuses: TelegramBridgeStatus[];
	delays: number[];
}

function deferred<T>(): Deferred<T> {
	return Promise.withResolvers<T>();
}

async function flush(): Promise<void> {
	for (let count = 0; count < 10; count++) await Promise.resolve();
}

function telegramFailure(overrides: Partial<TelegramApiFailure>): TelegramApiFailure & Error {
	return new TelegramApiError({
		method: overrides.method ?? "getUpdates",
		httpStatus: overrides.httpStatus,
		errorCode: overrides.errorCode,
		retryAfterMs: overrides.retryAfterMs,
		transport: overrides.transport,
		ambiguous: overrides.ambiguous ?? false,
	});
}

class FakeClient implements TelegramBotClientContract {
	updates: Array<TelegramUpdate[] | Promise<TelegramUpdate[]> | Error> = [];
	getUpdatesCalls: Array<Parameters<TelegramBotClientContract["getUpdates"]>[0]> = [];
	sent: Array<{ chatId: number; text: string }> = [];
	getMeResult = { id: 1, is_bot: true, username: "bot" };
	webhook = { url: "" };
	sendResults: Array<void | Error | Promise<void>> = [];

	async getMe(): Promise<{ id: number; is_bot: boolean; username?: string }> {
		return this.getMeResult;
	}

	async getWebhookInfo(): Promise<{ url: string }> {
		return this.webhook;
	}

	getUpdates(options: Parameters<TelegramBotClientContract["getUpdates"]>[0]): Promise<TelegramUpdate[]> {
		this.getUpdatesCalls.push(options);
		const next = this.updates.shift();
		if (next instanceof Error) return Promise.reject(next);
		if (next) return Promise.resolve(next);
		const pending = Promise.withResolvers<TelegramUpdate[]>();
		options.signal?.addEventListener("abort", () => pending.reject(new DOMException("Aborted", "AbortError")), {
			once: true,
		});
		return pending.promise;
	}

	sendMessage(chatId: number, text: string): Promise<void> {
		this.sent.push({ chatId, text });
		const next = this.sendResults.shift();
		if (next instanceof Error) return Promise.reject(next);
		return next ?? Promise.resolve();
	}
}

class FakeSession {
	readonly sessionId = "session";
	messages: Array<{ text: string; deliverAs: "steer" | "followUp" }> = [];
	listeners = new Set<(event: AgentSessionEvent) => void>();
	enqueueResult: boolean | Error | Promise<boolean> = true;
	enqueueSignals: Array<AbortSignal | undefined> = [];

	async enqueueUserMessage(text: string, deliverAs: "steer" | "followUp", signal?: AbortSignal): Promise<boolean> {
		this.enqueueSignals.push(signal);
		const result = this.enqueueResult;
		if (result instanceof Error) throw result;
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const abort = deferred<never>();
		const onAbort = () => abort.reject(new DOMException("Aborted", "AbortError"));
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const accepted = await Promise.race([Promise.resolve(result), abort.promise]);
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			if (accepted) this.messages.push({ text, deliverAs });
			return accepted;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

function bridgeFixture(overrides: Partial<TelegramBridgeOptions> = {}): BridgeFixture {
	const client = new FakeClient();
	const session = new FakeSession();
	const statuses: TelegramBridgeStatus[] = [];
	const delays: number[] = [];
	const bridge = new TelegramBridge({
		client,
		session: session as never,
		allowedChatId: 42,
		extractAssistantText: message => {
			const content = message.content;
			return Array.isArray(content)
				? content
						.filter(part => part.type === "text")
						.map(part => part.text)
						.join("")
				: "";
		},
		onStatus: status => statuses.push(status),
		delay: async milliseconds => {
			delays.push(milliseconds);
		},
		random: () => 0,
		...overrides,
	});
	return { bridge, client, session, statuses, delays };
}

function update(updateId: number, text: string | undefined, chatId = 42, chatType = "private"): TelegramUpdate {
	return { update_id: updateId, message: { message_id: updateId, text, chat: { id: chatId, type: chatType } } };
}

async function startWithBaseline(fixture: BridgeFixture, tail: TelegramUpdate[] = []): Promise<void> {
	fixture.client.updates.push(tail);
	await fixture.bridge.start();
}

describe("TelegramBridge inbound authorization and ordering", () => {
	it("processes only explicit authorized private messages and advances rejected updates before later authorization", async () => {
		const fixture = bridgeFixture();
		const live = deferred<TelegramUpdate[]>();
		fixture.client.updates.push([], live.promise);
		await fixture.bridge.start();
		live.resolve([
			{ update_id: 11 } as TelegramUpdate,
			update(12, "/queue later", 7),
			update(13, "/queue later"),
			update(13, "duplicate"),
			update(14, "redirect"),
		]);
		await flush();
		expect(fixture.session.messages).toEqual([
			{ text: "later", deliverAs: "followUp" },
			{ text: "redirect", deliverAs: "steer" },
		]);
		expect(fixture.client.getUpdatesCalls.at(-1)?.offset).toBe(15);
		await fixture.bridge.stop();
	});

	it("does not starve an authorized update behind one hundred rejected private-chat IDs", async () => {
		const fixture = bridgeFixture();
		const live = deferred<TelegramUpdate[]>();
		fixture.client.updates.push([], live.promise);
		await fixture.bridge.start();
		live.resolve([
			...Array.from({ length: 100 }, (_, index) => update(index + 1, "ignored", index + 100)),
			update(101, "accepted"),
		]);
		await flush();
		expect(fixture.session.messages).toEqual([{ text: "accepted", deliverAs: "steer" }]);
		expect(fixture.client.getUpdatesCalls.at(-1)?.offset).toBe(102);
		await fixture.bridge.stop();
	});

	it("advances a rejected enqueue and returns a generic safe error without echoing inbound text", async () => {
		const fixture = bridgeFixture();
		fixture.session.enqueueResult = false;
		const live = deferred<TelegramUpdate[]>();
		fixture.client.updates.push([], live.promise);
		await fixture.bridge.start();
		live.resolve([update(1, "sensitive inbound")]);
		await flush();
		expect(fixture.client.getUpdatesCalls.at(-1)?.offset).toBe(2);
		expect(fixture.client.sent.at(-1)).toMatchObject({ chatId: 42 });
		expect(fixture.client.sent.at(-1)?.text).not.toContain("sensitive inbound");
		await fixture.bridge.stop();
	});

	it("fails closed when an update cursor has no safe successor", async () => {
		const fixture = bridgeFixture();
		const live = deferred<TelegramUpdate[]>();
		fixture.client.updates.push([], live.promise);
		await fixture.bridge.start();
		live.resolve([update(Number.MAX_SAFE_INTEGER, "must not enqueue")]);
		await flush();
		expect(fixture.bridge.status.phase).toBe("failed");
		expect(fixture.session.messages).toEqual([]);
		await fixture.bridge.stop();
	});
	it("aborts pending inbound acceptance before stop/restart can mutate either generation", async () => {
		const fixture = bridgeFixture();
		const live = deferred<TelegramUpdate[]>();
		const acceptance = deferred<boolean>();
		fixture.session.enqueueResult = acceptance.promise;
		fixture.client.updates.push([], live.promise);
		await fixture.bridge.start();
		live.resolve([update(1, "stale inbound")]);
		await flush();
		const inboundSignal = fixture.session.enqueueSignals[0];
		expect(inboundSignal).toBe(fixture.client.getUpdatesCalls[1]?.signal);
		expect(inboundSignal?.aborted).toBe(false);

		const stopping = fixture.bridge.stop();
		fixture.client.updates.push([]);
		const restarting = fixture.bridge.start();
		acceptance.resolve(true);
		await Promise.all([stopping, restarting]);
		await flush();

		expect(inboundSignal?.aborted).toBe(true);
		expect(fixture.session.messages).toEqual([]);
		expect(fixture.client.sent.map(message => message.text)).toEqual([
			"Telegram bridge connected.",
			"Telegram bridge connected.",
		]);
		await fixture.bridge.stop();
	});
});

describe("TelegramBridge lifecycle, retries, and outbound FIFO", () => {
	it("discards activation tail, validates the empty webhook, then subscribes and starts one live poll", async () => {
		const fixture = bridgeFixture();
		await startWithBaseline(fixture, [update(40, "old")]);
		expect(fixture.client.getUpdatesCalls[0]).toMatchObject({
			offset: -1,
			limit: 1,
			timeoutSeconds: 0,
			allowedUpdates: ["message"],
		});
		expect(fixture.client.getUpdatesCalls[1]).toMatchObject({
			offset: 41,
			timeoutSeconds: 30,
			allowedUpdates: ["message"],
		});
		expect(fixture.session.listeners.size).toBe(1);
		await fixture.bridge.stop();
	});

	it("never starts when a webhook is configured", async () => {
		const fixture = bridgeFixture();
		fixture.client.webhook = { url: "configured" };
		await expect(fixture.bridge.start()).rejects.toThrow();
		expect(fixture.client.getUpdatesCalls).toEqual([]);
		expect(fixture.session.listeners.size).toBe(0);
	});

	it("rethrows a Telegram API startup failure and publishes its safe cause", async () => {
		const fixture = bridgeFixture();
		const failure = new TelegramApiError({
			method: "sendMessage",
			httpStatus: 400,
			errorCode: 400,
			description: "Bad Request: chat not found",
			ambiguous: false,
		});
		const safeCause = telegramApiErrorMessage(failure);
		if (!safeCause) throw new Error("Expected a safe Telegram API failure cause.");
		expect(safeCause).toContain("chat not found");
		fixture.client.updates.push([]);
		fixture.client.sendResults.push(failure);

		await expect(fixture.bridge.start()).rejects.toBe(failure);
		expect(fixture.bridge.status).toEqual({ phase: "failed", message: safeCause });
		await fixture.bridge.stop();
	});

	it("publishes a terminal 409 poll cause that identifies another poller", async () => {
		const fixture = bridgeFixture();
		const failure = new TelegramApiError({
			method: "getUpdates",
			httpStatus: 409,
			errorCode: 409,
			ambiguous: false,
		});
		const safeCause = telegramApiErrorMessage(failure);
		if (!safeCause) throw new Error("Expected a safe Telegram API failure cause.");
		fixture.client.updates.push([], failure);

		await fixture.bridge.start();
		await flush();

		expect(fixture.bridge.status).toEqual({ phase: "failed", message: safeCause });
		expect(safeCause.toLowerCase()).toContain("another poller");
		await fixture.bridge.stop();
	});

	it("publishes a safe terminal send cause without outbound content", async () => {
		const fixture = bridgeFixture();
		const failure = new TelegramApiError({
			method: "sendMessage",
			httpStatus: 400,
			errorCode: 400,
			ambiguous: false,
		});
		const safeCause = telegramApiErrorMessage(failure);
		if (!safeCause) throw new Error("Expected a safe Telegram API failure cause.");
		fixture.client.updates.push([]);
		await fixture.bridge.start();
		fixture.client.sendResults.push(failure);
		fixture.session.emit({ type: "agent_start" } as AgentSessionEvent);
		fixture.session.emit({
			type: "agent_end",
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "private model output" }] } as AssistantMessage,
			],
		} as AgentSessionEvent);
		await flush();

		expect(fixture.bridge.status).toEqual({ phase: "failed", message: safeCause });
		expect(JSON.stringify(fixture.statuses)).not.toContain("private model output");
		await fixture.bridge.stop();
	});

	it("retries only validated getUpdates rate limits with backoff and stops ambiguous outbound sends", async () => {
		const fixture = bridgeFixture();
		const poll429 = telegramFailure({ method: "getUpdates", errorCode: 429, httpStatus: 429, retryAfterMs: 500 });
		const outboundTimeout = telegramFailure({ method: "sendMessage", ambiguous: true });
		fixture.client.updates.push([], poll429 as never, []);
		await fixture.bridge.start();
		await flush();
		expect(fixture.delays).toEqual([500]);
		fixture.client.sendResults.push(outboundTimeout as never);
		fixture.session.emit({ type: "agent_start" } as AgentSessionEvent);
		fixture.session.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "output" }] } as AssistantMessage],
		} as AgentSessionEvent);
		await flush();
		expect(fixture.client.sent.at(-1)?.text).toBe("output");
		expect(fixture.bridge.status.phase).toBe("failed");
		await fixture.bridge.stop();
	});

	it("retries transport failures while polling but never retries an ambiguous transport send", async () => {
		const fixture = bridgeFixture();
		const pollTransport = telegramFailure({ method: "getUpdates", transport: true, ambiguous: false });
		const nextPoll = deferred<TelegramUpdate[]>();
		fixture.client.updates.push([], pollTransport as never, nextPoll.promise);
		await fixture.bridge.start();
		await flush();
		expect(fixture.delays).toEqual([125]);
		expect(fixture.client.getUpdatesCalls).toHaveLength(3);

		fixture.client.sendResults.push(
			telegramFailure({ method: "sendMessage", transport: true, ambiguous: true }) as never,
		);
		fixture.session.emit({ type: "agent_start" } as AgentSessionEvent);
		fixture.session.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "transport output" }] } as AssistantMessage],
		} as AgentSessionEvent);
		await flush();
		expect(fixture.client.sent.filter(message => message.text === "transport output")).toHaveLength(1);
		expect(fixture.bridge.status.phase).toBe("failed");
		nextPoll.resolve([]);
		await fixture.bridge.stop();
	});

	it("removes the retry wait abort listener as soon as the delay settles", async () => {
		const waitStarted = deferred<void>();
		const waitGate = deferred<void>();
		const fixture = bridgeFixture({
			delay: async () => {
				waitStarted.resolve();
				await waitGate.promise;
			},
		});
		const pollFailure = deferred<TelegramUpdate[]>();
		const nextPoll = deferred<TelegramUpdate[]>();
		fixture.client.updates.push([], pollFailure.promise, nextPoll.promise);
		await fixture.bridge.start();

		const signal = fixture.client.getUpdatesCalls[1]?.signal;
		if (!signal) throw new Error("Expected bridge generation signal.");
		const addSpy = vi.spyOn(signal, "addEventListener");
		const removeSpy = vi.spyOn(signal, "removeEventListener");

		pollFailure.reject(telegramFailure({ method: "getUpdates", transport: true }));
		await waitStarted.promise;
		const retryAbortListener = addSpy.mock.calls.find(([type]) => type === "abort")?.[1];
		expect(retryAbortListener).toBeDefined();
		expect(removeSpy.mock.calls.find(([type]) => type === "abort")).toBeUndefined();
		waitGate.resolve();
		await flush();
		const removedListener = removeSpy.mock.calls.find(([type]) => type === "abort")?.[1];
		expect(removedListener).toBe(retryAbortListener);

		fixture.bridge.dispose();
		nextPoll.resolve([]);
		await flush();
	});

	it("redrains output enqueued after an empty drain settles but before its finally callback", async () => {
		const fixture = bridgeFixture();
		const firstSend = deferred<void>();
		await startWithBaseline(fixture);
		fixture.client.sendResults.push(firstSend.promise);
		fixture.session.emit({ type: "agent_start" } as AgentSessionEvent);
		fixture.session.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "first" }] } as AssistantMessage],
		} as AgentSessionEvent);
		await flush();
		firstSend.promise.then(() => {
			fixture.session.emit({ type: "agent_start" } as AgentSessionEvent);
			fixture.session.emit({
				type: "agent_end",
				messages: [{ role: "assistant", content: [{ type: "text", text: "second" }] } as AssistantMessage],
			} as AgentSessionEvent);
		});
		firstSend.resolve();
		await flush();

		expect(fixture.client.sent.slice(1).map(message => message.text)).toEqual(["first", "second"]);
		await fixture.bridge.stop();
	});

	it("never redrains a stopped generation while restart waits for its stale sender", async () => {
		const fixture = bridgeFixture();
		const staleSend = deferred<void>();
		await startWithBaseline(fixture);
		fixture.client.sendResults.push(staleSend.promise);
		for (const text of ["stale head", "stale queued"]) {
			fixture.session.emit({ type: "agent_start" } as AgentSessionEvent);
			fixture.session.emit({
				type: "agent_end",
				messages: [{ role: "assistant", content: [{ type: "text", text }] } as AssistantMessage],
			} as AgentSessionEvent);
		}
		await flush();

		const stopping = fixture.bridge.stop();
		fixture.client.updates.push([]);
		const restarting = fixture.bridge.start();
		staleSend.resolve();
		await Promise.all([stopping, restarting]);
		await flush();

		expect(fixture.client.sent.map(message => message.text)).toEqual([
			"Telegram bridge connected.",
			"stale head",
			"Telegram bridge connected.",
		]);
		await fixture.bridge.stop();
	});
	it("mirrors only terminal turns started in the enabled generation and chunks complete Unicode finals atomically", async () => {
		const fixture = bridgeFixture();
		await startWithBaseline(fixture);
		fixture.session.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "orphan" }] } as AssistantMessage],
		} as AgentSessionEvent);
		fixture.session.emit({ type: "agent_start" } as AgentSessionEvent);
		const text = `${"a".repeat(3_999)}😀z`;
		fixture.session.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text }] } as AssistantMessage],
		} as AgentSessionEvent);
		await flush();
		const chunks = fixture.client.sent.slice(1);
		expect(chunks.map(chunk => chunk.text)).toEqual([`${"a".repeat(3_999)}😀`, "z"]);
		expect(chunks.every(chunk => Array.from(chunk.text).length <= 4_000)).toBe(true);
		await fixture.bridge.stop();
	});

	it("drops an over-capacity final without a partial send", async () => {
		const fixture = bridgeFixture();
		const sendGate = deferred<void>();
		await startWithBaseline(fixture);
		fixture.client.sendResults.push(sendGate.promise);
		fixture.session.emit({ type: "agent_start" } as AgentSessionEvent);
		fixture.session.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "head" }] } as AssistantMessage],
		} as AgentSessionEvent);
		await flush();
		fixture.session.emit({ type: "agent_start" } as AgentSessionEvent);
		fixture.session.emit({
			type: "agent_end",
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "x".repeat(4_000 * 32 + 1) }] } as AssistantMessage,
			],
		} as AgentSessionEvent);
		await flush();
		expect(fixture.client.sent).toHaveLength(2);
		sendGate.resolve();
		await fixture.bridge.stop();
	});
});
