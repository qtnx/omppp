import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	CATALOG_PROVIDERS,
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const META_BASE_URL = "https://api.meta.ai/v1";
const META_MODEL_ID = "muse-spark-1.1";
const META_CONTEXT_WINDOW = 1_048_576;
const META_MAX_OUTPUT_TOKENS = 131_072;
const META_COST = { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 } as const;

const ORIGINAL_ENV = {
	META_MODEL_API_KEY: Bun.env.META_MODEL_API_KEY,
	META_API_KEY: Bun.env.META_API_KEY,
	MODEL_API_KEY: Bun.env.MODEL_API_KEY,
} as const;

const testContext: Context = {
	messages: [{ role: "user", content: "Return one sentence.", timestamp: 1 }],
};

function restoreEnvVar(name: keyof typeof ORIGINAL_ENV): void {
	const value = ORIGINAL_ENV[name];
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function captureResponsesPayload(
	model: Model<"openai-responses">,
	maxTokens: number,
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAIResponses(model, testContext, {
		apiKey: "LLM|meta-test-key",
		maxTokens,
		maxTokensExplicit: true,
		reasoning: Effort.High,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

afterEach(() => {
	restoreEnvVar("META_MODEL_API_KEY");
	restoreEnvVar("META_API_KEY");
	restoreEnvVar("MODEL_API_KEY");
	vi.restoreAllMocks();
});

describe("Meta Model API provider", () => {
	it("registers the provider, default model, catalog discovery, and login entry", () => {
		const catalogEntry = CATALOG_PROVIDERS.find(entry => entry.id === "meta");
		expect(catalogEntry?.defaultModel).toBe(META_MODEL_ID);
		expect(catalogEntry?.envVars).toEqual(["META_MODEL_API_KEY", "META_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.meta).toBe(META_MODEL_ID);

		const descriptor = PROVIDER_DESCRIPTORS.find(entry => entry.providerId === "meta");
		expect(descriptor?.catalogDiscovery).toEqual({
			label: "Meta Model API",
			envVars: ["META_MODEL_API_KEY", "META_API_KEY"],
		});
		expect(getOAuthProviders().find(provider => provider.id === "meta")?.name).toBe("Meta Model API");
	});

	it("only resolves Meta-scoped API-key environment variables", () => {
		delete Bun.env.META_MODEL_API_KEY;
		delete Bun.env.META_API_KEY;
		Bun.env.MODEL_API_KEY = "unrelated-provider-key";
		expect(getEnvApiKey("meta")).toBeUndefined();
		Bun.env.META_API_KEY = "short-alias-key";
		expect(getEnvApiKey("meta")).toBe("short-alias-key");
		Bun.env.META_MODEL_API_KEY = "specific-key";
		expect(getEnvApiKey("meta")).toBe("specific-key");
	});

	it("maps models.dev Meta data to the official Responses contract", () => {
		const models = mapModelsDevToModels(
			{
				meta: {
					models: {
						[META_MODEL_ID]: {
							name: "Muse Spark 1.1",
							tool_call: true,
							reasoning: true,
							modalities: { input: ["text", "image", "pdf", "video"] },
							cost: { input: 9, output: 9, cache_read: 9, cache_write: 9 },
							limit: { context: 1_000_000, output: 32_000 },
						},
					},
				},
			},
			MODELS_DEV_PROVIDER_DESCRIPTORS,
		);

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: META_MODEL_ID,
			name: "Muse Spark 1.1",
			provider: "meta",
			api: "openai-responses",
			baseUrl: META_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: META_CONTEXT_WINDOW,
			maxTokens: META_MAX_OUTPUT_TOKENS,
			cost: META_COST,
			compat: {
				providerOutputClamp: META_MAX_OUTPUT_TOKENS,
				supportsDeveloperRole: true,
			},
		});
	});

	it("discovers Meta models through the authenticated OpenAI-compatible models endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: META_MODEL_ID, object: "model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as FetchImpl;
		const descriptor = PROVIDER_DESCRIPTORS.find(entry => entry.providerId === "meta");
		const options = descriptor?.createModelManagerOptions({ apiKey: "LLM|meta-test-key", fetch: fetchMock });
		const models = await options?.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			`${META_BASE_URL}/models`,
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer LLM|meta-test-key" }),
			}),
		);
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: META_MODEL_ID,
			provider: "meta",
			api: "openai-responses",
			baseUrl: META_BASE_URL,
			contextWindow: META_CONTEXT_WINDOW,
			maxTokens: META_MAX_OUTPUT_TOKENS,
			cost: META_COST,
			compat: { providerOutputClamp: META_MAX_OUTPUT_TOKENS },
		});
	});

	it("sends the full documented 128K output budget through the Responses API", async () => {
		const model = getBundledModel("meta", META_MODEL_ID) as Model<"openai-responses">;
		expect(model).toBeDefined();
		expect(model.contextWindow).toBe(META_CONTEXT_WINDOW);
		expect(model.maxTokens).toBe(META_MAX_OUTPUT_TOKENS);
		expect(model.cost).toEqual(META_COST);

		const payload = await captureResponsesPayload(model, META_MAX_OUTPUT_TOKENS);
		expect(payload.max_output_tokens).toBe(META_MAX_OUTPUT_TOKENS);
		expect(payload.include).toEqual(["reasoning.encrypted_content"]);
		expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(payload.store).toBe(false);
	});

	it("keeps the 64K safety clamp for providers without an explicit override", async () => {
		const generic = buildModel({
			id: "generic-responses-model",
			name: "Generic Responses Model",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: META_CONTEXT_WINDOW,
			maxTokens: META_MAX_OUTPUT_TOKENS,
		} satisfies ModelSpec<"openai-responses">);

		const payload = await captureResponsesPayload(generic, META_MAX_OUTPUT_TOKENS);
		expect(payload.max_output_tokens).toBe(64_000);
	});
});
