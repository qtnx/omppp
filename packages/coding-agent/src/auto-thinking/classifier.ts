/**
 * Per-prompt difficulty classifier for the `auto` thinking level.
 *
 * Picks a coding-difficulty bucket for a user prompt and maps it to a concrete
 * {@link Effort}, clamped into the active model's supported range (never below
 * {@link Effort.Low}). Two backends, selected by `providers.autoThinkingModel`:
 *
 * - `online` (default): a smol model classifies into `low|medium|high|xhigh|max`.
 * - a local key: an on-device memory model classifies into the coarser
 *   `trivial|moderate|hard|maximum` scheme (4-class is more reliable than a
 *   full ordinal scale on sub-2B models), mapped to `low|high|xhigh|max`.
 *
 * Throws on any failure (no model, no key, unparseable output, abort/timeout);
 * the caller falls back to a concrete level and continues the turn.
 */
import { type AssistantMessage, completeSimple, Effort, type Model } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import difficultySystemPrompt from "../prompts/system/auto-thinking-difficulty.md" with { type: "text" };
import difficultyLocalPrompt from "../prompts/system/auto-thinking-difficulty-local.md" with { type: "text" };
import { clampAutoThinkingEffort } from "../thinking";
import {
	isTinyMemoryLocalModelKey,
	isTinyMemoryReasoningModelKey,
	ONLINE_AUTO_THINKING_MODEL_KEY,
} from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";

const DIFFICULTY_SYSTEM_PROMPT = prompt.render(difficultySystemPrompt);

/** Upper bound on prompt characters fed to the classifier. */
const MAX_INPUT_CHARS = 6000;
const HEAD_CHARS = 4000;
const TAIL_CHARS = 2000;
/** Local classifiers occasionally need more room for chat-template boilerplate. */
const LOCAL_ANSWER_MAX_TOKENS = 16;
/**
 * Online classifier budget. Sized to survive backends that ignore
 * `disableReasoning` (e.g. Qwen3 via llama.cpp catalogued `reasoning: false`
 * but still emitting thinking): the classifier keyword needs to land after any
 * unavoidable thinking preamble. `maxTokens` is a hard cap — non-thinking
 * completions still return in a handful of tokens (issue #4355).
 */
const REASONING_SAFE_MAX_TOKENS = 1024;

export interface ClassifyDifficultyDeps {
	settings: Settings;
	registry: ModelRegistry;
	model: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
}

/**
 * Classify `promptText` and return a concrete effort clamped to `deps.model`,
 * or `undefined` when the model has no controllable effort surface (auto has
 * nothing to pick — the caller leaves the prior reasoning level in place).
 * @throws when the backend cannot produce a usable classification.
 */
export async function classifyDifficulty(
	promptText: string,
	deps: ClassifyDifficultyDeps,
): Promise<Effort | undefined> {
	const backend = deps.settings.get("providers.autoThinkingModel");
	const input = prepareClassifierInput(promptText);
	const effort =
		backend === ONLINE_AUTO_THINKING_MODEL_KEY
			? await classifyOnline(input, deps)
			: await classifyLocal(input, backend, deps);
	return clampAutoThinkingEffort(deps.model, effort);
}

async function classifyOnline(input: string, deps: ClassifyDifficultyDeps): Promise<Effort> {
	const resolved = resolveRoleSelection(["tiny", "smol"], deps.settings, deps.registry.getAvailable());
	const model = resolved?.model;
	if (!model) {
		throw new Error("auto-thinking: no tiny/smol model available for classification");
	}
	const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
	if (!apiKey) {
		throw new Error(`auto-thinking: no API key for ${model.provider}/${model.id}`);
	}
	// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
	const metadata = deps.metadataResolver?.(model.provider);
	const maxTokens = REASONING_SAFE_MAX_TOKENS;

	const response = await completeSimple(
		model,
		{
			systemPrompt: [DIFFICULTY_SYSTEM_PROMPT],
			messages: [{ role: "user", content: input, timestamp: Date.now() }],
		},
		{
			apiKey: deps.registry.resolver(model, deps.sessionId),
			maxTokens,
			disableReasoning: true,
			metadata,
			signal: deps.signal,
		},
	);

	if (response.stopReason === "error") {
		throw new Error(`auto-thinking: online classification failed: ${response.errorMessage ?? "unknown error"}`);
	}

	const text = extractText(response.content);
	const effort = parseDifficultyLevel(text);
	if (!effort) {
		throw new Error(`auto-thinking: unparseable online classification: ${JSON.stringify(text)}`);
	}
	return effort;
}

