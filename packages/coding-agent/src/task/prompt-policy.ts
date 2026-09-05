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

/**
 * GPT-5.6 and later (GPT-6 Astra …) get the OpenAI model notes block: they
 * reason briefly by default, treat mid-turn text as delivery, stop to ask after
 * authorization, and drop plan sections under context pressure.
 */
export function modelPromptProfile(modelId: string | undefined): ModelPromptProfile | undefined {
	const revision = openAIRevision(modelId);
	const floor = parseRevision("5.6");
	if (revision === undefined || floor === undefined) return undefined;
	return compareRevision(revision, floor) >= 0 ? "openai-gpt" : undefined;
}
