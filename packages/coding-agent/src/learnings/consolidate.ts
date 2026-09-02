import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import consolidatePrompt from "../prompts/learnings/consolidate.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import * as taskExecutor from "../task/executor";
import type { AgentDefinition } from "../task/types";
import * as repoKey from "./repo-key";
import {
	archiveBeyondActiveCap,
	archiveLearning,
	archiveStaleRepoLearnings,
	closeLearningDb,
	computeLearningWatermark,
	healSiblingLegacyCwds,
	isConsolidationClaimHeld,
	type LearningScope,
	markConsolidationFailed,
	markConsolidationSucceeded,
	mergeConsolidatedEntries,
	normalizeLearningContent,
	openLearningDb,
	rescopeLearning,
	rewriteLearning,
	tryClaimConsolidationJob,
} from "./storage";

export interface ConsolidationRunOptions {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	force?: boolean;
}

export interface ConsolidationRunReport {
	target: string;
	outcome:
		| "applied"
		| "skipped_not_dirty"
		| "skipped_running"
		| "skipped_retry_backoff"
		| "skipped_below_threshold"
		| "failed";
	opsApplied?: number;
	opsSkippedStale?: number;
	/** Lowest-ranked entries archived after the model pass to honour `maxEntriesPerScope`. */
	capArchived?: number;
}

interface ConsolidationConfig {
	intervalDays: number;
	maxEntriesPerScope: number;
	minEntries: number;
	halfLifeDays: number;
	staleRepoDays: number;
	models: string[];
	timeoutMs: number;
}

interface ConsolidationTarget {
	scope: LearningScope;
	/** Key of the entries this target consolidates (`""` for global). */
	repoKey: string;
	/** Repo the session runs in; destination for `rescope` → `repo` ops on the global target. */
	currentRepoKey: string;
	target: string;
	jobKey: string;
}

interface ActiveLearningRow {
	id: string;
	scope: LearningScope;
	content: string;
	content_hash: string;
	confidence: number;
	created_at: number;
	updated_at: number;
	strength: number;
	useful_count: number;
	not_useful_count: number;
	last_reinforced_at: number | null;
	shown_count: number;
}

interface TargetJobRow {
	status: string;
	finished_at: number | null;
	last_success_watermark: number | null;
}

interface ConsolidationSnapshotEntry {
	id: string;
	alias: string;
	content: string;
	scope: LearningScope;
	confidence: number;
	createdAt: number;
	updatedAt: number;
	strength: number;
	usefulCount: number;
	notUsefulCount: number;
	lastReinforcedAt: number | null;
	shownCount: number;
	ageDays: number;
}

interface ConsolidatorTaskEntry {
	alias: string;
	content: string;
	scope: LearningScope;
	strength: number;
	usefulCount: number;
	notUsefulCount: number;
	shownCount: number;
	ageDays: number;
	updatedAt: number;
}

interface MergeOperation {
	op: "merge";
	ids: string[];
	content: string;
}

interface RewriteOperation {
	op: "rewrite";
	id: string;
	content: string;
}

interface RescopeOperation {
	op: "rescope";
	id: string;
	scope: LearningScope;
}

interface ArchiveOperation {
	op: "archive";
	id: string;
	reason: string;
}

interface KeepOperation {
	op: "keep";
	id: string;
}

type ConsolidationOperation = MergeOperation | RewriteOperation | RescopeOperation | ArchiveOperation | KeepOperation;

interface ApplyCounts {
	opsApplied: number;
	opsSkippedStale: number;
}

