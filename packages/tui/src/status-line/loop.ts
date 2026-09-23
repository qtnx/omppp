import { truncateToWidth } from "../render/render-utils";
import { sanitizeStatusText } from "../chrome/shared";

/** A `/loop --while` / `/loop --until` continue-condition. */
export interface LoopConditionConfig {
	/** Shell command line, run through the user's configured shell. */
	command: string;
	/** `--until`: continue while the command *fails*. `--while`: while it succeeds. */
	until: boolean;
}

export type LoopLimitRuntime =
	| {
			kind: "iterations";
			initial: number;
			remaining: number;
	  }
	| {
			kind: "duration";
			durationMs: number;
			deadlineMs: number;
	  }
	/**
	 * Fork `/loop` runtime (`modes/loop-limit.ts`): an interval cadence with a
	 * bounded iteration count instead of the `--while`/`--until` condition form.
	 */
	| {
			kind?: undefined;
			intervalMs: number;
			/** Absent when the fork runtime tracks cadence only (no bounded iteration count). */
			initialIterations?: number;
			remainingIterations?: number;
			/** Where the loop re-enters: a fresh prompt, a compaction, or a session reset. */
			context?: "prompt" | "compact" | "reset";
	  };

/** Compact status-line form: `until: bun test`. */
export function summarizeLoopCondition(condition: LoopConditionConfig, maxWidth: number): string {
	const label = condition.until ? "until" : "while";
	return `${label}: ${truncateToWidth(sanitizeStatusText(condition.command), Math.max(1, maxWidth - label.length - 2))}`;
}
