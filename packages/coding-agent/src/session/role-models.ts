import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import {
	extractExplicitThinkingSelector,
	formatModelSelectorValue,
	getModelMatchPreferences,
	parseModelString,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { isOpenAIRevisionAtLeast } from "../task/prompt-policy";
import type { ConfiguredThinkingLevel } from "../thinking";

/** Formats a role assignment while preserving its explicit thinking selector. */
export function formatRoleModelValue(
	settings: Settings,
	modelRegistry: ModelRegistry,
	role: string,
	model: Model,
	selectorOverride?: string,
	thinkingLevelOverride?: ThinkingLevel,
): string {
	const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
	if (thinkingLevelOverride !== undefined) return formatModelSelectorValue(modelKey, thinkingLevelOverride);
	const existingRoleValue = settings.getModelRole(role);
	if (!existingRoleValue) return modelKey;
	const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, settings, {
		isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
	});
	return formatModelSelectorValue(modelKey, thinkingLevel);
}

/** Resolves a configured model target relative to the current provider. */
export function resolveConfiguredModelTarget(
	configuredTarget: string | undefined,
	currentModel: Model,
	availableModels: Model[],
): Model | undefined {
	const trimmedTarget = configuredTarget?.trim();
	if (!trimmedTarget) return undefined;
	const parsed = parseModelString(trimmedTarget, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => availableModels.some(model => model.provider === provider && model.id === id),
	});
	if (parsed) {
		const explicitModel = availableModels.find(model => model.provider === parsed.provider && model.id === parsed.id);
		if (explicitModel) return explicitModel;
	}
	return availableModels.find(model => model.provider === currentModel.provider && model.id === trimmedTarget);
}

/** Resolves a model's configured context-promotion target. */
export function resolveContextPromotionConfiguredTarget(
	currentModel: Model,
	availableModels: Model[],
): Model | undefined {
	return resolveConfiguredModelTarget(currentModel.contextPromotionTarget, currentModel, availableModels);
}

/** Resolves a model's configured compaction target. */
export function resolveCompactionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
	return resolveConfiguredModelTarget(currentModel.compactionModel, currentModel, availableModels);
}

/** Resolves a model role and its explicit thinking selection. */
/** Roles whose work is pure reasoning: planning documents and the `slow` deep-reasoning role. */
const PLANNING_ROLES: ReadonlySet<string> = new Set(["plan", "slow"]);

/**
 * Model-family thinking floor for a role that carries no `:level` suffix.
 * GPT-6 (Astra) reasons briefly at `high` (~30 reasoning tokens per call in
 * the xlords plan suite, scoring 0.83 vs 0.94 at `xhigh` for the same cost
 * order); Codex itself ships it at `low`. Planning roles therefore pin `xhigh`
 * when the model supports it; execution roles keep the configured default.
 */
export function roleThinkingDefault(model: Model, role: string): ConfiguredThinkingLevel | undefined {
	if (!PLANNING_ROLES.has(role)) return undefined;
	if (!isOpenAIRevisionAtLeast(model.id, "6.0")) return undefined;
	const efforts = model.thinking?.efforts;
	if (!efforts?.includes(Effort.XHigh)) return undefined;
	return ThinkingLevel.XHigh;
}

export function resolveRoleModelFull(
	settings: Settings,
	role: string,
	availableModels: Model[],
	currentModel: Model | undefined,
): ResolvedModelRoleValue {
	const roleModelStr =
		role === "default"
			? (settings.getModelRole("default") ??
				(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
			: settings.getModelRole(role);
	if (!roleModelStr) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}
	const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	if (resolved.explicitThinkingLevel || !resolved.model) return resolved;
	const pinned = roleThinkingDefault(resolved.model, role);
	return pinned === undefined ? resolved : { ...resolved, thinkingLevel: pinned, explicitThinkingLevel: true };
}
