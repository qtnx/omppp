import * as os from "node:os";
import type {
	ContextGcDelta,
	ContextGcReportGroupBy,
	ContextGcReportOptions,
	ContextKind,
	ContextRecord,
	ContextStatus,
} from "./schema";
import { branchRecords, readContextGcSessionStateFromSessionManager } from "./session-state";
import {
	type ContextGcAggregateBucket,
	type ContextGcAggregateTotals,
	type ContextGcGlobalStats,
	type ContextGcStore,
	getContextGcDbPath,
	openContextGcStore,
} from "./storage";

const DEFAULT_LIMIT = 50;
const STATUS_ORDER: ContextStatus[] = ["candidate", "unloaded", "pinned"];
const HOME_DIR = os.homedir();

interface BranchStatusTotals {
	count: number;
	tokens: number;
}

interface BranchStats {
	records: number;
	recallCount: number;
	byStatus: Map<ContextStatus, BranchStatusTotals>;
	byKind: Map<ContextKind, number>;
}

export function renderContextGcReport(options: ContextGcReportOptions): string {
	const dbPath = getContextGcDbPath(options.agentDir);
	const store = openContextGcStore({ dbPath });
	try {
		return renderContextGcReportForStore(options, store);
	} finally {
		store.close();
	}
}

export function renderContextGcReportForStore(options: ContextGcReportOptions, store: ContextGcStore): string {
	const dbPath = store.dbPath;
	const state = readContextGcSessionStateFromSessionManager({
		cwd: options.cwd,
		sessionManager: options.sessionManager,
	});
	const records = branchRecords(store, state);
	switch (options.action) {
		case "stats":
			return renderStatsReport(options, dbPath, state.sessionId, state.sessionFile, records);
		case "global":
			return renderGlobalStatsReport(dbPath, state.sessionId, store.getGlobalStats());
		case "tree":
			return renderTreeReport(options, records);
		case "debug":
			return renderDebugReport(
				options,
				dbPath,
				state.sessionId,
				state.sessionFile,
				records,
				state.deltas,
				state.messageEntries.length,
				store.getAggregateTotals({ sessionId: state.sessionId }),
				store.getAggregateTotals(),
			);
	}
	throw new Error("Unsupported Context GC report action");
}

function renderStatsReport(
	options: ContextGcReportOptions,
	dbPath: string,
	sessionId: string,
	sessionFile: string | undefined,
	records: readonly ContextRecord[],
): string {
	const stats = computeBranchStats(records);
	const candidate = stats.byStatus.get("candidate") ?? { count: 0, tokens: 0 };
	const unloaded = stats.byStatus.get("unloaded") ?? { count: 0, tokens: 0 };
	const pinned = stats.byStatus.get("pinned") ?? { count: 0, tokens: 0 };
	const lines = [
		"Context GC stats",
		`DB path: ${displayPath(dbPath)}`,
		`Session id: ${sessionId}`,
		`Session file: ${displayPath(sessionFile)}`,
		`Current branch records: ${stats.records}`,
		`Candidate tokens: ${candidate.tokens} (${candidate.count} record(s))`,
		`Unloaded tokens: ${unloaded.tokens} (${unloaded.count} record(s))`,
		`Pinned tokens: ${pinned.tokens} (${pinned.count} record(s))`,
		`Estimated active tokens saved: ${unloaded.tokens} branch-effective unloaded token(s)`,
		`Recall count: ${stats.recallCount}`,
	];
	if (options.contextUsage) {
		lines.push(renderContextUsage(options.contextUsage));
	}
	lines.push("By kind:");
	for (const [kind, count] of sortedKindCounts(stats.byKind)) {
		lines.push(`- ${kind}: ${count}`);
	}
	if (stats.byKind.size === 0) lines.push("- (none): 0");
	return lines.join("\n");
}

function renderGlobalStatsReport(dbPath: string, sessionId: string, globalStats: ContextGcGlobalStats): string {
	const candidate = aggregateBucket(globalStats.totals.byStatus, "candidate");
	const unloaded = aggregateBucket(globalStats.totals.byStatus, "unloaded");
	const pinned = aggregateBucket(globalStats.totals.byStatus, "pinned");
	const lines = [
		"Context GC global stats",
		`DB path: ${displayPath(dbPath)}`,
		`Current session id: ${sessionId}`,
		`Global sessions: ${globalStats.sessions}`,
		`Global payloads: ${globalStats.payloads} (${globalStats.payloadBytes} byte(s))`,
		`Global records: ${globalStats.totals.records}`,
		`Candidate tokens: ${candidate.tokens} (${candidate.records} record(s))`,
		`Unloaded tokens: ${unloaded.tokens} (${unloaded.records} record(s))`,
		`Pinned tokens: ${pinned.tokens} (${pinned.records} record(s))`,
		`Estimated global tokens saved: ${unloaded.tokens} unloaded token(s)`,
		`Recall count: ${globalStats.totals.recallCount}`,
		"By kind:",
	];
	for (const bucket of globalStats.totals.byKind) {
		lines.push(
			`- ${bucket.key}: ${bucket.records} record(s), ${bucket.tokens} token(s), ${bucket.recallCount} recall(s)`,
		);
	}
	if (globalStats.totals.byKind.length === 0) lines.push("- (none): 0");
	return lines.join("\n");
}