const DEFAULT_WRITER_MODELS = ["pi/plan", "pi/default"];
const DEFAULT_INTERVAL_DAYS = 1;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 40;
const DEFAULT_MIN_ENTRIES = 15;
const DEFAULT_HALF_LIFE_DAYS = 45;
const DEFAULT_STALE_REPO_DAYS = 90;
const DEFAULT_TIMEOUT_MS = 240_000;
/** Extra subagent time granted per entry on top of the configured base timeout. */
const TIMEOUT_PER_ENTRY_MS = 1_500;
const MAX_TIMEOUT_MS = 600_000;
const CONSOLIDATION_RETRY_DELAY_SECONDS = 300;
const CONSOLIDATION_RETRY_LIMIT = 3;
/** Snapshots larger than this are consolidated in content-sorted batches so no single subagent run exceeds the timeout. */
const CONSOLIDATION_BATCH_SIZE = 60;
/** Matches the one-sentence limit in `prompts/learnings/consolidate.md`; rewrites of entries already within it must shrink them. */
const REWRITE_WORD_LIMIT = 30;
const MIN_CONSOLIDATION_LEASE_SECONDS = 300;

const CONSOLIDATION_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		ops: {
			type: "array",
			items: {
				oneOf: [
					{
						type: "object",
						additionalProperties: false,
						properties: {
							op: { const: "merge" },
							ids: { type: "array", items: { type: "string" }, minItems: 2 },
							content: { type: "string" },
						},
						required: ["op", "ids", "content"],
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							op: { const: "rewrite" },
							id: { type: "string" },
							content: { type: "string" },
						},
						required: ["op", "id", "content"],
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							op: { const: "rescope" },
							id: { type: "string" },
							scope: { enum: ["global", "repo"] },
						},
						required: ["op", "id", "scope"],
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							op: { const: "archive" },
							id: { type: "string" },
							reason: { type: "string" },
						},
						required: ["op", "id", "reason"],
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							op: { const: "keep" },
							id: { type: "string" },
						},
						required: ["op", "id"],
					},
				],
			},
		},
	},
	required: ["ops"],
} as const;

const CONSOLIDATOR_AGENT: AgentDefinition = {
	name: "learning-consolidator",
	description: "Consolidates active live-learning entries into durable guidance",
	systemPrompt: consolidatePrompt,
	model: DEFAULT_WRITER_MODELS,
	thinkingLevel: Effort.Medium,
	output: CONSOLIDATION_OUTPUT_SCHEMA,
	source: "bundled",
};

export async function maybeRunLearningConsolidation(
	options: ConsolidationRunOptions,
): Promise<ConsolidationRunReport[]> {
	const { session, settings, modelRegistry, agentDir, force = false } = options;
	const cwd = session.sessionManager.getCwd();
	const resolvedRepoKey = await repoKey.resolveRepoKey(cwd);
	const config = loadConsolidationConfig(settings);
	const db = openLearningDb(getAgentDbPath(agentDir));
	try {
		const stale = archiveStaleRepoLearnings(db, {
			excludeRepoKey: resolvedRepoKey,
			staleDays: config.staleRepoDays,
			nowSec: unixNow(),
		});
		if (stale.archived > 0) {
			logger.debug("live-learning: archived learnings of idle repositories", stale);
		}
		const targets: ConsolidationTarget[] = [
			{ scope: "global", repoKey: "", currentRepoKey: resolvedRepoKey, target: "global", jobKey: "global" },
			{
				scope: "repo",
				repoKey: resolvedRepoKey,
				currentRepoKey: resolvedRepoKey,
				target: `repo:${resolvedRepoKey}`,
				jobKey: `repo:${resolvedRepoKey}`,
			},
		];
		const reports: ConsolidationRunReport[] = [];
		for (const target of targets) {
			reports.push(
				await runTargetConsolidation({
					db,
					target,
					config,
					session,
					settings,
					modelRegistry,
					agentDir,
					cwd,
					force,
				}),
			);
		}
		return reports;
	} finally {
		closeLearningDb(db);
	}
}

