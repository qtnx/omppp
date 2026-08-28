import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import {
	ANTHROPIC_PREFIX_WARMUP_FOLLOWER_TIMEOUT_MS,
	ANTHROPIC_PREFIX_WARMUP_LIFETIME_MS,
	createAnthropicPrefixWarmupCoordinator,
	getAnthropicPrefixWarmupKey,
} from "@oh-my-pi/pi-ai/providers/anthropic-prefix-warmup";
import type { MessageCreateParamsStreaming } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

type Timer = { at: number; callback: () => void; cancelled: boolean };

function createClock() {
	let now = 0;
	const timers: Timer[] = [];
	return {
		clock: () => now,
		setTimeout(callback: () => void, delay: number) {
			const timer: Timer = { at: now + delay, callback, cancelled: false };
			timers.push(timer);
			return timer;
		},
		clearTimeout(handle: unknown) {
			(handle as Timer).cancelled = true;
		},
		advance(ms: number) {
			now += ms;
			for (const timer of timers.splice(0)) {
				if (!timer.cancelled && timer.at <= now) timer.callback();
				else if (!timer.cancelled) timers.push(timer);
			}
		},
	};
}

async function settle() {
	await Promise.resolve();
	await Promise.resolve();
}

function params(scope: "global" | null = "global", model = "claude-sonnet-4-5"): MessageCreateParamsStreaming {
	return {
		model,
		messages: [{ role: "user", content: "request" }],
		system: [
			{
				type: "text",
				text: "stable prefix",
				...(scope ? { cache_control: { type: "ephemeral" as const, scope } } : {}),
			},
		],
		tools: [{ name: "tool", input_schema: { type: "object", properties: { value: { type: "string" } } } }],
		max_tokens: 1,
		stream: true,
	};
}

const integrationModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const globalContext = {
	systemPrompt: ["Stable instructions."],
	systemPromptCache: { globalPrefixBlocks: 1 },
	messages: [{ role: "user", content: "Use the shared prefix.", timestamp: 1 }],
} as Context & { systemPromptCache: { globalPrefixBlocks: number } };

