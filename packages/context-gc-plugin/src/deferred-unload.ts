import type { ContextRecord } from "./schema";

/**
 * Idle time after which the provider prompt cache is assumed cold. OMPx requests
 * `ttl: "1h"` on Anthropic OAuth (measured: a 7-minute idle still read the full
 * prefix back), so the default is one hour. Guessing too long only delays a
 * free rewrite; guessing too short invalidates a live cache, so the default
 * errs long. `OMP_CONTEXT_GC_CACHE_TTL_MS` overrides for 5-minute providers.
 */
export const PROMPT_CACHE_TTL_MS = readCacheTtlMs(process.env.OMP_CONTEXT_GC_CACHE_TTL_MS);

function readCacheTtlMs(raw: string | undefined): number {
	const parsed = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60_000;
}

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
	/**
	 * Wall-clock and prompt size of the last completed turn per model key
	 * (`provider/id`). Anthropic prompt caches are per model, so warmth must be
	 * tracked per model: a duo planner/executor switch reads cold for the target
	 * while the model that just answered keeps a live prefix.
	 */
	lastResponseByModel: Map<string, ModelResponseRecord>;
}

/** What one completed turn proved about its model's prompt cache. */
export interface ModelResponseRecord {
	/** Wall-clock of the last completed turn for this model. */
	at: number;
	/** Tokens the response proved cacheable: its cache read plus its cache write. */
	prefixTokens: number;
	/** Cache-write price per token, used to price the rewrite a trim would force. */
	writePricePerToken: number;
}

export interface DeferredUnloadDecisionInput {
	/** Unloaded records that match the active context this request. */
	unloaded: readonly ContextRecord[];
	state: DeferredUnloadSessionState;
	/** Live context size in tokens, or `null` when unknown. */
	contextTokens: number | null;
	/** Model that will serve this request, as `provider/id`. */
	modelKey: string;
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
	const cacheCold = isCacheCold(state, input.now, input.modelKey);
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

/**
 * Probability the session flips back to the other model inside the remaining
 * TTL. Shedding at a switch rewrites the target model's prompt for free, but it
 * also invalidates the model that just answered; the gate below prices both.
 */
export const FLIP_BACK_P = 0.5;

/** One record offered to the trim judgment. */
export interface TrimCandidate {
	id: string;
	kind: string;
	/** Conversational turns between the record and the tail. */
	ageTurns: number;
	tokens: number;
	summary: string;
	messageIndex: number;
}

export interface TrimJudgment {
	/** Probability per candidate id that the upcoming work needs the record's full content. */
	keep: Record<string, number>;
	action: "shake" | "compact" | "nothing";
	actionConfidence: number;
}

/**
 * Records the judgment says the upcoming work no longer needs in full. Only ids
 * the model actually answered count — a missing verdict is not a drop, so a
 * truncated or partially failed answer can never shed a record by omission.
 */
export function selectTrimByJudgment<T extends TrimCandidate>(
	candidates: readonly T[],
	judgment: TrimJudgment,
	keepThreshold: number,
): T[] {
	if (judgment.action === "nothing") return [];
	return candidates.filter(candidate => {
		const keep = judgment.keep[candidate.id];
		return keep !== undefined && keep < keepThreshold;
	});
}

/**
 * Whether shedding pays: the target model's cache is cold, so its next write is
 * a full rewrite either way — the saving is the shed tokens priced at that
 * model's cache-write rate. The loss is the other model's still-live prefix,
 * which this rewrite would invalidate, discounted by how likely the session is
 * to flip back before that prefix expires.
 */
export function trimPaysOff(
	state: DeferredUnloadSessionState,
	now: number,
	targetModelKey: string,
	shedTokens: number,
	targetWritePricePerToken: number,
): boolean {
	const saving = shedTokens * targetWritePricePerToken;
	let loss = 0;
	for (const [modelKey, record] of state.lastResponseByModel) {
		if (modelKey === targetModelKey) continue;
		loss += livePrefixTokens(state, now, modelKey) * record.writePricePerToken * FLIP_BACK_P;
	}
	return saving > loss;
}

export function isCacheCold(state: DeferredUnloadSessionState, now: number, modelKey: string): boolean {
	const record = state.lastResponseByModel.get(modelKey);
	return record === undefined || now - record.at >= PROMPT_CACHE_TTL_MS;
}

/** Live prefix the given model could still read back, or 0 when its cache expired. */
export function livePrefixTokens(state: DeferredUnloadSessionState, now: number, modelKey: string): number {
	const record = state.lastResponseByModel.get(modelKey);
	if (record === undefined || now - record.at >= PROMPT_CACHE_TTL_MS) return 0;
	return record.prefixTokens;
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