async function runTargetConsolidation(options: {
	db: Database;
	target: ConsolidationTarget;
	config: ConsolidationConfig;
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	cwd: string;
	force: boolean;
}): Promise<ConsolidationRunReport> {
	const { db, target, config, session, settings, modelRegistry, agentDir, cwd, force } = options;
	const thresholdNow = unixNow();
	const activeCount = listTargetEntries(db, target, thresholdNow).length;
	const lastSuccessAt = readLastSuccessAt(db, target.jobKey);
	const intervalSeconds = config.intervalDays * 86_400;
	const stale = lastSuccessAt === null || thresholdNow - lastSuccessAt >= intervalSeconds;
	if (!force && (activeCount < config.minEntries || (!stale && activeCount < 2 * config.maxEntriesPerScope))) {
		logger.debug("live-learning: consolidation skipped below threshold", {
			target: target.target,
			activeCount,
			minEntries: config.minEntries,
			lastSuccessAt,
		});
		return { target: target.target, outcome: "skipped_below_threshold" };
	}

	const claimNow = unixNow();
	const inputWatermark = computeLearningWatermark(db, {
		scope: target.scope,
		repoKey: target.repoKey,
		nowSec: claimNow,
	});
	const claimResult = tryClaimConsolidationJob(db, {
		jobKey: target.jobKey,
		workerId: session.sessionId,
		leaseSeconds: consolidationLeaseSeconds(config, activeCount),
		nowSec: claimNow,
		inputWatermark,
		retryLimit: CONSOLIDATION_RETRY_LIMIT,
		force,
	});
	if (claimResult.kind !== "claimed") {
		logger.debug("live-learning: consolidation claim skipped", {
			target: target.target,
			outcome: claimResult.kind,
		});
		return { target: target.target, outcome: claimResult.kind };
	}

	const runId = `consolidation-${claimNow}-${crypto.randomUUID()}`;
	const auditDir = path.join(agentDir, "learning-audit", "consolidation", runId);
	const parsedOps: ConsolidationOperation[] = [];
	try {
		if (target.scope === "repo") {
			const healed = await healSiblingLegacyCwds(db, {
				repoKey: target.repoKey,
				resolveKey: repoKey.resolveRepoKey,
				probeLimit: 16,
				nowSec: unixNow(),
			});
			logger.debug("live-learning: consolidation sibling healing completed", {
				target: target.target,
				healed,
			});
		}

		const snapshot = listTargetEntries(db, target, unixNow());
		const modelOverride = config.models.length > 0 ? config.models : DEFAULT_WRITER_MODELS;
		await writeAuditFile(auditDir, "request.json", {
			target: target.target,
			inputWatermark: claimResult.claim.inputWatermark,
			modelOverride,
			task: {
				target: target.target,
				maxEntriesPerScope: config.maxEntriesPerScope,
				entries: snapshot.map(toConsolidatorTaskEntry),
			},
		});
		if (snapshot.length === 0) {
			await writeAuditFile(auditDir, "ops.json", { ops: [] });
			if (!markConsolidationSucceeded(db, { claim: claimResult.claim, nowSec: unixNow() })) {
				throw new Error("Consolidation lease was lost before the empty snapshot completed");
			}
			const report: ConsolidationRunReport = {
				target: target.target,
				outcome: "applied",
				opsApplied: 0,
				opsSkippedStale: 0,
			};
			await writeAuditFile(auditDir, "result.json", report);
			logger.debug("live-learning: consolidation completed empty snapshot", {
				target: target.target,
				runId,
			});
			return report;
		}

		const sessionFile = session.sessionManager.getSessionFile() ?? undefined;
		const contextFiles = sessionFile ? [{ path: sessionFile, content: "" }] : undefined;
		const batches = splitConsolidationBatches(snapshot);
		for (const [batchIndex, batch] of batches.entries()) {
			const task = JSON.stringify({
				target: target.target,
				batch: { index: batchIndex + 1, count: batches.length },
				maxEntriesPerScope: Math.max(1, Math.ceil((config.maxEntriesPerScope * batch.length) / snapshot.length)),
				entries: batch.map(toConsolidatorTaskEntry),
			});
			const result = await taskExecutor.runSubprocess({
				cwd,
				agent: CONSOLIDATOR_AGENT,
				task,
				index: batchIndex,
				// One registry slot per target run: reusing a fixed id across the global
				// and repo targets (or across batches) trips the "already owned by another
				// session generation" guard on the second spawn.
				id: `learning-consolidator-${target.scope}-${claimNow}-${batchIndex + 1}`,
				modelOverride,
				parentActiveModelPattern: session.model ? formatModelId(session.model) : undefined,
				thinkingLevel: Effort.Medium,
				outputSchema: CONSOLIDATION_OUTPUT_SCHEMA,
				taskDepth: 0,
				enableLsp: false,
				signal: AbortSignal.timeout(consolidationTimeoutMs(config, batch.length)),
				contextFiles,
				artifactsDir: batches.length === 1 ? auditDir : path.join(auditDir, `batch-${batchIndex + 1}`),
				persistArtifacts: true,
				modelRegistry,
				settings,
			});
			if (result.exitCode !== 0) throw new Error(consolidatorFailureMessage(result));
			const parsed = parseConsolidationOperations(result.output);
			if (!parsed) throw new Error("Consolidator returned an invalid operations payload");
			parsedOps.push(...parsed);
		}
		await writeAuditFile(auditDir, "ops.json", { ops: parsedOps });
		if (!isConsolidationClaimHeld(db, { claim: claimResult.claim, nowSec: unixNow() })) {
			throw new Error("lease lost");
		}
		const counts = applyConsolidationOperations(db, target, snapshot, parsedOps);
		const capArchived = archiveBeyondActiveCap(db, {
			scope: target.scope,
			repoKey: target.repoKey,
			maxActive: config.maxEntriesPerScope,
			halfLifeDays: config.halfLifeDays,
			nowSec: unixNow(),
		}).length;
		if (!markConsolidationSucceeded(db, { claim: claimResult.claim, nowSec: unixNow() })) {
			throw new Error("Consolidation lease was lost before completion");
		}
		const report: ConsolidationRunReport = {
			target: target.target,
			outcome: "applied",
			...counts,
			capArchived,
		};
		await writeAuditFile(auditDir, "result.json", report);
		logger.debug("live-learning: consolidation applied", {
			target: target.target,
			runId,
			...counts,
		});
		return report;
	} catch (error) {
		const message =
			error instanceof Error && error.message === "lease lost" ? error.message : truncateError(String(error));
		await writeAuditFile(auditDir, "ops.json", { ops: parsedOps });
		markConsolidationFailed(db, {
			claim: claimResult.claim,
			error: message,
			retryDelaySeconds: CONSOLIDATION_RETRY_DELAY_SECONDS,
			nowSec: unixNow(),
		});
		const report: ConsolidationRunReport = { target: target.target, outcome: "failed" };
		await writeAuditFile(auditDir, "result.json", { ...report, error: message });
		logger.debug("live-learning: consolidation failed", {
			target: target.target,
			runId,
			error: message,
		});
		return report;
	}
}

