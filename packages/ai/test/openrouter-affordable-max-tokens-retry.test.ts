/**
 * Contracts for `withOpenRouterAffordableMaxTokensRetry`:
 * OpenRouter 402s a request that reserved more output tokens than the
 * remaining credit can cover (`can only afford N`). The wrapper retries that
 * error once with an explicit `maxTokens = N` so the same credential can
 * complete instead of failing the turn or rotating accounts.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Usage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	type OpenRouterAffordableMaxTokensOptions,
	withOpenRouterAffordableMaxTokensRetry,
} from "@oh-my-pi/pi-ai/utils/openrouter-affordable-max-tokens";

const CTX = {} as Context;
const AFFORD_402 =
	"402 This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 28945. To increase, visit https://openrouter.ai/settings/credits and add more credits";

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(texts: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: texts.map(text => ({ type: "text" as const, text })),
		api: "openai-completions",
		provider: "openrouter",
		model: "deepseek/deepseek-v4-pro-0813",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function streamFromEvents(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	return stream;
}

function errorAttempt(message: string, status = 402): AssistantMessageEventStream {
	const error = assistant();
	error.stopReason = "error";
	error.errorMessage = message;
	error.errorStatus = status;
	return streamFromEvents([
		{ type: "start", partial: error },
		{ type: "error", reason: "error", error },
	] as unknown as AssistantMessageEvent[]);
}

function contentAttempt(): AssistantMessageEventStream {
	const message = assistant(["review ok"]);
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: "review ok", partial: message },
		{ type: "text_end", contentIndex: 0, content: "review ok", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("withOpenRouterAffordableMaxTokensRetry", () => {
	it("retries a 402 afford error once with the advertised remaining budget", async () => {
		const attempts: Array<{ maxTokens?: number; maxTokensExplicit?: boolean }> = [];
		const stream = withOpenRouterAffordableMaxTokensRetry(
			{},
			CTX,
			undefined,
			(_model, _ctx, options?: OpenRouterAffordableMaxTokensOptions) => {
				attempts.push({ maxTokens: options?.maxTokens, maxTokensExplicit: options?.maxTokensExplicit });
				return attempts.length === 1 ? errorAttempt(AFFORD_402) : contentAttempt();
			},
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toEqual([
			{ maxTokens: undefined, maxTokensExplicit: undefined },
			{ maxTokens: 28_945, maxTokensExplicit: true },
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "review ok" }]);
		expect(events.some(event => event.type === "error")).toBe(false);
	});

	it("does not retry when the request already asked for at most the affordable budget", async () => {
		let attempts = 0;
		const stream = withOpenRouterAffordableMaxTokensRetry(
			{},
			CTX,
			{ maxTokens: 16_000, maxTokensExplicit: true },
			() => {
				attempts++;
				return errorAttempt(AFFORD_402);
			},
		);

		const result = await stream.result();
		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("can only afford 28945");
	});

	it("does not retry a non-afford 402", async () => {
		let attempts = 0;
		const stream = withOpenRouterAffordableMaxTokensRetry({}, CTX, {}, () => {
			attempts++;
			return errorAttempt("402 Grok Build usage balance exhausted");
		});

		const result = await stream.result();
		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("usage balance exhausted");
	});
});
