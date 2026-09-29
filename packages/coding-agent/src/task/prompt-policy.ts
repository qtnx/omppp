import { type DelegationBias, resolveDelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import {
	bareModelId,
	classifyModel,
	compareRevision,
	parseRevision,
	type Revision,
} from "@oh-my-pi/pi-catalog/identity";
import type { ToolSession } from "..";

/** Model-specific system prompt profile; `undefined` means the default prompt. */
export type ModelPromptProfile = "openai-gpt" | "claude-opus";

function modelIdentity(
	modelId: string | undefined,
): { class: string; family?: string; revision?: Revision } | undefined {
	if (!modelId) return undefined;
	// Callers pass raw ids and `provider/id` strings alike; classify the bare
	// model segment so a provider prefix cannot hijack class membership.
	const identity = classifyModel("", bareModelId(modelId), { lenient: true });
	const revision = identity.revision === undefined ? undefined : parseRevision(identity.revision);
	return { class: identity.class, family: identity.family, revision };
}

function openAIRevision(modelId: string | undefined): Revision | undefined {
	const identity = modelIdentity(modelId);
	return identity?.class === "openai" ? identity.revision : undefined;
}

function isClaudeOpusAtLeast(modelId: string | undefined, floor: string): boolean {
	const identity = modelIdentity(modelId);
	if (identity?.class !== "anthropic" || identity.family !== "opus" || !identity.revision) return false;
	const target = parseRevision(floor);
	return target !== undefined && compareRevision(identity.revision, target) >= 0;
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
 * authorization, and drop plan sections under context pressure. Claude Opus 5.5
 * and later get the Claude notes block: at high effort they re-litigate routing
 * and prompt rules, re-derive settled facts, and compose whole artifacts in
 * reasoning before writing anything.
 */
export function modelPromptProfile(modelId: string | undefined): ModelPromptProfile | undefined {
	if (isOpenAIRevisionAtLeast(modelId, "5.6")) return "openai-gpt";
	if (isClaudeOpusAtLeast(modelId, "5.5")) return "claude-opus";
	return undefined;
}

/**
 * Delegation bias of the session's active model, for tool descriptions that
 * nudge toward subagents; `eager` before a model is bound.
 */
export function sessionDelegationBias(session: ToolSession): DelegationBias {
	const model = session.getActiveModel?.();
	return model ? resolveDelegationBias(model) : "eager";
}
