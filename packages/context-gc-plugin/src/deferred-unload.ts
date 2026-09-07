import type { ContextRecord } from "./schema";

/**
 * Anthropic-style prompt caches expire after 5 minutes without use. Once the
 * cache is cold, rewriting history costs nothing extra, so pending unloads can
 * be applied for free.
 */
export const PROMPT_CACHE_TTL_MS = 5 * 60_000;

/**
 * Projecting an unloaded record rewrites every prompt byte after it, which
 * re-writes the provider prompt cache at ~12.5× the read price. Below this
 * share of the live context the rewrite rarely pays back within a session, so
 * the unload is deferred until the cache is cold anyway.
 */
export const DEFERRED_UNLOAD_APPLY_RATIO = 0.3;

export interface DeferredUnloadSessionState {
	/** Unloaded record ids already projected; sticky so the prefix never flips back. */
	applied: Set<string>;
	/** Wall-clock of the last completed model turn in this process. */
	lastResponseAt?: number;
}

export interface DeferredUnloadDecisionInput {
	/** Unloaded records that match the active context this request. */
	unloaded: readonly ContextRecord[];
	state: DeferredUnloadSessionState;
	/** Live context size in tokens, or `null` when unknown. */
	contextTokens: number | null;
	now: number;
}

export interface DeferredUnloadDecision {
	/** Record ids to project as placeholders this request. */
	projectIds: Set<string>;
	/** Ids newly applied by this decision (empty when everything stayed deferred). */
	newlyApplied: string[];
	reason: "none" | "cache-cold" | "ratio" | "deferred";
	deferredTokens: number;
}

export function decideDeferredUnloads(input: DeferredUnloadDecisionInput): DeferredUnloadDecision {
	const { state } = input;
	const pending = input.unloaded.filter(record => !state.applied.has(record.id));
	if (pending.length === 0) {
		return { projectIds: new Set(state.applied), newlyApplied: [], reason: "none", deferredTokens: 0 };
	}
	const deferredTokens = pending.reduce((sum, record) => sum + record.tokenEstimate, 0);
	const cacheCold = state.lastResponseAt === undefined || input.now - state.lastResponseAt >= PROMPT_CACHE_TTL_MS;
	const worthRewrite =
		input.contextTokens === null ||
		input.contextTokens <= 0 ||
		deferredTokens >= input.contextTokens * DEFERRED_UNLOAD_APPLY_RATIO;
	if (!cacheCold && !worthRewrite) {
		return { projectIds: new Set(state.applied), newlyApplied: [], reason: "deferred", deferredTokens };
	}
	const newlyApplied = pending.map(record => record.id);
	for (const id of newlyApplied) state.applied.add(id);
	return {
		projectIds: new Set(state.applied),
		newlyApplied,
		reason: cacheCold ? "cache-cold" : "ratio",
		deferredTokens,
	};
}
