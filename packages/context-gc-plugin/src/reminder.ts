import { prompt } from "@oh-my-pi/pi-utils";
import reminderPrompt from "./context-gc-reminder.md" with { type: "text" };
import usageReminderPrompt from "./context-usage-reminder.md" with { type: "text" };
import type { ContextRecord } from "./schema";

export interface ContextGcReminderUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface BuildUnloadReminderOptions {
	thresholdTokens: number;
	contextUsage?: ContextGcReminderUsage;
	minContextUsagePercent?: number;
}

function contextUsageBelowThreshold(options: BuildUnloadReminderOptions): boolean {
	if (options.minContextUsagePercent === undefined) return false;
	const usage = options.contextUsage;
	if (!usage || usage.percent === null) return false;
	return usage.percent <= options.minContextUsagePercent;
}

function formatContextUsage(usage: ContextGcReminderUsage | undefined): string | undefined {
	if (!usage || usage.tokens === null || usage.percent === null) return undefined;
	const percent = Number.isInteger(usage.percent) ? String(usage.percent) : usage.percent.toFixed(1);
	return `Context usage: ${usage.tokens}/${usage.contextWindow} tokens (${percent}%).`;
}

/** Usage-only nudge for the phase-boundary compaction rule. Independent of unload
 * candidates: the model has no other way to learn its context percentage. */
export function buildContextUsageReminder(
	usage: ContextGcReminderUsage | undefined,
	minPercent: number,
): string | undefined {
	if (!usage || usage.percent === null || usage.percent < minPercent) return undefined;
	const line = formatContextUsage(usage);
	if (!line) return undefined;
	return prompt.render(usageReminderPrompt, { context_usage_line: line }).trim();
}

export function buildContextGcReminder(
	records: readonly ContextRecord[],
	options: BuildUnloadReminderOptions,
): string | undefined {
	if (contextUsageBelowThreshold(options)) return undefined;
	const candidates = records.filter(record => record.status === "candidate");
	const totalTokens = candidates.reduce((sum, record) => sum + record.tokenEstimate, 0);
	if (totalTokens < options.thresholdTokens) return undefined;

	return prompt
		.render(reminderPrompt, {
			eligible_tokens: String(totalTokens),
			context_usage_line: formatContextUsage(options.contextUsage),
		})
		.trim();
}