function listTargetEntries(db: Database, target: ConsolidationTarget, nowSec: number): ConsolidationSnapshotEntry[] {
	const rows =
		target.scope === "global"
			? (db
					.prepare(`
SELECT id, scope, content, content_hash, confidence, created_at, updated_at, strength,
	useful_count, not_useful_count, last_reinforced_at, shown_count
FROM live_learnings
WHERE scope = 'global' AND cwd = '' AND status = 'active'
ORDER BY updated_at ASC, created_at ASC, id ASC
`)
					.all() as ActiveLearningRow[])
			: (db
					.prepare(`
SELECT id, scope, content, content_hash, confidence, created_at, updated_at, strength,
	useful_count, not_useful_count, last_reinforced_at, shown_count
FROM live_learnings
WHERE scope = 'repo' AND COALESCE(repo_key, cwd) = ? AND status = 'active'
ORDER BY updated_at ASC, created_at ASC, id ASC
`)
					.all(target.repoKey) as ActiveLearningRow[]);
	return rows.map(row => {
		const lastActivity = row.last_reinforced_at ?? row.updated_at;
		return {
			id: row.id,
			alias: row.content_hash.slice(0, 12),
			content: row.content,
			scope: target.scope,
			confidence: row.confidence,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			strength: row.strength,
			usefulCount: row.useful_count,
			notUsefulCount: row.not_useful_count,
			lastReinforcedAt: row.last_reinforced_at,
			shownCount: row.shown_count,
			ageDays: Math.max(0, (nowSec - lastActivity) / 86_400),
		};
	});
}

