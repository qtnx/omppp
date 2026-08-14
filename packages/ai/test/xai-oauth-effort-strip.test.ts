import { describe, expect, test } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Pins fix #2 of the compaction effort-override bug. Models that reason
// natively but reject the wire `reasoning.effort` param (e.g.
// `xai-oauth/grok-build`, `compat.supportsReasoningEffort: false` on
// openai-responses*) are encoded at build time as `thinking: undefined` —
// "thinks, but exposes no control surface". `resolveOpenAiReasoningEffort`
// returns undefined for them instead of tripping `requireSupportedEffort`
// (the old user-visible "Compaction failed: Thinking effort high is not
// supported by xai-oauth/grok-build. Supported efforts:" with an empty list),
// and the wire-side `omitReasoningEffort` gate (stream.ts) remains the single
// source of truth for the actual strip.
describe("effort-dial-less reasoner encoding (regression)", () => {
	test("xai-oauth/grok-build reasons but carries no thinking config", () => {
		const grokBuild = getBundledModel("xai-oauth", "grok-build");
		if (!grokBuild) throw new Error("xai-oauth/grok-build must be in bundled models.json");
		expect(grokBuild.reasoning).toBe(true);
		expect(grokBuild.thinking).toBeUndefined();
		expect(getSupportedEfforts(grokBuild)).toEqual([]);
	});

	test("xai-oauth/grok-4.3 keeps its effort dial", () => {
		const grok43 = getBundledModel("xai-oauth", "grok-4.3");
		if (!grok43) throw new Error("xai-oauth/grok-4.3 must be in bundled models.json");
		expect(grok43.thinking).toBeDefined();
		expect(getSupportedEfforts(grok43).length).toBeGreaterThan(0);
	});

	test("xai-oauth/grok-4.20-0309-reasoning reasons but carries no thinking config", () => {
		const grokR = getBundledModel("xai-oauth", "grok-4.20-0309-reasoning");
		if (!grokR) throw new Error("xai-oauth/grok-4.20-0309-reasoning must be in bundled models.json");
		expect(grokR.reasoning).toBe(true);
		expect(grokR.thinking).toBeUndefined();
	});

	test("the no-dial encoding stays scoped to openai-responses*", () => {
		const claude = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!claude) throw new Error("anthropic/claude-sonnet-4-6 must be in bundled models.json");
		expect(claude.thinking).toBeDefined();
	});
});

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
	});

	test("streamSimple applies Grok defaults and requests visible replayable thinking for 4.6", async () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		const grok46 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.6");
		if (!grok45 || !grok46) throw new Error("xai-oauth/grok-4.5 and grok-4.6 must be in bundled models.json");

		const payload45 = await captureSimpleResponsesPayload(grok45);
		const payload46 = await captureSimpleResponsesPayload(grok46);

		expect(payload45.reasoning).toEqual({ effort: "high" });
		expect(payload45.include).toBeUndefined();
		expect(payload46.reasoning).toEqual({ effort: "high", summary: "concise" });
		expect(payload46.include).toContain("reasoning.encrypted_content");
	});

	test("xai-oauth/grok-4.5 omits unsupported reasoning summary", () => {
		const grok45 = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
		if (!grok45) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");

		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.High }, undefined);

		expect(params.reasoning).toEqual({ effort: "high" });
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