function renderTreeReport(options: ContextGcReportOptions, records: readonly ContextRecord[]): string {
	const limit = normalizeLimit(options.limit);
	const groupBy = options.groupBy ?? "status";
	const filtered = sortRecords(records.filter(record => !options.status || record.status === options.status)).slice(
		0,
		limit,
	);
	const groups = groupRecords(filtered, groupBy);
	const lines = [`Context GC tree (${groupBy}, ${filtered.length} record(s))`];
	if (options.status) lines.push(`Status filter: ${options.status}`);
	for (const [group, recordsInGroup] of groups) {
		lines.push(`${group}:`);
		for (const record of recordsInGroup) {
			lines.push(
				`- ${record.id} [${record.kind}/${record.status}, ${record.tokenEstimate} tok, recalls ${record.recallCount}] ${sourceHint(record)} — ${record.summary}`,
			);
		}
	}
	if (filtered.length === 0) lines.push("No current-branch Context GC records found.");
	return lines.join("\n");
}

function renderDebugReport(
	options: ContextGcReportOptions,
	dbPath: string,
	sessionId: string,
	sessionFile: string | undefined,
	records: readonly ContextRecord[],
	deltas: readonly ContextGcDelta[],
	messageCount: number,
	sessionAggregate: ContextGcAggregateTotals,
	databaseAggregate: ContextGcAggregateTotals,
): string {
	const limit = normalizeLimit(options.limit);
	const visibleRecords = options.status ? records.filter(record => record.status === options.status) : records;
	const recordIds = new Set(records.map(record => record.id));
	const missingDeltaIds = [...new Set(deltas.map(delta => delta.id).filter(id => !recordIds.has(id)))];
	const lines = [
		"Context GC debug",
		`DB path: ${displayPath(dbPath)}`,
		`CWD: ${displayPath(options.cwd)}`,
		`Session id: ${sessionId}`,
		`Session file: ${displayPath(sessionFile)}`,
		`Branch delta count: ${deltas.length}`,
		`Branch message count: ${messageCount}`,
		`Current branch records: ${visibleRecords.length}${options.status ? ` (${options.status})` : ""}`,
		`Current branch aggregate: ${formatAggregate(aggregateRecords(records))}`,
		`Current session raw DB aggregate: ${formatAggregate(sessionAggregate)}`,
		`Raw database aggregate: ${formatAggregate(databaseAggregate)}`,
		`Missing delta record ids: ${missingDeltaIds.length === 0 ? "(none)" : missingDeltaIds.join(", ")}`,
		`Latest deltas (limit ${limit}):`,
	];
	for (const delta of deltas.slice(-limit).reverse()) {
		lines.push(`- ${delta.createdAt} ${delta.op} ${delta.id}${delta.status ? ` -> ${delta.status}` : ""}`);
	}
	if (deltas.length === 0) lines.push("- (none)");
	if (options.includeRecords) {
		lines.push(`Records (limit ${limit}):`);
		for (const record of sortRecords(visibleRecords).slice(0, limit)) {
			lines.push(
				`- ${record.id} [${record.kind}/${record.status}, ${record.tokenEstimate} tok] ${sourceHint(record)} — ${record.summary}`,
			);
		}
		if (visibleRecords.length === 0) lines.push("- (none)");
	}
	return lines.join("\n");
}

function computeBranchStats(records: readonly ContextRecord[]): BranchStats {
	const byStatus = new Map<ContextStatus, BranchStatusTotals>();
	const byKind = new Map<ContextKind, number>();
	let recallCount = 0;
	for (const record of records) {
		const current = byStatus.get(record.status) ?? { count: 0, tokens: 0 };
		current.count += 1;
		current.tokens += record.tokenEstimate;
		byStatus.set(record.status, current);
		byKind.set(record.kind, (byKind.get(record.kind) ?? 0) + 1);
		recallCount += record.recallCount;
	}
	return { records: records.length, recallCount, byStatus, byKind };
}

function sortedKindCounts(counts: ReadonlyMap<ContextKind, number>): Array<[ContextKind, number]> {
	return [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]));
}

function sortRecords(records: readonly ContextRecord[]): ContextRecord[] {
	return [...records].sort((left, right) => {
		if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
		return left.id.localeCompare(right.id);
	});
}

