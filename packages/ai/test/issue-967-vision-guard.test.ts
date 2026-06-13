import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { convertMessages as convertGoogleMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertMessages as convertOpenAICompletionsMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	appendResponsesToolResultMessages,
	convertResponsesInputContent,
} from "@oh-my-pi/pi-ai/providers/openai-responses-shared";
import { NON_VISION_IMAGE_PLACEHOLDER, UNAVAILABLE_IMAGE_PLACEHOLDER } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { Api, AssistantMessage, Context, Model, ModelSpec, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: ResolvedOpenAICompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsMultipleSystemMessages: true,
	supportsReasoningEffort: true,
	supportsReasoningParams: true,
	alwaysSendMaxTokens: false,
	isOpenRouterHost: false,
	isVercelGatewayHost: false,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	supportsToolChoice: true,
	disableReasoningOnForcedToolChoice: false,
	disableReasoningOnToolChoice: false,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	reasoningContentField: "reasoning_content",
	requiresReasoningContentForToolCalls: false,
	allowsSyntheticReasoningContentForToolCalls: true,
	requiresAssistantContentForToolCalls: false,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	extraBody: {},
	supportsStrictMode: true,
	toolStrictMode: "none",
};

function makeModel<TApi extends Api>(
	api: TApi,
	provider: Model["provider"],
	input: ModelSpec<TApi>["input"] = ["text"],
): Model<TApi> {
	return buildModel({
		id: `${provider}-${api}-${input.includes("image") ? "vision" : "text-only"}`,
		name: `${provider} ${api}`,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as ModelSpec<TApi>);
}

function makeAssistant(api: Model["api"], provider: Model["provider"], modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "python", arguments: { code: "plot()" } }],
		api,
		provider,
		model: modelId,
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function makeToolResult(content: ToolResultMessage["content"]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "python",
		content,
		isError: false,
		timestamp: 3,
	};
}

function countTaggedValues(value: unknown, tag: string): number {
	if (Array.isArray(value)) {
		return value.reduce((sum, item) => sum + countTaggedValues(item, tag), 0);
	}
	if (!value || typeof value !== "object") {
		return 0;
	}
	const record = value as Record<string, unknown>;
	const own = record.type === tag ? 1 : 0;
	return Object.values(record).reduce<number>((sum, item) => sum + countTaggedValues(item, tag), own);
}

function countStringValuesContaining(value: unknown, needle: string): number {
	if (Array.isArray(value)) {
		return value.reduce((sum, item) => sum + countStringValuesContaining(item, needle), 0);
	}
	if (!value || typeof value !== "object") {
		return typeof value === "string" && value.includes(needle) ? 1 : 0;
	}
	return Object.values(value).reduce<number>((sum, item) => sum + countStringValuesContaining(item, needle), 0);
}

function countObjectKeys(value: unknown, key: string): number {
	if (Array.isArray(value)) {
		return value.reduce((sum, item) => sum + countObjectKeys(item, key), 0);
	}
	if (!value || typeof value !== "object") {
		return 0;
	}
	const record = value as Record<string, unknown>;
	const own = Object.hasOwn(record, key) ? 1 : 0;
	return Object.values(record).reduce<number>((sum, item) => sum + countObjectKeys(item, key), own);
}

function countObjectPropertiesEqual(value: unknown, key: string, expected: unknown): number {
	if (Array.isArray(value)) {
		return value.reduce((sum, item) => sum + countObjectPropertiesEqual(item, key, expected), 0);
	}
	if (!value || typeof value !== "object") {
		return 0;
	}
	const record = value as Record<string, unknown>;
	const own = record[key] === expected ? 1 : 0;
	return Object.values(record).reduce<number>(
		(sum, item) => sum + countObjectPropertiesEqual(item, key, expected),
		own,
	);
}

