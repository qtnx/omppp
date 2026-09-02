/**
 * Rendered live-learning injection block per repo key.
 *
 * The block is part of the cached system-prompt prefix, so it is computed once
 * per conversation and reused by every prompt rebuild (model switch, tool
 * changes, memory refresh…) until {@link invalidateLearningInjection} marks a
 * real boundary. Background stores and consolidation deliberately do NOT
 * invalidate: they surface in the next conversation instead of busting the
 * provider cache mid-session.
 *
 * Kept dependency-free so session code can import it without pulling the
 * learning runtime (and its task-executor graph) into the session module.
 */
const injectionCache = new Map<string, string | undefined>();

export function getCachedLearningInjection(repoKey: string): { hit: boolean; value: string | undefined } {
	return injectionCache.has(repoKey)
		? { hit: true, value: injectionCache.get(repoKey) }
		: { hit: false, value: undefined };
}

export function setCachedLearningInjection(repoKey: string, value: string | undefined): void {
	injectionCache.set(repoKey, value);
}

/** Drops the memoized injection block so the next prompt rebuild re-reads the store. Call only at conversation boundaries or after user-driven learning edits. */
export function invalidateLearningInjection(): void {
	injectionCache.clear();
}