function completedResponse(id: string): Response {
	const usage = {
		input_tokens: 0,
		output_tokens: 1,
		cache_read_input_tokens: 1_200,
		cache_creation_input_tokens: 0,
	};
	const events = [
		{ type: "message_start", message: { id, usage } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
		{ type: "message_stop" },
	];
	const body = `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": id },
	});
}

function runProviderRequest(fetch: FetchImpl, accountUuid: string, sessionId: string, signal?: AbortSignal) {
	return streamSimple(integrationModel, globalContext, {
		fetch,
		apiKey: "sk-ant-oat-test",
		cacheRetention: "long",
		metadata: { account_uuid: accountUuid },
		sessionId,
		signal,
	}).result();
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(message);
}

describe("Anthropic global prefix warmup", () => {
	it("allows one leader to start while identical followers wait until the first response", async () => {
		const clock = createClock();
		const coordinator = createAnthropicPrefixWarmupCoordinator(clock);
		const key = getAnthropicPrefixWarmupKey(params(), "https://api.anthropic.com", "account-a");
		expect(key).toBeDefined();
		let fetchCalls = 0;
		let respond!: () => void;
		const response = new Promise<void>(resolve => (respond = resolve));
		const request = async () => {
			const lease = await coordinator.acquire(key!, new AbortController().signal);
			fetchCalls++;
			try {
				await response;
				lease.markReady();
			} catch (error) {
				lease.release();
				throw error;
			}
		};
		const leader = request();
		await settle();
		const follower = request();
		await settle();
		expect(fetchCalls).toBe(1);
		respond();
		await Promise.all([leader, follower]);
		expect(fetchCalls).toBe(2);
	});

	it("releases followers when the leader fails, and does not wait during the warm window", async () => {
		const clock = createClock();
		const coordinator = createAnthropicPrefixWarmupCoordinator(clock);
		const key = getAnthropicPrefixWarmupKey(params(), "https://api.anthropic.com", "account-a")!;
		let fetchCalls = 0;
		let fail!: (error: Error) => void;
		const failure = new Promise<void>((_, reject) => (fail = reject));
		const request = async (shouldFail = false) => {
			const lease = await coordinator.acquire(key, new AbortController().signal);
			fetchCalls++;
			try {
				if (shouldFail) await failure;
				else lease.markReady();
			} catch (error) {
				lease.release();
				throw error;
			}
		};
		const leader = request(true);
		await settle();
		const follower = request();
		fail(new Error("leader failed"));
		await expect(leader).rejects.toThrow("leader failed");
		await follower;
		expect(fetchCalls).toBe(2);
		await request();
		expect(fetchCalls).toBe(3);
		clock.advance(ANTHROPIC_PREFIX_WARMUP_LIFETIME_MS);
		await request(true).catch(() => {});
		expect(fetchCalls).toBe(4);
	});

	it("times out followers, separates keys, and bypasses non-global markers", async () => {
		const clock = createClock();
		const coordinator = createAnthropicPrefixWarmupCoordinator(clock);
		const key = getAnthropicPrefixWarmupKey(params(), "https://api.anthropic.com", "account-a")!;
		const otherModel = getAnthropicPrefixWarmupKey(
			params("global", "claude-opus-4-1"),
			"https://api.anthropic.com",
			"account-a",
		)!;
		const otherAccount = getAnthropicPrefixWarmupKey(params(), "https://api.anthropic.com", "account-b")!;
		const otherFeature = getAnthropicPrefixWarmupKey(params(), "https://api.anthropic.com", "account-a", [
			"effort-2025-11-24",
		])!;
		const noGlobal = getAnthropicPrefixWarmupKey(params(null), "https://api.anthropic.com", "account-a");
		expect(noGlobal).toBeUndefined();
		expect(otherModel).not.toBe(key);
		expect(otherAccount).not.toBe(key);
		expect(otherFeature).not.toBe(key);
		const leader = await coordinator.acquire(key, new AbortController().signal);
		const follower = coordinator.acquire(key, new AbortController().signal);
		await settle();
		expect(await Promise.race([follower.then(() => "resolved"), Promise.resolve("waiting")])).toBe("waiting");
		clock.advance(ANTHROPIC_PREFIX_WARMUP_FOLLOWER_TIMEOUT_MS);
		await follower;
		leader.release();
	});

	it("holds a same-prefix provider request until the leader receives HTTP response headers", async () => {
		const leaderResponse = Promise.withResolvers<Response>();
		let fetchCalls = 0;
		const fetch: FetchImpl = async () => {
			fetchCalls += 1;
			return fetchCalls === 1 ? leaderResponse.promise : completedResponse(`req_warm_${fetchCalls}`);
		};
		const accountUuid = "10000000-0000-4000-8000-000000000001";

		const leader = runProviderRequest(fetch, accountUuid, "20000000-0000-4000-8000-000000000001");
		await waitFor(() => fetchCalls === 1, "leader request never reached fetch");
		const follower = runProviderRequest(fetch, accountUuid, "20000000-0000-4000-8000-000000000002");
		for (let turn = 0; turn < 10; turn++) await Promise.resolve();
		expect(fetchCalls).toBe(1);

		leaderResponse.resolve(completedResponse("req_warm_1"));
		await waitFor(() => fetchCalls === 2, "follower remained blocked after leader response");
		await Promise.all([leader, follower]);

		const warmFollower = runProviderRequest(fetch, accountUuid, "20000000-0000-4000-8000-000000000003");
		await waitFor(() => fetchCalls === 3, "warm request was unexpectedly held");
		await warmFollower;
	});

	it("releases a same-prefix provider follower when the leader is aborted", async () => {
		let fetchCalls = 0;
		const fetch: FetchImpl = async (input, init) => {
			fetchCalls += 1;
			if (fetchCalls > 1) return completedResponse(`req_abort_${fetchCalls}`);
			const signal = input instanceof Request ? input.signal : init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		};
		const accountUuid = "10000000-0000-4000-8000-000000000002";
		const controller = new AbortController();
		const leader = runProviderRequest(
			fetch,
			accountUuid,
			"30000000-0000-4000-8000-000000000001",
			controller.signal,
		).catch(() => undefined);
		await waitFor(() => fetchCalls === 1, "abort leader request never reached fetch");
		const follower = runProviderRequest(fetch, accountUuid, "30000000-0000-4000-8000-000000000002");
		for (let turn = 0; turn < 10; turn++) await Promise.resolve();
		expect(fetchCalls).toBe(1);

		controller.abort();
		await waitFor(() => fetchCalls === 2, "follower remained blocked after leader abort");
		await Promise.all([leader, follower]);
	});
});
