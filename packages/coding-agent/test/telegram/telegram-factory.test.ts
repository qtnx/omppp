import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import { createTelegramBridge } from "../../src/telegram/factory";
import type { TelegramBridgeFactoryOptions, TelegramBridgeStatus } from "../../src/telegram/types";
import { TELEGRAM_API_ORIGIN } from "../../src/telegram/types";

const VALID_TOKEN = "123456789:AA_SENTINEL_TOKEN_MUST_NEVER_APPEAR";
const INVALID_TOKEN = "not-a-token";

type FetchCall = {
	input: string | URL | Request;
	init?: RequestInit;
};

class FakeSession {
	readonly sessionId = "session";
	listeners = new Set<(event: AgentSessionEvent) => void>();

	async enqueueUserMessage(_text: string, _deliverAs: "steer" | "followUp"): Promise<boolean> {
		return true;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function factoryOptions(token: string): TelegramBridgeFactoryOptions {
	return {
		token,
		session: new FakeSession() as never,
		allowedChatId: 42,
		extractAssistantText: () => "",
		onStatus: (_status: TelegramBridgeStatus) => {},
		delay: async () => {},
		random: () => 0,
	};
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;

function restoreFetch(): void {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
}

function stubFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): FetchCall[] {
	const calls: FetchCall[] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ input, init });
		return handler(input, init);
	}) as unknown as typeof fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl);
	return calls;
}

function officialApiHandler(input: string | URL | Request): Promise<Response> {
	const url = String(input);
	if (url.endsWith("/getMe")) {
		return Promise.resolve(response({ ok: true, result: { id: 1, is_bot: true, username: "bridge_bot" } }));
	}
	if (url.endsWith("/getWebhookInfo")) {
		return Promise.resolve(response({ ok: true, result: { url: "" } }));
	}
	if (url.endsWith("/getUpdates")) {
		return Promise.resolve(response({ ok: true, result: [] }));
	}
	if (url.endsWith("/sendMessage")) {
		return Promise.resolve(response({ ok: true, result: {} }));
	}
	return Promise.resolve(response({ ok: false, error_code: 404, description: "unexpected" }, 404));
}

afterEach(() => {
	restoreFetch();
});

describe("createTelegramBridge", () => {
	test("returns a bridge that uses the production Bot API client path", async () => {
		const calls = stubFetch(async input => officialApiHandler(input));

		const bridge = createTelegramBridge(factoryOptions(VALID_TOKEN));
		await bridge.start();
		await bridge.stop();
		bridge.dispose();

		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(String(call.input).startsWith(`${TELEGRAM_API_ORIGIN}/bot${VALID_TOKEN}/`)).toBe(true);
		}
		expect(calls.some(call => String(call.input).endsWith("/getMe"))).toBe(true);
	});

	test("rejects an invalid token before any network operation", async () => {
		let calls = 0;
		const impl = (async () => {
			calls++;
			return response({ ok: true, result: {} });
		}) as unknown as typeof fetch;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl);

		const bridge = createTelegramBridge(factoryOptions(INVALID_TOKEN));
		await expect(bridge.start()).rejects.toBeDefined();
		bridge.dispose();

		expect(calls).toBe(0);
	});

	test("does not accept a caller-supplied origin; requests stay on the official Bot API origin", async () => {
		const calls = stubFetch(async input => officialApiHandler(input));

		const options = {
			...factoryOptions(VALID_TOKEN),
			origin: "https://evil.example",
		} as TelegramBridgeFactoryOptions & { origin: string };

		const bridge = createTelegramBridge(options);
		await bridge.start();
		await bridge.stop();
		bridge.dispose();

		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const url = String(call.input);
			expect(url.startsWith(`${TELEGRAM_API_ORIGIN}/`)).toBe(true);
			expect(url.includes("evil.example")).toBe(false);
		}
	});
});
