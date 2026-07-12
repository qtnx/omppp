import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { projectOpenAIProReasoningAliases } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const PRO_REASONING_BASE_IDS = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const;
const PRO_REASONING_PROVIDERS = ["openai", "openai-codex"] as const;

const PRO_REASONING_THINKING = {
	mode: "effort" as const,
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	effortMap: {
		[Effort.Minimal]: "low",
		[Effort.Low]: "medium",
		[Effort.Medium]: "high",
		[Effort.High]: "xhigh",
		[Effort.XHigh]: "max",
	},
};

function createBaseModel(provider: (typeof PRO_REASONING_PROVIDERS)[number], id: string): ModelSpec<Api> {
	return {
		id,
		name: id,
		api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
		provider,
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
	};
}

describe("OpenAI pro reasoning aliases", () => {
	it("projects and re-bakes shifted pro aliases for both Responses providers", () => {
		const models = PRO_REASONING_PROVIDERS.flatMap(provider =>
			PRO_REASONING_BASE_IDS.map(id => createBaseModel(provider, id)),
		);

		const projected = projectOpenAIProReasoningAliases(models);
		applyGeneratedModelPolicies(projected);

		for (const provider of PRO_REASONING_PROVIDERS) {
			for (const id of PRO_REASONING_BASE_IDS) {
				const alias = projected.find(model => model.provider === provider && model.id === `${id}-pro`);
				expect(alias).toBeDefined();
				expect(alias?.api).toBe(provider === "openai" ? "openai-responses" : "openai-codex-responses");
				expect(alias?.requestModelId).toBe(id);
				expect(alias?.reasoningMode).toBe("pro");
				expect(alias?.thinking).toEqual(PRO_REASONING_THINKING);

				const resolved = alias && buildModel(alias);
				expect(resolved?.reasoningMode).toBe("pro");
				expect(resolved?.thinking).toEqual(PRO_REASONING_THINKING);
			}
		}
	});
});
