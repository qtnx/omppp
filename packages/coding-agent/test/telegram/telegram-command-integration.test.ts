import { describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { TelegramCommandController } from "../../src/modes/controllers/telegram-command-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import { TelegramBridge } from "../../src/telegram/bridge";
import { TelegramBotClient } from "../../src/telegram/client";
import type {
	CreateTelegramBridge,
	TelegramBridgeHandle,
	TelegramMethod,
	TelegramUpdate,
} from "../../src/telegram/types";

const TOKEN = "123456789:AA_SENTINEL_TOKEN_MUST_NEVER_APPEAR";
const CHAT_ID = 42;
const JSON_HEADERS = { "content-type": "application/json" };

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
};

type CapturedRequest = {
	method: TelegramMethod;
	body: Record<string, unknown>;
	methodCall: number;
};

type RequestHandler = (request: CapturedRequest) => Response | Promise<Response>;

type RequestWaiter = {
	method: TelegramMethod;
	count: number;
	deferred: Deferred<CapturedRequest>;
};

type BotApiStub = {
	server: Bun.Server<undefined>;
	origin: string;
	requests: CapturedRequest[];
	waitFor(method: TelegramMethod, count: number): Promise<CapturedRequest>;
};

type ControlledPoll = {
	respond(payload: unknown, status?: number): void;
	responded: Promise<void>;
};

class Recorder<T> {
	readonly values: T[] = [];
	readonly #waiters = new Map<number, Deferred<void>[]>();

	push(value: T): void {
		this.values.push(value);
		for (const [count, waiters] of this.#waiters) {
			if (this.values.length < count) continue;
			this.#waiters.delete(count);
			for (const waiter of waiters) waiter.resolve();
		}
	}

	waitForLength(count: number): Promise<void> {
		if (this.values.length >= count) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		const waiters = this.#waiters.get(count) ?? [];
		waiters.push(waiter);
		this.#waiters.set(count, waiters);
		return waiter.promise;
	}
}

class FakeSession {
	readonly sessionId = "telegram-integration";
	readonly enqueueCalls = new Recorder<{ text: string; deliverAs: "steer" | "followUp" }>();
	readonly acceptedMessages: Array<{ text: string; deliverAs: "steer" | "followUp" }> = [];
	readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	readonly historicalListeners: Array<(event: AgentSessionEvent) => void> = [];
	accept = true;