async function classifyLocal(input: string, modelKey: string, deps: ClassifyDifficultyDeps): Promise<Effort> {
	if (!isTinyMemoryLocalModelKey(modelKey)) {
		throw new Error(`auto-thinking: unsupported local classifier model: ${modelKey}`);
	}
	const maxTokens = isTinyMemoryReasoningModelKey(modelKey)
		? Math.max(LOCAL_ANSWER_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS)
		: LOCAL_ANSWER_MAX_TOKENS;
	const builtPrompt = prompt.render(difficultyLocalPrompt, { prompt: input });
	const text = await tinyModelClient.complete(modelKey, builtPrompt, {
		maxTokens,
		signal: deps.signal,
	});
	if (!text) {
		throw new Error("auto-thinking: local classification returned no output");
	}
	const effort = parseDifficultyBucket(text);
	if (!effort) {
		throw new Error(`auto-thinking: unparseable local classification: ${JSON.stringify(text)}`);
	}
	return effort;
}

const ONLINE_MARKED_LABEL =
	/(?:answer|classification|label)\s*(?:is|:|-)?\s*(max(?:imum)?|x[\s_-]?high|high|med(?:ium)?|low)\b/;
const ONLINE_START_LABEL = /^\W*(max(?:imum)?|x[\s_-]?high|high|med(?:ium)?|low)\b/;
const ONLINE_LABEL = /\b(max(?:imum)?|x[\s_-]?high|high|med(?:ium)?|low)\b/g;

const LOCAL_MARKED_LABEL = /(?:answer|classification|label)\s*(?:is|:|-)?\s*(max(?:imum)?|trivial|moderate|hard)\b/;
const LOCAL_START_LABEL = /^\W*(max(?:imum)?|trivial|moderate|hard)\b/;
const LOCAL_LABEL = /\b(max(?:imum)?|trivial|moderate|hard)\b/g;

/** Map the online 5-way level keyword to an {@link Effort}; classifier labels beat incidental prose. */
export function parseDifficultyLevel(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	return parseClassifierLabel(lower, ONLINE_MARKED_LABEL, ONLINE_START_LABEL, ONLINE_LABEL, onlineLabelToEffort);
}

/** Map the local bucket keyword to an {@link Effort}; classifier labels beat incidental prose. */
export function parseDifficultyBucket(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	return parseClassifierLabel(lower, LOCAL_MARKED_LABEL, LOCAL_START_LABEL, LOCAL_LABEL, localLabelToEffort);
}

function parseClassifierLabel(
	lower: string,
	markedPattern: RegExp,
	startPattern: RegExp,
	labelPattern: RegExp,
	toEffort: (label: string) => Effort | undefined,
): Effort | undefined {
	let match = markedPattern.exec(lower) ?? startPattern.exec(lower);
	const markedLabel = match?.[1];
	if (markedLabel !== undefined) return toEffort(markedLabel);

	let last: Effort | undefined;
	labelPattern.lastIndex = 0;
	while (true) {
		match = labelPattern.exec(lower);
		if (match === null) break;
		const label = match[1];
		const effort = label !== undefined ? toEffort(label) : undefined;
		if (effort === Effort.Max && isNegatedLabel(lower, match.index)) continue;
		if (effort !== undefined) last = effort;
	}
	return last;
}
function isNegatedLabel(lower: string, index: number): boolean {
	const prefix = lower.slice(Math.max(0, index - 24), index);
	return /\b(?:not|no)(?:\W+\w+){0,3}\W*$/.test(prefix);
}

function onlineLabelToEffort(label: string): Effort | undefined {
	switch (label) {
		case "max":
		case "maximum":
			return Effort.Max;
		case "xhigh":
		case "x-high":
		case "x_high":
		case "x high":
			return Effort.XHigh;
		case "high":
			return Effort.High;
		case "med":
		case "medium":
			return Effort.Medium;
		case "low":
			return Effort.Low;
		default:
			return undefined;
	}
}

function localLabelToEffort(label: string): Effort | undefined {
	switch (label) {
		case "max":
		case "maximum":
			return Effort.Max;
		case "hard":
			return Effort.XHigh;
		case "moderate":
			return Effort.High;
		case "trivial":
			return Effort.Low;
		default:
			return undefined;
	}
}

function extractText(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join(" ")
		.trim();
}

/**
 * Bound the classifier input. Code blocks are kept (a large diff is signal), but
 * very long prompts are head+tail trimmed so the intent (start) and any trailing
 * error/stacktrace (end) both survive.
 */
function prepareClassifierInput(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_INPUT_CHARS) return trimmed;
	return `${trimmed.slice(0, HEAD_CHARS)}\n…\n${trimmed.slice(-TAIL_CHARS)}`;
}
