import type { ContextRecord } from "./schema";

export interface ContextGcReminderUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface BuildUnloadReminderOptions {
	thresholdTokens: number;
	maxRecords?: number;
	contextUsage?: ContextGcReminderUsage;
	minContextUsagePercent?: number;
}

function recordSummary(record: ContextRecord): string {
	const tool = record.source.toolName ? ` from ${record.source.toolName}` : "";
	return `${record.kind}${tool} — ${record.summary}`;
}

function contextUsageBelowThreshold(options: BuildUnloadReminderOptions): boolean {
	if (options.minContextUsagePercent === undefined) return false;
	const usage = options.contextUsage;
	if (!usage || usage.percent === null) return false;
	return usage.percent < options.minContextUsagePercent;
}

function formatContextUsage(usage: ContextGcReminderUsage | undefined): string | undefined {
	if (!usage || usage.tokens === null || usage.percent === null) return undefined;
	const percent = Number.isInteger(usage.percent) ? String(usage.percent) : usage.percent.toFixed(1);
	return `Context usage: ${usage.tokens}/${usage.contextWindow} tokens (${percent}%).`;
}

export function buildContextGcReminder(
	records: readonly ContextRecord[],
	options: BuildUnloadReminderOptions,
): string | undefined {
	if (contextUsageBelowThreshold(options)) return undefined;
	const candidates = records.filter(record => record.status === "candidate");
	const totalTokens = candidates.reduce((sum, record) => sum + record.tokenEstimate, 0);
	if (totalTokens < options.thresholdTokens) return undefined;

	const maxRecords = options.maxRecords ?? 8;
	const lines = candidates
		.slice(0, maxRecords)
		.map(record => `- ${record.id} (${record.tokenEstimate} tok): ${recordSummary(record)}`);
	const extra = candidates.length > maxRecords ? `\n- … ${candidates.length - maxRecords} more candidate(s)` : "";
	const usageLine = formatContextUsage(options.contextUsage);
	const header = [`Context GC: ${totalTokens} estimated tokens are eligible to unload.`];
	if (usageLine) header.push(usageLine);
	return (
		[
			...header,
			"If these contexts are no longer needed, call context_unload with ids, summary, and reason. Use context_pin for context that must remain available.",
			...lines,
		].join("\n") + extra
	);
}
