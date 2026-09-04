import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

type AnthropicWireBlock = { type: string; signature?: string };

type AnthropicWireMessage = {
	role: string;
	content: AnthropicWireBlock[] | string;
};

type AnthropicRequestBody = {
	messages: AnthropicWireMessage[];
};

function wireBlocks(body: AnthropicRequestBody | undefined, messageIndex: number): AnthropicWireBlock[] | undefined {
	const content = body?.messages[messageIndex]?.content;
	return Array.isArray(content) ? content : undefined;
}

function hasBoundThinking(body: AnthropicRequestBody | undefined): boolean {
	return !!wireBlocks(body, 1)?.some(block => block.type === "thinking" && block.signature === "sig-1");
}

const bundledModel = getBundledModel("anthropic", "claude-opus-4-6") as Model<"anthropic-messages">;
const model: Model<"anthropic-messages"> = {
	...bundledModel,
	provider: "custom-anthropic",
	baseUrl: "https://llm.example.com/anthropic",
	compat: {
		...bundledModel.compat,
		officialEndpoint: false,
		signingEndpoint: false,
		replayUnsignedThinking: true,
	},
};

const messages: Context["messages"] = [
	{ role: "user", content: "hi", timestamp: 1 },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "secret plan", thinkingSignature: "sig-1" },
			{ type: "text", text: "answer" },
		],
		api: "anthropic-messages",
		provider: "custom-anthropic",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	},
];

function context(systemPrompt: string): Context {
	return { systemPrompt: [systemPrompt], messages };
}

function response(inputTransformations?: Array<Record<string, string>>): Response {
	const sourceUsage = { input_tokens: 1, output_tokens: 1 };
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_prefix_drop",
				model: model.id,
				role: "assistant",
				content: [],
				usage: sourceUsage,
				...(inputTransformations && { input_transformations: inputTransformations }),
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: sourceUsage },
		{ type: "message_stop" },
	];
	const body = `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_prefix_drop" },
	});
}

/** The hard prefix-binding rejection: signature invalid AND bound elsewhere. */
function prefixBindingRejection(): Response {
	return new Response(
		JSON.stringify({
			error: {
				type: "invalid_request_error",
				message: "messages.1.content.0: Invalid `signature` in `thinking` block: bound to a different conversation",
			},
		}),
		{
			status: 400,
			headers: { "Content-Type": "application/json", "request-id": "req_prefix_binding_reject" },
		},
	);
}

async function request(
	fetch: FetchImpl,
	providerSessionState: Map<string, ProviderSessionState>,
	sessionId: string,
	systemPrompt: string,
): Promise<void> {
	const stream = streamSimple(model, context(systemPrompt), {
		apiKey: "test-anthropic-key",
		fetch,
		providerSessionState,
		sessionId,
		providerRetryWait: async () => {},
	});
	for await (const _event of stream) {
		// Drain the real provider stream so input transformations are recorded.
	}
	await stream.result();
}

describe("Anthropic prefix-dropped thinking isolation", () => {
	it("drop_block reports never rewrite the wire", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const bodies: AnthropicRequestBody[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as AnthropicRequestBody);
			return response(
				bodies.length === 2
					? [{ type: "thinking_dropped", reason: "prefix_binding_mismatch", path: "messages.1.content.0" }]
					: undefined,
			);
		};

		try {
			await request(fetch, providerSessionState, "main", "main system");
			await request(fetch, providerSessionState, "advisor", "advisor system");
			await request(fetch, providerSessionState, "main", "main system");
			await request(fetch, providerSessionState, "advisor", "advisor system");

			// No client-side omission and no retry: the reported drop is free on the
			// API side, so the bytes stay byte-identical to the cached prefix.
			expect(bodies.length).toBe(4);
			expect(hasBoundThinking(bodies[0])).toBe(true);
			expect(hasBoundThinking(bodies[2])).toBe(true);
			expect(hasBoundThinking(bodies[3])).toBe(true);
		} finally {
			for (const state of providerSessionState.values()) state.close();
		}
	});

	it("a hard prefix-binding rejection strips blocks only for that prefix", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const bodies: AnthropicRequestBody[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as AnthropicRequestBody);
			return bodies.length === 2 ? prefixBindingRejection() : response();
		};

		try {
			await request(fetch, providerSessionState, "main", "main system");
			await request(fetch, providerSessionState, "advisor", "advisor system");
			await request(fetch, providerSessionState, "main", "main system");
			await request(fetch, providerSessionState, "advisor", "advisor system");

			// main, advisor(400), advisor(retry), main, advisor.
			expect(bodies.length).toBe(5);
			expect(hasBoundThinking(bodies[1])).toBe(true);
			// The retry omits the rejected block onward, and the memory keyed on the
			// advisor prefix keeps omitting it on the later advisor request.
			expect(wireBlocks(bodies[2], 1)?.filter(block => block.type.includes("thinking"))).toEqual([]);
			expect(wireBlocks(bodies[4], 1)?.filter(block => block.type.includes("thinking"))).toEqual([]);
			// The main prefix never saw a rejection, so its bytes are untouched.
			expect(hasBoundThinking(bodies[0])).toBe(true);
			expect(hasBoundThinking(bodies[3])).toBe(true);
		} finally {
			for (const state of providerSessionState.values()) state.close();
		}
	});
});
