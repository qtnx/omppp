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
	const cacheCold = isCacheCold(state, input.now);
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

/**
 * Cold-cache auto-shake: when the prompt cache has already expired, the next
 * request re-writes the whole prompt anyway, so shedding stale tool output
 * before that write is free. Only tool-output-like kinds qualify; skills and
 * file mentions carry instructions the model did not ask to drop.
 */
const AUTO_SHAKE_KINDS: Record<string, true> = {
	tool_result: true,
	file_read: true,
	bash_execution: true,
	python_execution: true,
	subagent_output: true,
	browser_output: true,
	mcp_output: true,
	custom_tool_output: true,
};

/** Messages at the tail that are never auto-shaken: the model is likely still using them. */
export const AUTO_SHAKE_KEEP_RECENT_MESSAGES = 12;
/** Below this total the placeholder rewrite is not worth a hidden history change. */
export const AUTO_SHAKE_MIN_TOTAL_TOKENS = 4_000;

export interface AutoShakeCandidate {
	record: ContextRecord;
	messageIndex: number;
	netTokens: number;
}

export function isCacheCold(state: DeferredUnloadSessionState, now: number): boolean {
	return state.lastResponseAt === undefined || now - state.lastResponseAt >= PROMPT_CACHE_TTL_MS;
}

/**
 * Candidate records safe to unload automatically on a cold cache: eligible kind,
 * not among the most recent messages, and worth the rewrite in aggregate.
 */
export function selectAutoShakeRecords(
	candidates: readonly AutoShakeCandidate[],
	messageCount: number,
): ContextRecord[] {
	const cutoff = messageCount - AUTO_SHAKE_KEEP_RECENT_MESSAGES;
	const selected = candidates
		.filter(
			candidate =>
				candidate.record.status === "candidate" &&
				AUTO_SHAKE_KINDS[candidate.record.kind] === true &&
				candidate.messageIndex < cutoff &&
				candidate.netTokens > 0,
		)
		.sort((a, b) => a.messageIndex - b.messageIndex);
	const total = selected.reduce((sum, candidate) => sum + candidate.netTokens, 0);
	if (total < AUTO_SHAKE_MIN_TOTAL_TOKENS) return [];
	return selected.map(candidate => candidate.record);
}
