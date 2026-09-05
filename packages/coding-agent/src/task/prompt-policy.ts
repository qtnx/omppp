import {
	bareModelId,
	classifyModel,
	compareRevision,
	parseRevision,
	type Revision,
} from "@oh-my-pi/pi-catalog/identity";

/** Model-specific system prompt profile; `undefined` means the default prompt. */
export type ModelPromptProfile = "openai-gpt";

function openAIRevision(modelId: string | undefined): Revision | undefined {
	if (!modelId) return undefined;
	// Callers pass raw ids and `provider/id` strings alike; classify the bare
	// model segment so a provider prefix cannot hijack class membership.
	const identity = classifyModel("", bareModelId(modelId), { lenient: true });
	if (identity.class !== "openai" || identity.revision === undefined) return undefined;
	return parseRevision(identity.revision);
}

/** Whether task guidance should follow Codex's GPT-5.6-specific delegation policy. */
export function usesCodexTaskPrompt(modelId: string | undefined): boolean {
	const revision = openAIRevision(modelId);
	const target = parseRevision("5.6");
	return revision !== undefined && target !== undefined && compareRevision(revision, target) === 0;
}

/** Whether the model is an OpenAI GPT at or above `floor` (e.g. `"6.0"`). */
export function isOpenAIRevisionAtLeast(modelId: string | undefined, floor: string): boolean {
	const revision = openAIRevision(modelId);
	const target = parseRevision(floor);
	return revision !== undefined && target !== undefined && compareRevision(revision, target) >= 0;
}

/**
 * GPT-5.6 and later (GPT-6 Astra …) get the OpenAI model notes block: they
 * reason briefly by default, treat mid-turn text as delivery, stop to ask after
 * authorization, and drop plan sections under context pressure.
 */
export function modelPromptProfile(modelId: string | undefined): ModelPromptProfile | undefined {
	return isOpenAIRevisionAtLeast(modelId, "5.6") ? "openai-gpt" : undefined;
}