describe("issue #967 vision guard", () => {
	it("strips non-vision images from OpenAI chat-completions user and tool-result payloads", () => {
		const model = makeModel("openai-completions", "openrouter");
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "plot summary" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					timestamp: 1,
				},
				makeAssistant(model.api, model.provider, model.id),
				makeToolResult([
					{ type: "text", text: "saved plot to /tmp/plot.png" },
					{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
				]),
			],
		};

		const messages = convertOpenAICompletionsMessages(model, context, compat);
		expect(countTaggedValues(messages, "image_url")).toBe(0);
		expect(messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "plot summary" },
				{ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER },
			],
		});
		expect(messages.find(message => message.role === "tool")).toMatchObject({
			content: `saved plot to /tmp/plot.png\n${NON_VISION_IMAGE_PLACEHOLDER}`,
		});
	});

	it("strips non-vision images from OpenAI responses payload builders", () => {
		const model = makeModel("openai-responses", "openrouter");
		const userContent = convertResponsesInputContent(
			[
				{ type: "text", text: "plot summary" },
				{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
			],
			false,
		);
		expect(countTaggedValues(userContent, "input_image")).toBe(0);
		expect(userContent).toEqual([
			{ type: "input_text", text: "plot summary" },
			{ type: "input_text", text: NON_VISION_IMAGE_PLACEHOLDER },
		]);

		const payload: unknown[] = [];
		appendResponsesToolResultMessages(
			payload as never,
			makeToolResult([
				{ type: "text", text: "saved plot to /tmp/plot.png" },
				{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
			]),
			model,
			true,
			new Set(["call_1"]),
		);
		expect(countTaggedValues(payload, "input_image")).toBe(0);
		expect(payload).toEqual([
			{
				type: "function_call_output",
				call_id: "call_1",
				output: `saved plot to /tmp/plot.png\n${NON_VISION_IMAGE_PLACEHOLDER}`,
			},
		]);
	});

	it("strips non-vision images from Codex responses user and tool-result payloads", () => {
		const model = makeModel("openai-codex-responses", "openai-codex");
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "plot summary" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					timestamp: 1,
				},
				makeAssistant(model.api, model.provider, model.id),
				makeToolResult([{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }]),
			],
		};

		const messages = convertCodexResponsesMessages(model, context);
		expect(countTaggedValues(messages, "input_image")).toBe(0);
		expect(messages.filter(item => (item as { role?: string }).role === "user")).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			role: "user",
			content: [
				{ type: "input_text", text: "plot summary" },
				{ type: "input_text", text: NON_VISION_IMAGE_PLACEHOLDER },
			],
		});
		expect(messages.find(item => (item as { type?: string }).type === "function_call_output")).toMatchObject({
			output: NON_VISION_IMAGE_PLACEHOLDER,
		});
	});

	it("omits unavailable blob-backed images from vision-capable OpenAI responses payloads", () => {
		const missingBlobRef = "blob:sha256:missing";
		const emptyImageData = "";
		const truncatedImageData = "ZmFrZQ==\n\n[Session persistence truncated large content]";
		const wrappedMissingBlobRef = `data:image/png;base64,${missingBlobRef}`;
		const emptyDataUrl = "data:image/png;base64,";
		const truncatedImageUrl = `data:image/png;base64,${truncatedImageData}`;
		const responsesContent = convertResponsesInputContent(
			[
				{ type: "text", text: "plot summary" },
				{ type: "image", mimeType: "image/png", data: missingBlobRef },
				{ type: "image", mimeType: "image/png", data: emptyImageData },
				{ type: "image", mimeType: "image/png", data: truncatedImageData },
			],
			true,
		);
		expect(countTaggedValues(responsesContent, "input_image")).toBe(0);
		expect(responsesContent).toEqual([
			{ type: "input_text", text: "plot summary" },
			{ type: "input_text", text: UNAVAILABLE_IMAGE_PLACEHOLDER },
		]);

		const responsesModel = makeModel("openai-responses", "openai", ["text", "image"]);
		const payload: unknown[] = [];
		appendResponsesToolResultMessages(
			payload as never,
			makeToolResult([
				{ type: "image", mimeType: "image/png", data: missingBlobRef },
				{ type: "image", mimeType: "image/png", data: emptyImageData },
				{ type: "image", mimeType: "image/png", data: truncatedImageData },
			]),
			responsesModel,
			true,
			new Set(["call_1"]),
		);
		expect(countTaggedValues(payload, "input_image")).toBe(0);
		expect(payload).toEqual([
			{
				type: "function_call_output",
				call_id: "call_1",
				output: UNAVAILABLE_IMAGE_PLACEHOLDER,
			},
		]);

		const codexModel = makeModel("openai-codex-responses", "openai-codex", ["text", "image"]);
		const messages = convertCodexResponsesMessages(codexModel, {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "plot summary" },
						{ type: "image", mimeType: "image/png", data: missingBlobRef },
						{ type: "image", mimeType: "image/png", data: emptyImageData },
						{ type: "image", mimeType: "image/png", data: truncatedImageData },
					],
					timestamp: 1,
				},
				makeAssistant(codexModel.api, codexModel.provider, codexModel.id),
				makeToolResult([
					{ type: "image", mimeType: "image/png", data: missingBlobRef },
					{ type: "image", mimeType: "image/png", data: emptyImageData },
					{ type: "image", mimeType: "image/png", data: truncatedImageData },
				]),
				{
					role: "user",
					content: "replayed image should be sanitized",
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai-codex",
						items: [
							{
								type: "message",
								role: "user",
								content: [
									{ type: "input_text", text: "replayed" },
									{ type: "input_image", detail: "auto", image_url: missingBlobRef },
									{ type: "input_image", detail: "auto", image_url: emptyImageData },
									{ type: "input_image", detail: "auto", image_url: wrappedMissingBlobRef },
									{ type: "input_image", detail: "auto", image_url: emptyDataUrl },
									{ type: "input_image", detail: "auto", image_url: truncatedImageUrl },
								],
							},
						],
					},
					timestamp: 4,
				},
			],
		});
		expect(countTaggedValues(messages, "input_image")).toBe(0);
		expect(countObjectKeys(messages, "image_url")).toBe(0);
		expect(messages).toContainEqual({
			role: "user",
			content: [
				{ type: "input_text", text: "plot summary" },
				{ type: "input_text", text: UNAVAILABLE_IMAGE_PLACEHOLDER },
			],
		});
		expect(messages).toContainEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: UNAVAILABLE_IMAGE_PLACEHOLDER,
		});
		expect(messages).toContainEqual({
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "replayed" },
				{ type: "input_text", text: UNAVAILABLE_IMAGE_PLACEHOLDER },
			],
		});
	});
	it("keeps valid Responses images while omitting unavailable ones", () => {
		const validImageData = "ZmFrZQ==";
		const missingBlobRef = "blob:sha256:missing";
		const emptyImageData = "";
		const validImageUrl = `data:image/png;base64,${validImageData}`;
		const responsesContent = convertResponsesInputContent(
			[
				{ type: "text", text: "plot summary" },
				{ type: "image", mimeType: "image/png", data: validImageData },
				{ type: "image", mimeType: "image/png", data: missingBlobRef },
			],
			true,
		);

		expect(countTaggedValues(responsesContent, "input_image")).toBe(1);
		expect(countStringValuesContaining(responsesContent, `data:image/png;base64,${validImageData}`)).toBe(1);
		expect(countStringValuesContaining(responsesContent, "blob:")).toBe(0);
		expect(responsesContent).toContainEqual({ type: "input_text", text: UNAVAILABLE_IMAGE_PLACEHOLDER });

		const model = makeModel("openai-responses", "openai", ["text", "image"]);
		const payload: unknown[] = [];
		appendResponsesToolResultMessages(
			payload as never,
			makeToolResult([
				{ type: "image", mimeType: "image/png", data: validImageData },
				{ type: "image", mimeType: "image/png", data: missingBlobRef },
				{ type: "image", mimeType: "image/png", data: emptyImageData },
			]),
			model,
			true,
			new Set(["call_1"]),
		);
		expect(countTaggedValues(payload, "input_image")).toBe(1);
		expect(countStringValuesContaining(payload, `data:image/png;base64,${validImageData}`)).toBe(1);
		expect(countStringValuesContaining(payload, "blob:")).toBe(0);
		expect(payload[0]).toMatchObject({
			type: "function_call_output",
			output: `(see attached image)\n${UNAVAILABLE_IMAGE_PLACEHOLDER}`,
		});

		const codexModel = makeModel("openai-codex-responses", "openai-codex", ["text", "image"]);
		const replayMessages = convertCodexResponsesMessages(codexModel, {
			messages: [
				{
					role: "user",
					content: "replayed image should be sanitized",
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai-codex",
						items: [
							{
								type: "message",
								role: "user",
								content: [
									{ type: "input_text", text: "replayed" },
									{ type: "input_image", detail: "auto", image_url: validImageUrl },
									{ type: "input_image", detail: "auto", image_url: missingBlobRef },
									{ type: "input_image", detail: "auto", image_url: emptyImageData },
								],
							},
						],
					},
					timestamp: 1,
				},
			],
		});
		expect(countTaggedValues(replayMessages, "input_image")).toBe(1);
		expect(countStringValuesContaining(replayMessages, validImageUrl)).toBe(1);
		expect(countStringValuesContaining(replayMessages, "blob:")).toBe(0);
		expect(replayMessages).toContainEqual({
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "replayed" },
				{ type: "input_image", detail: "auto", image_url: validImageUrl },
				{ type: "input_text", text: UNAVAILABLE_IMAGE_PLACEHOLDER },
			],
		});
	});

	it("omits unavailable images from other vision-capable providers while keeping valid images", () => {
		const validImageData = "ZmFrZQ==";
		const missingBlobRef = "blob:sha256:missing";
		const emptyImageData = "";
		const messages: Context["messages"] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "plot summary" },
					{ type: "image", mimeType: "image/png", data: validImageData },
					{ type: "image", mimeType: "image/png", data: missingBlobRef },
					{ type: "image", mimeType: "image/png", data: emptyImageData },
				],
				timestamp: 1,
			},
			makeAssistant("openai-completions", "openrouter", "openrouter-openai-completions-vision"),
			makeToolResult([
				{ type: "image", mimeType: "image/png", data: validImageData },
				{ type: "image", mimeType: "image/png", data: missingBlobRef },
				{ type: "image", mimeType: "image/png", data: emptyImageData },
			]),
		];

		const completionsModel = makeModel("openai-completions", "openrouter", ["text", "image"]);
		const completionsMessages = convertOpenAICompletionsMessages(completionsModel, { messages }, compat);
		expect(countStringValuesContaining(completionsMessages, "blob:")).toBe(0);
		expect(
			countStringValuesContaining(completionsMessages, `data:image/png;base64,${validImageData}`),
		).toBeGreaterThan(0);
		expect(countStringValuesContaining(completionsMessages, UNAVAILABLE_IMAGE_PLACEHOLDER)).toBeGreaterThan(0);
		expect(countObjectPropertiesEqual(completionsMessages, "url", "data:image/png;base64,")).toBe(0);

		const anthropicModel = makeModel("anthropic-messages", "anthropic", ["text", "image"]);
		const anthropicMessages = convertAnthropicMessages(messages, anthropicModel, true);
		expect(countStringValuesContaining(anthropicMessages, "blob:")).toBe(0);
		expect(countStringValuesContaining(anthropicMessages, validImageData)).toBeGreaterThan(0);
		expect(countStringValuesContaining(anthropicMessages, UNAVAILABLE_IMAGE_PLACEHOLDER)).toBeGreaterThan(0);
		expect(countObjectPropertiesEqual(anthropicMessages, "data", "")).toBe(0);

		const googleModel = makeModel("google-generative-ai", "google", ["text", "image"]);
		const googleMessages = convertGoogleMessages(googleModel, { messages });
		expect(countStringValuesContaining(googleMessages, "blob:")).toBe(0);
		expect(countStringValuesContaining(googleMessages, validImageData)).toBeGreaterThan(0);
		expect(countStringValuesContaining(googleMessages, UNAVAILABLE_IMAGE_PLACEHOLDER)).toBeGreaterThan(0);
		expect(countObjectPropertiesEqual(googleMessages, "data", "")).toBe(0);
	});

	it("strips non-vision images from Anthropic payloads", () => {
		const model = makeModel("anthropic-messages", "anthropic");
		const messages = convertAnthropicMessages(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "plot summary" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					timestamp: 1,
				},
				makeAssistant(model.api, model.provider, model.id),
				makeToolResult([{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }]),
			],
			model,
			false,
		);
		expect(countTaggedValues(messages, "image")).toBe(0);
		expect(messages[0]).toMatchObject({ role: "user", content: `plot summary\n${NON_VISION_IMAGE_PLACEHOLDER}` });
		const toolResult = messages.at(-1) as { role: string; content: Array<{ type: string; content: unknown }> };
		expect(toolResult.role).toBe("user");
		expect(toolResult.content[0]).toMatchObject({
			type: "tool_result",
			content: NON_VISION_IMAGE_PLACEHOLDER,
		});
	});

	it("strips non-vision images from Google payloads", () => {
		const model = makeModel("google-generative-ai", "google");
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "plot summary" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
					],
					timestamp: 1,
				},
				makeAssistant(model.api, model.provider, model.id),
				makeToolResult([{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }]),
			],
		};

		const messages = convertGoogleMessages(model, context);
		expect(countObjectKeys(messages, "inlineData")).toBe(0);
		expect(messages[0]).toMatchObject({
			role: "user",
			parts: [{ text: "plot summary" }, { text: NON_VISION_IMAGE_PLACEHOLDER }],
		});
		expect(messages.at(-1)).toMatchObject({
			role: "user",
			parts: [
				{
					functionResponse: {
						response: { output: NON_VISION_IMAGE_PLACEHOLDER },
					},
				},
			],
		});
	});
});
