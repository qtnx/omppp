import { describe, expect, test } from "bun:test";
import { providerEntry, seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { runanywhereModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

/** The live `/v1/models` envelope shape (measured 2026-09-22). */
function runanywhereModelsResponse(entries: Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ data: entries, object: "list" }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("RunAnywhere provider", () => {
	test("registers the descriptor, default model, and bundled catalog", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "runanywhere");
		expect(descriptor).toMatchObject({
			defaultModel: "glm-5.3-flash",
			dynamicModelsAuthoritative: true,
		});
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["RUNANYWHERE_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.runanywhere).toBe("glm-5.3-flash");
		expect(providerEntry("runanywhere")?.envVars).toEqual(["RUNANYWHERE_API_KEY"]);

		// A keyless regeneration must still leave the declared default model
		// resolvable, so the seed has to cover it.
		expect(seedModels("runanywhere").map(model => model.id)).toContain("glm-5.3-flash");
		const bundled = getBundledModels("runanywhere");
		expect(bundled.find(model => model.id === "glm-5.3-flash")?.baseUrl).toBe("https://inference.runanywhere.ai/v1");
	});

	// The deployments reject an effort tier they do not serve with a 400
	// (`Unexpected reasoning effort high. Supported types are xhigh (default),
	// medium, and low.`), so the ladders are wire contracts, not cosmetics.
	test("bakes the measured per-model reasoning surface", () => {
		const byId = new Map(
			getBundledModels("runanywhere").map(model => [model.id, model as Model<"openai-completions">]),
		);

		const glm = byId.get("glm-5.3-flash");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		// The GLM-5.3 lineage pins mandatory thinking on Z.AI-dialect hosts;
		// this deployment turns reasoning off through `reasoning_effort: "none"`.
		expect(glm?.thinking?.requiresEffort).toBeFalsy();
		expect(glm?.compat.reasoningDisableMode).toBe("none-effort");

		expect(byId.get("qwen3.8-27b")?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.XHigh]);
		expect(byId.get("gemma-4")?.reasoning).toBe(false);
		expect(byId.get("gemma-4")?.thinking).toBeUndefined();
	});

	// Cached prefixes are billed at `cached_input_per_mtok` and reported through
	// `usage.prompt_tokens_details.cached_tokens`; a zero cacheRead would price
	// every cache hit as a full input turn.
	test("prices cache reads from the published tariff", () => {
		const glm = getBundledModels("runanywhere").find(model => model.id === "glm-5.3-flash");
		expect(glm?.cost).toEqual({ input: 0.1, output: 0.35, cacheRead: 0.02, cacheWrite: 0 });
	});

	test("maps the non-standard limit fields and skips non-chat deployments", async () => {
		const calls: { url: string; authorization: string | null }[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return runanywhereModelsResponse([
				{ id: "glm-5.3-flash", object: "model", mode: "chat", max_input_tokens: 1048567 },
				{ id: "gemma-4", object: "model", mode: "chat", max_input_tokens: 262144, max_output_tokens: 128000 },
				{ id: "text-embedding-3", object: "model", mode: "embedding", max_input_tokens: 8192 },
			]);
		};

		const options = runanywhereModelManagerOptions({ apiKey: "ra-test-key", fetch: fetchMock });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const byId = new Map(models.map(model => [model.id, model]));

		expect(calls).toEqual([
			{ url: "https://inference.runanywhere.ai/v1/models", authorization: "Bearer ra-test-key" },
		]);
		// `max_input_tokens` / `max_output_tokens` replace the `context_length` /
		// `max_completion_tokens` pair the shared mapper reads.
		expect(byId.get("gemma-4")).toMatchObject({
			provider: "runanywhere",
			api: "openai-completions",
			contextWindow: 262144,
			maxTokens: 128000,
			reasoning: false,
		});
		// Discovery carries no capability or pricing metadata: both come from the
		// provider's own seeded row.
		expect(byId.get("glm-5.3-flash")).toMatchObject({
			contextWindow: 1048567,
			reasoning: true,
			cost: { input: 0.1, output: 0.35, cacheRead: 0.02, cacheWrite: 0 },
		});
		expect(byId.has("text-embedding-3")).toBe(false);
	});

	test("keeps an unseeded id bare instead of fabricating limits", async () => {
		const fetchMock: FetchImpl = async () =>
			runanywhereModelsResponse([{ id: "runanywhere-only/unknown-model", object: "model", mode: "chat" }]);

		const options = runanywhereModelManagerOptions({ apiKey: "ra-test-key", fetch: fetchMock });
		const models = (await options.fetchDynamicModels?.()) ?? [];

		expect(models[0]).toMatchObject({
			id: "runanywhere-only/unknown-model",
			contextWindow: null,
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("requires a key before discovery runs", () => {
		expect(runanywhereModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});
});