function toConsolidatorTaskEntry(entry: ConsolidationSnapshotEntry): ConsolidatorTaskEntry {
	return {
		alias: entry.alias,
		content: entry.content,
		scope: entry.scope,
		strength: entry.strength,
		usefulCount: entry.usefulCount,
		notUsefulCount: entry.notUsefulCount,
		shownCount: entry.shownCount,
		ageDays: entry.ageDays,
		updatedAt: entry.updatedAt,
	};
}

/** Subagent budget for one batch: configured base plus a per-entry allowance, capped. */
function consolidationTimeoutMs(config: ConsolidationConfig, entryCount: number): number {
	return Math.min(MAX_TIMEOUT_MS, config.timeoutMs + TIMEOUT_PER_ENTRY_MS * entryCount);
}

/** Lease long enough for every batch to run back-to-back at its full timeout, plus apply slack. */
function consolidationLeaseSeconds(config: ConsolidationConfig, entryCount: number): number {
	const batches = Math.max(1, Math.ceil(entryCount / CONSOLIDATION_BATCH_SIZE));
	const perBatchMs = consolidationTimeoutMs(config, Math.min(entryCount, CONSOLIDATION_BATCH_SIZE));
	return Math.max(MIN_CONSOLIDATION_LEASE_SECONDS, Math.ceil((batches * perBatchMs) / 1_000) + 60);
}

/**
 * Splits a snapshot into batches of at most {@link CONSOLIDATION_BATCH_SIZE}.
 * Entries are ordered by normalized content first so near-duplicates (which
 * usually share their opening words) land in the same batch and can be merged.
 */
function splitConsolidationBatches(snapshot: ConsolidationSnapshotEntry[]): ConsolidationSnapshotEntry[][] {
	if (snapshot.length <= CONSOLIDATION_BATCH_SIZE) return [snapshot];
	const sorted = snapshot.toSorted((left, right) =>
		normalizeLearningContent(left.content).localeCompare(normalizeLearningContent(right.content)),
	);
	const batchCount = Math.ceil(sorted.length / CONSOLIDATION_BATCH_SIZE);
	const batchSize = Math.ceil(sorted.length / batchCount);
	const batches: ConsolidationSnapshotEntry[][] = [];
	for (let start = 0; start < sorted.length; start += batchSize) {
		batches.push(sorted.slice(start, start + batchSize));
	}
	return batches;
}

function countWords(content: string): number {
	return normalizeLearningContent(content).split(" ").filter(Boolean).length;
}

function readLastSuccessAt(db: Database, jobKey: string): number | null {
	const row = db
		.prepare(`
SELECT status, finished_at, last_success_watermark
FROM live_learning_jobs
WHERE kind = 'consolidation' AND job_key = ?
`)
		.get(jobKey) as TargetJobRow | null;
	if (row?.status !== "idle" || row.last_success_watermark === null || row.finished_at === null) return null;
	return row.finished_at;
}

