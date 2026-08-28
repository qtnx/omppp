import { describe, expect, it } from "bun:test";
import { generateSummary } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";

const model = {
	id: "claude-sonnet-4-6",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	maxTokens: 8192,
	contextWindow: 200_000,
} as unknown as Model;

const messages = [
	{ role: "user", content: "Investigate the cache miss.", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "I found the cause." }], timestamp: 2 },
] as unknown as AgentMessage[];

const liveContext: Context = {
	systemPrompt: ["Live provider system prompt."],
	tools: [
		{
			name: "read",
			description: "Read a file.",
			parameters: { type: "object", properties: {} },
		},
	],
	messages: messages as unknown as Context["messages"],
};

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as unknown as Usage;
}

function success(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "anthropic",
		model: model.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function failure(status = 400): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		provider: "anthropic",
		model: model.id,
		usage: usage(),
		stopReason: "error",
		errorMessage: "cache-sharing request rejected",
		errorStatus: status,
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function firstMessageText(context: Context): string {
	const content = context.messages[0]?.content;
	if (typeof content === "string") return content;
	for (const block of content ?? []) {
		if (block.type === "text") return block.text;
	}
	return "";
}

describe("Anthropic compaction cache sharing", () => {
	it("uses the live cached prefix and leaves its final summary instruction outside the cache boundary", async () => {
		const requests: Array<{ context: Context; options: SimpleStreamOptions }> = [];
		const summary = await generateSummary(messages, model, 10_000, "test-key", undefined, undefined, undefined, {
			liveContext,
			oneshotRetry: false,
			completeImpl: async (_model, context, options) => {
				requests.push({ context, options });
				return success("cached-prefix summary");
			},
		});

		expect(summary).toBe("cached-prefix summary");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.context.systemPrompt).toEqual(liveContext.systemPrompt);
		expect(requests[0]?.context.tools).toEqual(liveContext.tools);
		expect(requests[0]?.context.messages).toHaveLength(liveContext.messages.length + 1);
		expect(requests[0]?.options.toolChoice).toBe("none");
		expect(requests[0]?.options.anthropicCacheMessageBoundary).toBe("before-final-message");
	});

	it("falls back once to serialized history when the cache-sharing request is rejected", async () => {
		const requests: Context[] = [];
		const summary = await generateSummary(messages, model, 10_000, "test-key", undefined, undefined, undefined, {
			liveContext,
			oneshotRetry: false,
			completeImpl: async (_model, context) => {
				requests.push(context);
				return requests.length === 1 ? failure() : success("fallback summary");
			},
		});

		expect(summary).toBe("fallback summary");
		expect(requests).toHaveLength(2);
		expect(requests[0]?.systemPrompt).toEqual(liveContext.systemPrompt);
		expect(requests[1]?.systemPrompt).not.toEqual(liveContext.systemPrompt);
		expect(firstMessageText(requests[1] as Context)).toContain("<conversation>");
	});

	it("does not replay transient failures through the uncached legacy path", async () => {
		let calls = 0;
		const attempt = generateSummary(messages, model, 10_000, "test-key", undefined, undefined, undefined, {
			liveContext,
			oneshotRetry: false,
			completeImpl: async () => {
				calls += 1;
				return failure(529);
			},
		});

		await expect(attempt).rejects.toThrow("cache-sharing request rejected");
		expect(calls).toBe(1);
	});

	it("propagates abort instead of falling back from a failed cache-sharing attempt", async () => {
		const controller = new AbortController();
		let calls = 0;
		const attempt = generateSummary(messages, model, 10_000, "test-key", controller.signal, undefined, undefined, {
			liveContext,
			oneshotRetry: false,
			completeImpl: async () => {
				calls += 1;
				controller.abort();
				return failure();
			},
		});

		await expect(attempt).rejects.toThrow("cache-sharing request rejected");
		expect(calls).toBe(1);
	});

	it("keeps legacy serialized history when no live context is available", async () => {
		let request: Context | undefined;
		await generateSummary(messages, model, 10_000, "test-key", undefined, undefined, undefined, {
			oneshotRetry: false,
			completeImpl: async (_model, context) => {
				request = context;
				return success("legacy summary");
			},
		});

		expect(request?.systemPrompt).not.toEqual(liveContext.systemPrompt);
		expect(request ? firstMessageText(request) : "").toContain("<conversation>");
	});
});
