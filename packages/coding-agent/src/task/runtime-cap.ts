/**
 * Default wall-clock cap for subagents whose spawn call and `task.maxRuntimeMs`
 * both leave the runtime unbounded. Every slice is sized to finish inside ten
 * minutes; an unbounded run means a stalled or wandering child, not useful work.
 */
const TIER_DEFAULT_RUNTIME_MS: Readonly<Record<string, number>> = {
	quick_task: 5 * 60_000,
	task: 10 * 60_000,
	scout: 10 * 60_000,
	explore: 10 * 60_000,
};
const DEFAULT_SUBAGENT_RUNTIME_MS = 15 * 60_000;

/**
 * Resolve the effective cap. Precedence: explicit spawn value (including `0`
 * = unlimited) > `task.maxRuntimeMs` when > 0 > per-tier default.
 */
export function resolveMaxRuntimeMs(
	agentName: string | undefined,
	requestedMs: number | undefined,
	settingsMs: unknown,
): number {
	if (requestedMs !== undefined) return Math.max(0, Math.trunc(Number(requestedMs) || 0));
	const configured = Math.max(0, Math.trunc(Number(settingsMs ?? 0) || 0));
	if (configured > 0) return configured;
	return TIER_DEFAULT_RUNTIME_MS[agentName ?? ""] ?? DEFAULT_SUBAGENT_RUNTIME_MS;
}