function applyConsolidationOperations(
	db: Database,
	target: ConsolidationTarget,
	snapshot: ConsolidationSnapshotEntry[],
	operations: ConsolidationOperation[],
): ApplyCounts {
	const counts: ApplyCounts = { opsApplied: 0, opsSkippedStale: 0 };
	for (const operation of operations) {
		if (operation.op === "keep") continue;
		if (operation.op === "merge") {
			const sources = operation.ids.map(alias => resolveSnapshotAlias(snapshot, alias));
			if (sources.some(source => source === undefined)) {
				counts.opsSkippedStale += 1;
				continue;
			}
			const entries = sources.filter((source): source is ConsolidationSnapshotEntry => source !== undefined);
			let lastReinforcedAt: number | null = null;
			for (const entry of entries) {
				if (entry.lastReinforcedAt !== null) {
					lastReinforcedAt =
						lastReinforcedAt === null
							? entry.lastReinforcedAt
							: Math.max(lastReinforcedAt, entry.lastReinforcedAt);
				}
			}
			const merged = mergeConsolidatedEntries(db, {
				sources: entries.map(entry => ({ id: entry.id, guardUpdatedAt: entry.updatedAt })),
				scope: target.scope,
				repoKey: target.repoKey,
				content: operation.content,
				strength: Math.min(
					10,
					entries.reduce((sum, entry) => sum + entry.strength, 0),
				),
				usefulCount: Math.min(
					999,
					entries.reduce((sum, entry) => sum + entry.usefulCount, 0),
				),
				notUsefulCount: Math.min(
					999,
					entries.reduce((sum, entry) => sum + entry.notUsefulCount, 0),
				),
				confidence: Math.max(...entries.map(entry => entry.confidence)),
				createdAt: Math.min(...entries.map(entry => entry.createdAt)),
				lastReinforcedAt,
				nowSec: unixNow(),
			});
			if (merged) counts.opsApplied += 1;
			else counts.opsSkippedStale += 1;
			continue;
		}

		const entry = resolveSnapshotAlias(snapshot, operation.id);
		if (!entry) {
			counts.opsSkippedStale += 1;
			continue;
		}
		if (operation.op === "rewrite") {
			// A rewrite that does not shrink an already-short entry is churn: it bumps
			// updated_at (re-dirtying the job for another LLM pass) without gaining
			// anything. Treat it as keep.
			if (
				normalizeLearningContent(operation.content) === normalizeLearningContent(entry.content) ||
				(countWords(entry.content) <= REWRITE_WORD_LIMIT &&
					countWords(operation.content) >= countWords(entry.content))
			) {
				continue;
			}
			if (
				rewriteLearning(db, {
					id: entry.id,
					content: operation.content,
					guardUpdatedAt: entry.updatedAt,
					nowSec: unixNow(),
				})
			) {
				counts.opsApplied += 1;
			} else {
				counts.opsSkippedStale += 1;
			}
			continue;
		}
		if (operation.op === "rescope") {
			if (entry.scope === operation.scope) continue;
			if (
				rescopeLearning(db, {
					id: entry.id,
					scope: operation.scope,
					repoKey: operation.scope === "repo" ? target.currentRepoKey : "",
					guardUpdatedAt: entry.updatedAt,
					nowSec: unixNow(),
				})
			) {
				counts.opsApplied += 1;
			} else {
				counts.opsSkippedStale += 1;
			}
			continue;
		}
		if (
			archiveLearning(db, {
				id: entry.id,
				guardUpdatedAt: entry.updatedAt,
				nowSec: unixNow(),
			})
		) {
			counts.opsApplied += 1;
		} else {
			counts.opsSkippedStale += 1;
		}
	}
	return counts;
}

function resolveSnapshotAlias(
	snapshot: ConsolidationSnapshotEntry[],
	alias: string,
): ConsolidationSnapshotEntry | undefined {
	const matches = snapshot.filter(entry => entry.alias === alias);
	return matches.length === 1 ? matches[0] : undefined;
}

function parseConsolidationOperations(output: string): ConsolidationOperation[] | undefined {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!isRecord(parsed) || !Array.isArray(parsed.ops)) return undefined;
		const operations: ConsolidationOperation[] = [];
		for (const rawOperation of parsed.ops) {
			const operation = parseConsolidationOperation(rawOperation);
			if (!operation) return undefined;
			operations.push(operation);
		}
		return operations;
	} catch {
		return undefined;
	}
}

