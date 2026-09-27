/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

const EMPTY_STRING_ARRAY: readonly string[] = [];

export const cfgLearningEnabled = register({
	id: "learning.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Live Learning",
		description: "Learn durable user guidelines from complain/reminder messages after each turn",
	},
});

export const cfgLearningMinConfidence = register({ id: "learning.minConfidence", type: "number", default: 0.7 });

export const cfgLearningClassifierModels = register({
	id: "learning.classifierModels",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Live Learning Classifier Chain",
		description: "Ordered model/role fallback chain for live-learning classification",
	},
});

export const cfgLearningClassifierTimeoutMs = register({
	id: "learning.classifierTimeoutMs",
	type: "number",
	default: 8000,
});

export const cfgLearningWriterModels = register({
	id: "learning.writerModels",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Live Learning Writer Chain",
		description: "Ordered model/role fallback chain for the live-learning writer agent",
	},
});

export const cfgLearningWriterTimeoutMs = register({ id: "learning.writerTimeoutMs", type: "number", default: 60000 });
export const cfgLearningMaxUserMessageChars = register({
	id: "learning.maxUserMessageChars",
	type: "number",
	default: 4000,
});
export const cfgLearningMaxEntriesPerScope = register({
	id: "learning.maxEntriesPerScope",
	type: "number",
	default: 40,
});
export const cfgLearningMaxInjectedPerScope = register({
	id: "learning.maxInjectedPerScope",
	type: "number",
	default: 20,
});
export const cfgLearningHalfLifeDays = register({ id: "learning.halfLifeDays", type: "number", default: 45 });
export const cfgLearningStaleRepoDays = register({ id: "learning.staleRepoDays", type: "number", default: 90 });

export const cfgLearningRelevanceEnabled = register({
	id: "learning.relevance.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Live Learning Relevance (Jev)",
		description: "Score stored learnings against each request with Jev and inject only the relevant ones",
	},
});

export const cfgLearningRelevanceThreshold = register({
	id: "learning.relevance.threshold",
	type: "number",
	default: 0.5,
});
export const cfgLearningRelevanceMaxCandidates = register({
	id: "learning.relevance.maxCandidates",
	type: "number",
	default: 60,
});
export const cfgLearningRelevanceTimeoutMs = register({
	id: "learning.relevance.timeoutMs",
	type: "number",
	default: 2500,
});

export const cfgLearningNoveltyEnabled = register({
	id: "learning.novelty.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Live Learning Novelty Check (Jev)",
		description:
			"Before storing, let Jev decide whether an existing learning already covers the lesson and reinforce it instead",
	},
});

export const cfgLearningNoveltyReinforceThreshold = register({
	id: "learning.novelty.reinforceThreshold",
	type: "number",
	default: 0.6,
});
export const cfgLearningNoveltyTimeoutMs = register({
	id: "learning.novelty.timeoutMs",
	type: "number",
	default: 4000,
});

export const cfgLearningConsolidationEnabled = register({
	id: "learning.consolidation.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Live Learning Consolidation",
		description: "Run background consolidation to merge, generalize, and clean up live learnings",
	},
});

export const cfgLearningConsolidationIntervalDays = register({
	id: "learning.consolidation.intervalDays",
	type: "number",
	default: 1,
});
export const cfgLearningConsolidationMinEntries = register({
	id: "learning.consolidation.minEntries",
	type: "number",
	default: 15,
});
export const cfgLearningConsolidationTimeoutMs = register({
	id: "learning.consolidation.timeoutMs",
	type: "number",
	default: 240000,
});
export const cfgLearningConsolidationModels = register({
	id: "learning.consolidation.models",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Live Learning Consolidation Chain",
		description: "Ordered model/role fallback chain for the live-learning consolidation agent",
	},
});