	async enqueueUserMessage(text: string, deliverAs: "steer" | "followUp"): Promise<boolean> {
		const message = { text, deliverAs };
		this.enqueueCalls.push(message);
		if (this.accept) this.acceptedMessages.push(message);
		return this.accept;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		this.historicalListeners.push(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

type StandardStub = BotApiStub & { polls: ControlledPoll[] };

type IntegrationHarness = {
	stub: StandardStub;
	controller: TelegramCommandController;
	session: FakeSession;
	statuses: Recorder<string>;
	errors: Recorder<string>;
	bridges: TelegramBridgeHandle[];
};

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function isTelegramMethod(value: string | undefined): value is TelegramMethod {
	return value === "getMe" || value === "getWebhookInfo" || value === "getUpdates" || value === "sendMessage";
}

function startBotApiStub(handler: RequestHandler): BotApiStub {
	const requests: CapturedRequest[] = [];
	const waiters: RequestWaiter[] = [];
	const counts = new Map<TelegramMethod, number>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(rawRequest) {
			const method = new URL(rawRequest.url).pathname.split("/").at(-1);
			if (!isTelegramMethod(method) || rawRequest.method !== "POST")
				return new Response("not found", { status: 404 });
			const parsed = await rawRequest.json();
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return new Response("bad request", { status: 400 });
			const captured: CapturedRequest = {
				method,
				body: parsed as Record<string, unknown>,
				methodCall: (counts.get(method) ?? 0) + 1,
			};
			counts.set(method, captured.methodCall);
			requests.push(captured);
			for (let index = waiters.length - 1; index >= 0; index--) {
				const waiter = waiters[index];
				if (!waiter || waiter.method !== method || captured.methodCall < waiter.count) continue;
				waiters.splice(index, 1);
				waiter.deferred.resolve(captured);
			}
			return handler(captured);
		},
	});
	if (typeof server.port !== "number") {
		server.stop(true);
		throw new Error("Bun did not assign a loopback port");
	}
	return {
		server,
		origin: `http://127.0.0.1:${server.port}`,
		requests,
		waitFor(method, count) {
			const existing = requests.filter(request => request.method === method)[count - 1];
			if (existing) return Promise.resolve(existing);
			const deferred = Promise.withResolvers<CapturedRequest>();
			waiters.push({ method, count, deferred });
			return deferred.promise;
		},
	};
}

function startStandardStub(
	options: {
		webhookUrl?: string;
		activation?: () => Response | Promise<Response>;
		send?: (request: CapturedRequest) => Response | Promise<Response>;
	} = {},
): StandardStub {
	const polls: ControlledPoll[] = [];
	const stub = startBotApiStub(async request => {
		switch (request.method) {
			case "getMe":
				return json({ ok: true, result: { id: 7, is_bot: true, username: "integration_bot" } });
			case "getWebhookInfo":
				return json({ ok: true, result: { url: options.webhookUrl ?? "" } });
			case "getUpdates": {
				if (request.body.timeout === 0) return options.activation?.() ?? json({ ok: true, result: [] });
				const response = Promise.withResolvers<Response>();
				const responded = Promise.withResolvers<void>();
				polls.push({
					respond(payload, status = 200) {
						response.resolve(json(payload, status));
					},
					responded: responded.promise,
				});
				const result = await response.promise;
				responded.resolve();
				return result;
			}
			case "sendMessage":
				return options.send?.(request) ?? json({ ok: true, result: { message_id: request.methodCall } });
		}
	});
	return { ...stub, polls };
}

function assistantEvent(type: "agent_start"): AgentSessionEvent;
function assistantEvent(type: "agent_end", text: string): AgentSessionEvent;
function assistantEvent(type: "agent_start" | "agent_end", text = ""): AgentSessionEvent {
	if (type === "agent_start") return { type: "agent_start" } as AgentSessionEvent;
	return {
		type: "agent_end",
		isTerminal: true,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as AssistantMessage],
	} as AgentSessionEvent;
}

function createHarness(stub: StandardStub, options: { token?: string; accept?: boolean } = {}): IntegrationHarness {
	const session = new FakeSession();
	session.accept = options.accept ?? true;
	const statuses = new Recorder<string>();
	const errors = new Recorder<string>();
	const bridges: TelegramBridgeHandle[] = [];
	const context = {
		session,
		extractAssistantText(message: AssistantMessage) {
			return Array.isArray(message.content)
				? message.content
						.filter(part => part.type === "text")
						.map(part => part.text)
						.join("")
				: "";
		},
		showStatus(message: string) {
			statuses.push(message);
		},
		showError(message: string) {
			errors.push(message);
		},
	} as unknown as InteractiveModeContext;
	const createBridge: CreateTelegramBridge = bridgeOptions => {
		const bridge = new TelegramBridge({
			...bridgeOptions,
			client: new TelegramBotClient(bridgeOptions.token, { origin: stub.origin, timeoutMs: 60_000 }),
			delay: async () => {},
			random: () => 0,
		});
		bridges.push(bridge);
		return bridge;
	};
	const controller = new TelegramCommandController(context, {
		env: {
			OMP_TELEGRAM_BOT_TOKEN: options.token ?? TOKEN,
			OMP_TELEGRAM_ALLOWED_CHAT_ID: String(CHAT_ID),
		},
		createBridge,
	});
	return { stub, controller, session, statuses, errors, bridges };
}