function parseConsolidationOperation(rawOperation: unknown): ConsolidationOperation | undefined {
	if (!isRecord(rawOperation) || typeof rawOperation.op !== "string") return undefined;
	if (rawOperation.op === "merge") {
		if (
			!Array.isArray(rawOperation.ids) ||
			rawOperation.ids.length < 2 ||
			!rawOperation.ids.every(id => typeof id === "string" && id.trim().length > 0) ||
			typeof rawOperation.content !== "string" ||
			!rawOperation.content.trim()
		) {
			return undefined;
		}
		const ids = rawOperation.ids.map(id => id.trim());
		if (new Set(ids).size !== ids.length) return undefined;
		return { op: "merge", ids, content: rawOperation.content.trim() };
	}
	if (rawOperation.op === "rewrite") {
		if (
			typeof rawOperation.id !== "string" ||
			!rawOperation.id.trim() ||
			typeof rawOperation.content !== "string" ||
			!rawOperation.content.trim()
		) {
			return undefined;
		}
		return { op: "rewrite", id: rawOperation.id.trim(), content: rawOperation.content.trim() };
	}
	if (rawOperation.op === "rescope") {
		if (
			typeof rawOperation.id !== "string" ||
			!rawOperation.id.trim() ||
			(rawOperation.scope !== "global" && rawOperation.scope !== "repo")
		) {
			return undefined;
		}
		return { op: "rescope", id: rawOperation.id.trim(), scope: rawOperation.scope };
	}
	if (rawOperation.op === "archive") {
		if (
			typeof rawOperation.id !== "string" ||
			!rawOperation.id.trim() ||
			typeof rawOperation.reason !== "string" ||
			!rawOperation.reason.trim()
		) {
			return undefined;
		}
		return { op: "archive", id: rawOperation.id.trim(), reason: rawOperation.reason.trim() };
	}
	if (rawOperation.op === "keep") {
		if (typeof rawOperation.id !== "string" || !rawOperation.id.trim()) return undefined;
		return { op: "keep", id: rawOperation.id.trim() };
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function writeAuditFile(auditDir: string, fileName: string, payload: unknown): Promise<void> {
	try {
		await Bun.write(path.join(auditDir, fileName), `${JSON.stringify(payload, null, 2)}\n`);
	} catch (error) {
		logger.debug("live-learning: consolidation audit write failed", {
			auditDir,
			fileName,
			error: truncateError(String(error)),
		});
	}
}

function loadConsolidationConfig(settings: Settings): ConsolidationConfig {
	const intervalDays = settings.get("learning.consolidation.intervalDays") ?? DEFAULT_INTERVAL_DAYS;
	const maxEntriesPerScope = settings.get("learning.maxEntriesPerScope") ?? DEFAULT_MAX_ENTRIES_PER_SCOPE;
	const minEntries = settings.get("learning.consolidation.minEntries") ?? DEFAULT_MIN_ENTRIES;
	const timeoutMs = settings.get("learning.consolidation.timeoutMs") ?? DEFAULT_TIMEOUT_MS;
	const halfLifeDays = settings.get("learning.halfLifeDays") ?? DEFAULT_HALF_LIFE_DAYS;
	const staleRepoDays = settings.get("learning.staleRepoDays") ?? DEFAULT_STALE_REPO_DAYS;
	return {
		intervalDays: Number.isFinite(intervalDays) && intervalDays >= 0 ? intervalDays : DEFAULT_INTERVAL_DAYS,
		maxEntriesPerScope:
			Number.isFinite(maxEntriesPerScope) && maxEntriesPerScope > 0
				? Math.floor(maxEntriesPerScope)
				: DEFAULT_MAX_ENTRIES_PER_SCOPE,
		minEntries: Number.isFinite(minEntries) && minEntries >= 0 ? Math.floor(minEntries) : DEFAULT_MIN_ENTRIES,
		halfLifeDays: Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_HALF_LIFE_DAYS,
		staleRepoDays: Number.isFinite(staleRepoDays) && staleRepoDays > 0 ? staleRepoDays : DEFAULT_STALE_REPO_DAYS,
		models: settings.get("learning.consolidation.models") ?? [],
		timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
	};
}

function consolidatorFailureMessage(result: {
	stderr: string;
	error?: string;
	abortReason?: string;
	retryFailure?: { errorMessage?: string };
	output: string;
}): string {
	return truncateError(
		result.stderr ||
			result.error ||
			result.abortReason ||
			result.retryFailure?.errorMessage ||
			result.output ||
			"Unknown consolidator failure",
	);
}

function formatModelId(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function truncateError(value: string): string {
	return value.length > 500 ? `${value.slice(0, 499)}…` : value;
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}