function groupRecords(
	records: readonly ContextRecord[],
	groupBy: ContextGcReportGroupBy,
): Map<string, ContextRecord[]> {
	const groups = new Map<string, ContextRecord[]>();
	for (const record of records) {
		const key = groupKey(record, groupBy);
		const group = groups.get(key) ?? [];
		group.push(record);
		groups.set(key, group);
	}
	return new Map([...groups.entries()].sort((left, right) => sortGroupKeys(left[0], right[0], groupBy)));
}

function groupKey(record: ContextRecord, groupBy: ContextGcReportGroupBy): string {
	switch (groupBy) {
		case "status":
			return record.status;
		case "kind":
			return record.kind;
		case "source":
			return sourceGroup(record);
	}
}

function sortGroupKeys(left: string, right: string, groupBy: ContextGcReportGroupBy): number {
	if (groupBy === "status") {
		const leftIndex = STATUS_ORDER.indexOf(left as ContextStatus);
		const rightIndex = STATUS_ORDER.indexOf(right as ContextStatus);
		if (leftIndex !== rightIndex) return leftIndex - rightIndex;
	}
	return left.localeCompare(right);
}

function sourceLabel(record: ContextRecord): string | null {
	const source = record.source;
	return (
		source.path ??
		source.uri ??
		record.sourceUri ??
		source.command ??
		source.toolName ??
		source.skillName ??
		source.customType ??
		record.artifactId
	);
}

function sourceGroup(record: ContextRecord): string {
	const label = sourceLabel(record);
	return label ? compactOneLine(sanitizeDisplayText(label)) : record.kind;
}

function sourceHint(record: ContextRecord): string {
	const label = sourceLabel(record);
	return label ? `source=${compactOneLine(sanitizeDisplayText(label))}` : "source=(unknown)";
}

function displayPath(value: string | undefined): string {
	return value ? sanitizeDisplayText(value) : "(none)";
}

function sanitizeDisplayText(value: string): string {
	if (HOME_DIR.length === 0) return value;
	return value.replaceAll(`${HOME_DIR}/`, "~/").replaceAll(HOME_DIR, "~");
}

function compactOneLine(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	return Math.min(200, Math.max(1, Math.trunc(limit)));
}

function renderContextUsage(contextUsage: NonNullable<ContextGcReportOptions["contextUsage"]>): string {
	const tokens = contextUsage.tokens ?? null;
	const percent = contextUsage.percent ?? null;
	const tokensText = tokens === null ? "unknown" : String(tokens);
	const percentText = percent === null ? "unknown" : `${percent}%`;
	return `Context usage: ${tokensText}/${contextUsage.contextWindow} tokens (${percentText})`;
}

function aggregateRecords(records: readonly ContextRecord[]): ContextGcAggregateTotals {
	const byStatus = new Map<string, ContextGcAggregateBucket>();
	const byKind = new Map<string, ContextGcAggregateBucket>();
	let tokens = 0;
	let recallCount = 0;
	for (const record of records) {
		tokens += record.tokenEstimate;
		recallCount += record.recallCount;
		addAggregateBucket(byStatus, record.status, record);
		addAggregateBucket(byKind, record.kind, record);
	}
	return {
		records: records.length,
		tokens,
		recallCount,
		byStatus: sortAggregateBuckets(byStatus),
		byKind: sortAggregateBuckets(byKind),
	};
}

function addAggregateBucket(buckets: Map<string, ContextGcAggregateBucket>, key: string, record: ContextRecord): void {
	const bucket = buckets.get(key) ?? { key, records: 0, tokens: 0, recallCount: 0 };
	bucket.records += 1;
	bucket.tokens += record.tokenEstimate;
	bucket.recallCount += record.recallCount;
	buckets.set(key, bucket);
}

function sortAggregateBuckets(buckets: ReadonlyMap<string, ContextGcAggregateBucket>): ContextGcAggregateBucket[] {
	return [...buckets.values()].sort((left, right) => {
		if (left.records !== right.records) return right.records - left.records;
		return left.key.localeCompare(right.key);
	});
}

function aggregateBucket(
	buckets: readonly ContextGcAggregateBucket[],
	key: "candidate" | "unloaded" | "pinned",
): ContextGcAggregateBucket {
	return buckets.find(bucket => bucket.key === key) ?? { key, records: 0, tokens: 0, recallCount: 0 };
}

function formatAggregate(aggregate: ContextGcAggregateTotals): string {
	return `${aggregate.records} record(s), ${aggregate.tokens} token(s), ${aggregate.recallCount} recall(s); status ${formatBuckets(aggregate.byStatus)}; kind ${formatBuckets(aggregate.byKind)}`;
}

function formatBuckets(buckets: readonly ContextGcAggregateBucket[]): string {
	if (buckets.length === 0) return "(none)";
	return buckets
		.map(bucket => `${bucket.key}=${bucket.records}/${bucket.tokens}tok/${bucket.recallCount}recall`)
		.join(", ");
}
