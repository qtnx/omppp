import { describe, expect, test } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const singleUserContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

interface ResponsesPayload {
	input?: unknown[];
	include?: string[];
	reasoning?: { effort?: string; summary?: string };
}

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function captureSimpleResponsesPayload(model: Model<"openai-responses">): Promise<ResponsesPayload> {
	const { promise, resolve } = Promise.withResolvers<ResponsesPayload>();
	streamSimple(model, singleUserContext, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as ResponsesPayload),
	});
	return promise;
}

describe("xAI OAuth Responses reasoning payload (regression)", () => {
	test("xai-oauth/grok-4.5 leaves reasoning unset when no reasoning was requested", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		if (!grok45) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, undefined, undefined);

		expect(params.reasoning).toBeUndefined();
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("streamSimple preserves encrypted reasoning replay while 4.6 adds its concise default", async () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		const grok46 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.6");
		if (!grok45 || !grok46) throw new Error("xai-oauth/grok-4.5 and grok-4.6 must be in bundled models.json");

		const payload45 = await captureSimpleResponsesPayload(grok45);
		const payload46 = await captureSimpleResponsesPayload(grok46);

		expect(payload45.reasoning).toEqual({ effort: "high" });
		expect(payload45.include).toContain("reasoning.encrypted_content");
		expect(payload46.reasoning).toEqual({ effort: "high", summary: "concise" });
		expect(payload46.include).toContain("reasoning.encrypted_content");
	});

	test("xai-oauth/grok-4.5 omits unsupported reasoning summary", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		if (!grok45) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.High }, undefined);

		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("paid xai/grok-4.5 omits unsupported reasoning summary", () => {
		const grok45 = getBundledModel<"openai-responses">("xai", "grok-4.5");
		if (!grok45) throw new Error("xai/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.High }, undefined);

		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("paid xai/grok-4.5 omits presence_penalty on reasoning models", () => {
		const grok45 = getBundledModel<"openai-responses">("xai", "grok-4.5");
		if (!grok45) throw new Error("xai/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(
			grok45,
			singleUserContext,
			{ reasoning: Effort.High, presencePenalty: 0.4, temperature: 0.2 },
			undefined,
		);

		expect(params).not.toHaveProperty("presence_penalty");
		expect(params.temperature).toBe(0.2);
	});

	test("paid xai/grok-2 omits presence_penalty on non-reasoning Responses models", () => {
		const grok2 = getBundledModel<"openai-responses">("xai", "grok-2");
		if (!grok2) throw new Error("xai/grok-2 must be in bundled models.json");

		const { params } = buildParams(grok2, singleUserContext, { presencePenalty: 0.4, temperature: 0.2 }, undefined);

		expect(params).not.toHaveProperty("presence_penalty");
		expect(params.temperature).toBe(0.2);
	});

	test("paid xai/grok-4.5 clamps minimal reasoning effort to low", () => {
		const grok45 = getBundledModel<"openai-responses">("xai", "grok-4.5");
		if (!grok45) throw new Error("xai/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.Minimal }, undefined);

		expect(params.reasoning).toEqual({ effort: "low" });
	});

	test("xai-oauth/grok-4.5 clamps minimal reasoning effort to low", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		if (!grok45) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.Minimal }, undefined);

		expect(params.reasoning).toEqual({ effort: "low" });
	});

	test("xai-oauth/grok-4.5 replays encrypted reasoning on the next turn", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		if (!grok45) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, followUpContextWithEncryptedReasoning(grok45), undefined, undefined);

		expect(params.include).toContain("reasoning.encrypted_content");
		expect(findEncryptedReasoning(params.input)).toEqual({
			type: "reasoning",
			id: "rs_xai_next_turn",
			encrypted_content: "enc_next_turn",
		});
	});

	test("paid xai/grok-4.5 replays encrypted reasoning on the next turn", () => {
		const grok45 = getBundledModel<"openai-responses">("xai", "grok-4.5");
		if (!grok45) throw new Error("xai/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, followUpContextWithEncryptedReasoning(grok45), undefined, undefined);

		expect(findEncryptedReasoning(params.input)).toEqual({
			type: "reasoning",
			id: "rs_xai_next_turn",
			encrypted_content: "enc_next_turn",
		});
	});

	test("xai-oauth/grok-4.6 sends reasoning.effort xhigh and omits max", () => {
		const grok46 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.6");
		if (!grok46) throw new Error("xai-oauth/grok-4.6 must be in bundled models.json");

		const { params } = buildParams(grok46, singleUserContext, { reasoning: Effort.XHigh }, undefined);

		expect(params.reasoning).toEqual({ effort: "xhigh", summary: "concise" });
		expect(getSupportedEfforts(grok46)).not.toContain(Effort.Max);
	});

	test("xai-oauth/grok-4.6 clamps minimal to low and sends xhigh verbatim", () => {
		const grok46 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.6");
		if (!grok46) throw new Error("xai-oauth/grok-4.6 must be in bundled models.json");
		const minimal = buildParams(grok46, singleUserContext, { reasoning: Effort.Minimal }, undefined);
		const xhigh = buildParams(grok46, singleUserContext, { reasoning: Effort.XHigh }, undefined);

		expect(minimal.params.reasoning).toEqual({ effort: "low", summary: "concise" });
		expect(xhigh.params.reasoning).toEqual({ effort: "xhigh", summary: "concise" });
	});

	test("xai-oauth/grok-4.6 allows callers to suppress the default summary", () => {
		const grok46 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.6");
		if (!grok46) throw new Error("xai-oauth/grok-4.6 must be in bundled models.json");
		const { params } = buildParams(
			grok46,
			singleUserContext,
			{ reasoning: Effort.High, reasoningSummary: null },
			undefined,
		);

		expect(params.reasoning).toEqual({ effort: "high" });
	});

	test("xai-oauth/grok-4.6 replays encrypted reasoning while 4.5 keeps legacy filtering", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		const grok46 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.6");
		if (!grok45 || !grok46) throw new Error("xai-oauth/grok-4.5 and grok-4.6 must be in bundled models.json");

		const reasoningItem = {
			type: "reasoning" as const,
			id: "rs_grok_46",
			summary: [],
			encrypted_content: "enc_grok_46",
		};
		const replayContext: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "xai-oauth",
					model: "grok-4.6",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					providerPayload: createOpenAIResponsesHistoryPayload("xai-oauth", [
						reasoningItem,
						{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
					]),
					timestamp: 0,
				},
				{ role: "user", content: "continue", timestamp: 1 },
			],
		};

		const payload45 = buildParams(grok45, replayContext, { reasoning: Effort.High }, undefined).params;
		const payload46 = buildParams(grok46, replayContext, { reasoning: Effort.High }, undefined).params;

		expect(payload45.input?.some(item => item.type === "reasoning")).toBe(false);
		expect(payload46.input?.find(item => item.type === "reasoning")).toMatchObject({
			type: "reasoning",
			summary: [],
			encrypted_content: "enc_grok_46",
		});
	});
});

function followUpContextWithEncryptedReasoning(model: Model<"openai-responses">): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "internal plan",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_xai_next_turn",
					encrypted_content: "enc_next_turn",
				}),
			},
			{ type: "text", text: "done" },
		],
		api: "openai-responses",
		provider: model.provider,
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
		timestamp: 1,
	};
	return {
		messages: [
			{ role: "user", content: "first", timestamp: 0 },
			assistant,
			{ role: "user", content: "continue", timestamp: 2 },
		],
	};
}

function findEncryptedReasoning(input: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(input)) return undefined;
	return input.find(item => {
		if (!item || typeof item !== "object") return false;
		const candidate = item as { type?: unknown; encrypted_content?: unknown };
		return candidate.type === "reasoning" && typeof candidate.encrypted_content === "string";
	}) as Record<string, unknown> | undefined;
}
