import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type AnthropicCacheDiagnosticReason,
	type AnthropicCacheDiagnosticState,
	type AnthropicDiagnosticRequest,
	diagnoseAnthropicCacheTransition,
	fingerprintAnthropicRequest,
	recordAnthropicCacheDiagnostics,
} from "../src/providers/anthropic-cache-diagnostics";

const request = (overrides: Partial<AnthropicDiagnosticRequest> = {}): AnthropicDiagnosticRequest => ({
	model: "claude-sonnet-4-6",
	messages: [
		{ role: "user", content: [{ type: "text", text: "secret prompt" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
	],
	system: [{ type: "text", text: "private system" }],
	tools: [{ name: "lookup", description: "private tool", input_schema: { type: "object" } }],
	thinking: { type: "adaptive" },
	contextManagement: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
	outputConfig: { effort: "high" },
	cacheControls: [{ type: "ephemeral", ttl: "5m" }],
	featureNames: ["effort-2025-11-24", "prompt-caching-scope-2026-01-05"],
	...overrides,
});

const usage = (cacheRead: number, cacheWrite: number, input = 5000) => ({
	cacheRead,
	cacheWrite,
	input,
});

function warmState(): AnthropicCacheDiagnosticState {
	return { fingerprint: fingerprintAnthropicRequest(request()), usage: usage(5000, 0) };
}

const providerModel: Model<"anthropic-messages"> = buildModel({
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

const providerContext: Context = {
	messages: [{ role: "user", content: "private prompt", timestamp: 1 }],
	systemPrompt: ["private system"],
};

function diagnosticSse(cacheRead: number, cacheWrite: number): Response {
	const sourceUsage = {
		input_tokens: 6000,
		output_tokens: 1,
		cache_read_input_tokens: cacheRead,
		cache_creation_input_tokens: cacheWrite,
	};
	const events = [
		{ type: "message_start", message: { id: "msg_diagnostic", usage: sourceUsage } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: sourceUsage },
		{ type: "message_stop" },
	];
	const body = `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_diagnostic" },
	});
}

function diagnosticError(): Response {
	return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "temporary failure" } }), {
		status: 529,
		headers: { "Content-Type": "application/json", "request-id": "req_diagnostic_failure" },
	});
}

describe("Anthropic cache diagnostics", () => {
	it("classifies each changed cache-relevant component without prompt values", () => {
		const cases: Array<[AnthropicCacheDiagnosticReason, Partial<AnthropicDiagnosticRequest>, string]> = [
			["model_changed", { model: "claude-opus-4-6" }, "claude-opus-4-6"],
			["system_changed", { system: [{ type: "text", text: "new private system" }] }, "new private system"],
			["tools_changed", { tools: [{ name: "other", description: "new private tool" }] }, "new private tool"],
			["thinking_or_effort_changed", { outputConfig: { effort: "low" } }, "low"],
			["cache_controls_changed", { cacheControls: [{ type: "ephemeral", ttl: "1h" }] }, "1h"],
			["beta_features_changed", { featureNames: ["task-budgets-2026-03-13"] }, "task-budgets"],
			[
				"message_history_changed",
				{ messages: [{ role: "user", content: "new private history" }] },
				"new private history",
			],
		];
		for (const [reason, change, secret] of cases) {
			const transition = diagnoseAnthropicCacheTransition(warmState(), {
				fingerprint: fingerprintAnthropicRequest(request(change)),
				usage: usage(0, 5000, 6000),
			});
			expect(transition?.reasonCodes).toContain(reason);
			expect(JSON.stringify(transition)).not.toContain(secret);
			expect(JSON.stringify(transition)).not.toContain("private");
			expect(JSON.stringify(transition)).not.toContain("secret");
		}
	});

	it("classifies top-level automatic cache marker changes without retaining prompt or cache values", () => {
		const baselineRequest = request({
			cacheControls: undefined,
			cacheControl: { type: "ephemeral", ttl: "5m" },
		});
		const unchangedRequest = request({
			cacheControls: undefined,
			cacheControl: { type: "ephemeral", ttl: "5m" },
		});
		const changedRequest = request({
			cacheControls: undefined,
			cacheControl: { type: "ephemeral", ttl: "1h" },
		});
		const baseline = fingerprintAnthropicRequest(baselineRequest);
		const unchanged = fingerprintAnthropicRequest(unchangedRequest);
		const changed = fingerprintAnthropicRequest(changedRequest);

		expect(unchanged.cacheControlsHash).toBe(baseline.cacheControlsHash);
		expect(changed.cacheControlsHash).not.toBe(baseline.cacheControlsHash);

		const transition = diagnoseAnthropicCacheTransition(
			{ fingerprint: baseline, usage: usage(5000, 0) },
			{ fingerprint: changed, usage: usage(0, 5000, 6000) },
		);
		expect(transition?.reasonCodes).toEqual(["cache_controls_changed"]);
		expect(JSON.stringify(transition)).not.toContain("private");
		expect(JSON.stringify(transition)).not.toContain("secret");
		expect(JSON.stringify(transition)).not.toContain("5m");
		expect(JSON.stringify(transition)).not.toContain("1h");
	});

	it("uses explicit cache-control overrides instead of the top-level marker", () => {
		const baseline = fingerprintAnthropicRequest(
			request({
				cacheControls: [{ type: "ephemeral", ttl: "5m" }],
				cacheControl: { type: "ephemeral", ttl: "5m" },
			}),
		);
		const changedTopLevelOnly = fingerprintAnthropicRequest(
			request({
				cacheControls: [{ type: "ephemeral", ttl: "5m" }],
				cacheControl: { type: "ephemeral", ttl: "1h" },
			}),
		);

		expect(changedTopLevelOnly.cacheControlsHash).toBe(baseline.cacheControlsHash);
		const transition = diagnoseAnthropicCacheTransition(
			{ fingerprint: baseline, usage: usage(5000, 0) },
			{ fingerprint: changedTopLevelOnly, usage: usage(0, 5000, 6000) },
		);
		expect(transition?.reasonCodes).toEqual(["ttl_or_provider_eviction"]);
	});

	it("reports the first changed message and classifies unchanged shape as eviction", () => {
		const changed = diagnoseAnthropicCacheTransition(warmState(), {
			fingerprint: fingerprintAnthropicRequest(
				request({ messages: [request().messages[0], { role: "assistant", content: "changed" }] }),
			),
			usage: usage(0, 5000, 6000),
		});
		expect(changed?.reasonCodes).toEqual(["message_history_changed"]);
		expect(changed?.firstChangedMessageIndex).toBe(1);

		const evicted = diagnoseAnthropicCacheTransition(warmState(), {
			fingerprint: fingerprintAnthropicRequest(request()),
			usage: usage(0, 5000, 6000),
		});
		expect(evicted?.reasonCodes).toEqual(["ttl_or_provider_eviction"]);
	});

	it("does not emit for first, cold-only, partial-cache, or failed transitions", () => {
		const current = { fingerprint: fingerprintAnthropicRequest(request()), usage: usage(0, 5000, 6000) };
		expect(diagnoseAnthropicCacheTransition(undefined, current)).toBeUndefined();
		expect(diagnoseAnthropicCacheTransition({ ...warmState(), usage: usage(0, 5000) }, current)).toBeUndefined();
		expect(
			diagnoseAnthropicCacheTransition(warmState(), {
				fingerprint: fingerprintAnthropicRequest(request()),
				usage: usage(100, 5000),
			}),
		).toBeUndefined();

		const state = warmState();
		expect(recordAnthropicCacheDiagnostics(state, request(), usage(0, 5000, 6000), true)?.reasonCodes).toEqual([
			"ttl_or_provider_eviction",
		]);
		expect(state.usage.cacheRead).toBe(0);

		const failedBaseline = warmState();
		recordAnthropicCacheDiagnostics(failedBaseline, request(), usage(0, 5000), false);
		expect(failedBaseline).toEqual(warmState());
	});

	it("stores only fixed-size digests and allowlisted feature names", () => {
		const fingerprint = fingerprintAnthropicRequest(
			request({ featureNames: ["effort-2025-11-24", "Authorization: Bearer secret-token"] }),
		);
		expect(fingerprint.featureNames).toEqual(["effort-2025-11-24"]);
		expect(fingerprint.modelHash).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(fingerprint)).not.toContain("secret");
		expect(JSON.stringify(fingerprint)).not.toContain("Authorization");
	});
	it("emits one structured event from two settled provider successes", async () => {
		const states = new Map<string, ProviderSessionState>();
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => events.push(event));
		let calls = 0;
		const fetch: FetchImpl = async () => {
			const first = calls++ === 0;
			return diagnosticSse(first ? 5000 : 0, first ? 0 : 5000);
		};
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const stream = streamSimple(providerModel, providerContext, {
					fetch,
					apiKey: "test-anthropic-key",
					cacheRetention: "short",
					providerSessionState: states,
				});
				for await (const _event of stream) {
					// Drain the real provider stream so usage settles.
				}
				await stream.result();
			}
		} finally {
			dispose();
			for (const state of states.values()) state.close();
		}
		const diagnosticEvents = events.filter(event => event.message === "anthropic: prompt cache invalidation");
		expect(diagnosticEvents).toHaveLength(1);
		expect(diagnosticEvents[0]?.context).toMatchObject({
			endpointHost: "api.anthropic.com",
			model: "claude-sonnet-4-6",
			reasonCodes: ["ttl_or_provider_eviction"],
			previousCacheRead: 5000,
			currentCacheWrite: 5000,
			currentInput: 6000,
		});
		const output = JSON.stringify(diagnosticEvents[0]);
		expect(output).not.toContain("private");
		expect(output).not.toContain("test-anthropic-key");
	});
	it("keeps the warm baseline across a failed provider retry", async () => {
		const states = new Map<string, ProviderSessionState>();
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => events.push(event));
		let calls = 0;
		const fetch: FetchImpl = async () => {
			const call = calls++;
			if (call === 1) return diagnosticError();
			if (call === 3) return diagnosticSse(0, 5000);
			return diagnosticSse(5000, 0);
		};
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				const stream = streamSimple(providerModel, providerContext, {
					fetch,
					apiKey: "test-anthropic-key",
					cacheRetention: "short",
					providerSessionState: states,
					providerRetryWait: async () => {},
				});
				for await (const _event of stream) {
					// Drain each settled provider stream.
				}
				await stream.result();
			}
		} finally {
			dispose();
			for (const state of states.values()) state.close();
		}
		expect(calls).toBe(4);
		expect(events.filter(event => event.message === "anthropic: prompt cache invalidation")).toHaveLength(1);
	});
});