async function stopHarness(harness: IntegrationHarness): Promise<void> {
	try {
		await harness.controller.stop();
	} finally {
		harness.controller.dispose();
		harness.stub.server.stop(true);
	}
}

function inbound(updateId: number, text: string, chatId = CHAT_ID, chatType = "private"): TelegramUpdate {
	return {
		update_id: updateId,
		message: { message_id: updateId, text, chat: { id: chatId, type: chatType } },
	};
}

function sendBodies(stub: BotApiStub): Array<{ chat_id: number; text: string }> {
	return stub.requests
		.filter(request => request.method === "sendMessage")
		.map(request => request.body as { chat_id: number; text: string });
}

function diagnostics(harness: IntegrationHarness, warnings: unknown[][]): string {
	return JSON.stringify({ statuses: harness.statuses.values, errors: harness.errors.values, warnings });
}

describe("Telegram command integration over Bot API HTTP", () => {
	it("serializes concurrent activation and advances one hundred unauthorized updates before ordered queue and steer delivery", async () => {
		const harness = createHarness(startStandardStub());
		try {
			await Promise.all([harness.controller.handleCommand("on"), harness.controller.handleCommand("on")]);
			await harness.stub.waitFor("getUpdates", 2);

			const rejected: TelegramUpdate[] = Array.from({ length: 100 }, (_, index) => {
				if (index % 3 === 0) return { update_id: index };
				if (index % 3 === 1) return inbound(index, "private rejected", CHAT_ID, "group");
				return inbound(index, "private rejected", CHAT_ID + 1);
			});
			harness.stub.polls[0]?.respond({
				ok: true,
				result: [...rejected, inbound(100, "/queue build later"), inbound(101, "redirect now")].reverse(),
			});
			await harness.session.enqueueCalls.waitForLength(2);
			const nextPoll = await harness.stub.waitFor("getUpdates", 3);

			expect(harness.stub.requests.filter(request => request.method === "getMe")).toHaveLength(1);
			expect(harness.stub.requests.filter(request => request.method === "getWebhookInfo")).toHaveLength(1);
			expect(harness.stub.requests.filter(request => request.method === "getUpdates")[0]?.body).toEqual({
				offset: -1,
				limit: 1,
				timeout: 0,
				allowed_updates: ["message"],
			});
			expect(harness.session.acceptedMessages).toEqual([
				{ text: "build later", deliverAs: "followUp" },
				{ text: "redirect now", deliverAs: "steer" },
			]);
			expect(nextPoll.body.offset).toBe(102);
			expect(sendBodies(harness.stub)).toEqual([{ chat_id: CHAT_ID, text: "Telegram bridge connected." }]);
		} finally {
			await stopHarness(harness);
		}
	});

	it("chunks terminal output in Unicode FIFO order and fences old poll and callback work across off then on", async () => {
		const harness = createHarness(startStandardStub());
		try {
			await harness.controller.handleCommand("on");
			await harness.stub.waitFor("getUpdates", 2);
			const oldPoll = harness.stub.polls[0];
			const oldListener = harness.session.historicalListeners[0];
			if (!oldPoll || !oldListener) throw new Error("old Telegram generation did not establish its live boundaries");

			const output = `${"a".repeat(3_999)}😀${"b".repeat(4_000)}z`;
			harness.session.emit(assistantEvent("agent_start"));
			harness.session.emit(assistantEvent("agent_end", output));
			await harness.stub.waitFor("sendMessage", 4);
			const chunks = sendBodies(harness.stub)
				.slice(1)
				.map(request => request.text);
			expect(chunks.join("")).toBe(output);
			expect(chunks).toHaveLength(3);
			expect(chunks.every(chunk => Array.from(chunk).length <= 4_000)).toBe(true);

			await harness.controller.handleCommand("off");
			const frozen = {
				requests: harness.stub.requests.length,
				sends: sendBodies(harness.stub).length,
				messages: harness.session.acceptedMessages.length,
				statuses: harness.statuses.values.length,
			};
			oldPoll.respond({ ok: true, result: [inbound(200, "stale inbound")] });
			await oldPoll.responded;
			oldListener(assistantEvent("agent_start"));
			oldListener(assistantEvent("agent_end", "stale output"));
			await Promise.resolve();
			expect({
				requests: harness.stub.requests.length,
				sends: sendBodies(harness.stub).length,
				messages: harness.session.acceptedMessages.length,
				statuses: harness.statuses.values.length,
			}).toEqual(frozen);

			await harness.controller.handleCommand("on");
			await harness.stub.waitFor("getUpdates", 4);
			const newPoll = harness.stub.polls[1];
			if (!newPoll) throw new Error("new Telegram generation did not start a live poll");
			newPoll.respond({ ok: true, result: [inbound(300, "fresh inbound")] });
			await harness.session.enqueueCalls.waitForLength(1);
			expect(harness.session.acceptedMessages).toEqual([{ text: "fresh inbound", deliverAs: "steer" }]);
			expect(harness.stub.requests.filter(request => request.method === "getMe")).toHaveLength(2);
			expect(sendBodies(harness.stub).filter(request => request.text === "Telegram bridge connected.")).toHaveLength(
				2,
			);
		} finally {
			await stopHarness(harness);
		}
	});

	it.each([
		{
			name: "active webhook",
			stub: () => startStandardStub({ webhookUrl: `https://private.invalid/${TOKEN}` }),
			methods: ["getMe", "getWebhookInfo"],
			errorFragments: [
				"Telegram could not start, so no Telegram messages are connected. Check the Telegram configuration and try /telegram on again.",
			],
		},
		{
			name: "409 conflict",
			stub: () =>
				startStandardStub({ activation: () => json({ ok: false, error_code: 409, description: TOKEN }, 409) }),
			methods: ["getMe", "getWebhookInfo", "getUpdates"],
			errorFragments: [
				"Telegram could not start:",
				"Telegram Bot API getUpdates failed: HTTP 409",
				"another poller is using the same bot token",
			],
		},
		{
			name: "malformed envelope",
			stub: () => startStandardStub({ activation: () => json({ result: [] }) }),
			methods: ["getMe", "getWebhookInfo", "getUpdates"],
			errorFragments: ["Telegram could not start:", "Telegram Bot API getUpdates failed: HTTP 200"],
		},
		{
			name: "unsafe update id",
			stub: () =>
				startStandardStub({
					activation: () => json({ ok: true, result: [{ update_id: Number.MAX_SAFE_INTEGER + 1 }] }),
				}),
			methods: ["getMe", "getWebhookInfo", "getUpdates"],
			errorFragments: [
				"Telegram could not start, so no Telegram messages are connected. Check the Telegram configuration and try /telegram on again.",
			],
		},
	])(
		"fails closed on $name without webhook mutation, retries, or sensitive diagnostics",
		async ({ stub, methods, errorFragments }) => {
			const harness = createHarness(stub());
			const warnings: unknown[][] = [];
			const warn = spyOn(logger, "warn").mockImplementation((...values: unknown[]) => warnings.push(values));
			try {
				await harness.controller.handleCommand("on");
				expect(harness.stub.requests.map(request => request.method)).toEqual([...methods]);
				expect(harness.session.enqueueCalls.values).toEqual([]);
				expect(sendBodies(harness.stub)).toEqual([]);
				for (const errorFragment of errorFragments) {
					expect(harness.errors.values.at(-1)).toContain(errorFragment);
				}
				const captured = diagnostics(harness, warnings);
				expect(captured).not.toContain(TOKEN);
				expect(captured).not.toContain("private.invalid");
			} finally {
				warn.mockRestore();
				await stopHarness(harness);
			}
		},
	);

	it("advances an accepted-chat update that session preflight rejects without mutating the session or echoing content", async () => {
		const harness = createHarness(startStandardStub(), { accept: false });
		try {
			await harness.controller.handleCommand("on");
			await harness.stub.waitFor("getUpdates", 2);
			harness.stub.polls[0]?.respond({ ok: true, result: [inbound(10, "sensitive inbound content")] });
			await harness.session.enqueueCalls.waitForLength(1);
			await harness.stub.waitFor("sendMessage", 2);
			const nextPoll = await harness.stub.waitFor("getUpdates", 3);

			expect(harness.session.acceptedMessages).toEqual([]);
			expect(harness.session.enqueueCalls.values).toEqual([
				{ text: "sensitive inbound content", deliverAs: "steer" },
			]);
			expect(nextPoll.body.offset).toBe(11);
			expect(sendBodies(harness.stub).at(-1)).toEqual({
				chat_id: CHAT_ID,
				text: "Telegram could not queue that message.",
			});
			expect(JSON.stringify({ statuses: harness.statuses.values, errors: harness.errors.values })).not.toContain(
				"sensitive inbound content",
			);
		} finally {
			await stopHarness(harness);
		}
	});

	it("rejects a final larger than thirty-two chunks atomically without sending any part of it", async () => {
		const harness = createHarness(startStandardStub());
		const warnings: unknown[][] = [];
		const warn = spyOn(logger, "warn").mockImplementation((...values: unknown[]) => warnings.push(values));
		try {
			await harness.controller.handleCommand("on");
			await harness.stub.waitFor("getUpdates", 2);
			harness.session.emit(assistantEvent("agent_start"));
			harness.session.emit(assistantEvent("agent_end", "private output ".padEnd(4_000 * 32 + 1, "x")));
			await harness.errors.waitForLength(1);

			expect(sendBodies(harness.stub)).toEqual([{ chat_id: CHAT_ID, text: "Telegram bridge connected." }]);
			expect(harness.controller.status.phase).toBe("failed");
			const captured = diagnostics(harness, warnings);
			expect(captured).not.toContain(TOKEN);
			expect(captured).not.toContain("private output");
		} finally {
			warn.mockRestore();
			await stopHarness(harness);
		}
	});

	it.each([
		{
			name: "repeated 429",
			response: () => json({ ok: false, error_code: 429, parameters: { retry_after: 1 }, description: TOKEN }),
			expectedAttempts: 5,
		},
		{
			name: "ambiguous 502",
			response: () => json({ description: TOKEN }, 502),
			expectedAttempts: 1,
		},
	])(
		"stops an atomic multi-chunk final after $name without retry storm or later chunks",
		async ({ response, expectedAttempts }) => {
			let sendCall = 0;
			const stub = startStandardStub({
				send: () => {
					sendCall++;
					return sendCall === 1 ? json({ ok: true, result: { message_id: 1 } }) : response();
				},
			});
			const harness = createHarness(stub);
			const warnings: unknown[][] = [];
			const warn = spyOn(logger, "warn").mockImplementation((...values: unknown[]) => warnings.push(values));
			try {
				await harness.controller.handleCommand("on");
				await harness.stub.waitFor("getUpdates", 2);
				const output = `${"q".repeat(4_000)}private-final-tail`;
				harness.session.emit(assistantEvent("agent_start"));
				harness.session.emit(assistantEvent("agent_end", output));
				await harness.errors.waitForLength(1);

				const outputAttempts = sendBodies(harness.stub).slice(1);
				expect(outputAttempts).toHaveLength(expectedAttempts);
				expect(outputAttempts.every(request => request.text === "q".repeat(4_000))).toBe(true);
				expect(outputAttempts.some(request => request.text.includes("private-final-tail"))).toBe(false);
				expect(harness.controller.status.phase).toBe("failed");
				const captured = diagnostics(harness, warnings);
				expect(captured).not.toContain(TOKEN);
				expect(captured).not.toContain("private-final-tail");
			} finally {
				warn.mockRestore();
				await stopHarness(harness);
			}
		},
	);
});
