import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";

export type LearningScope = "global" | "repo";
export type LearningStatus = "active" | "merged" | "archived";

export interface LearningEntry {
	id: string;
	scope: LearningScope;
	cwd: string;
	content: string;
	contentHash: string;
	sourceMessageHash: string;
	trigger: string;
	confidence: number;
	createdAt: number;
	updatedAt: number;
	status: LearningStatus;
	statusChangedAt: number | null;
	strength: number;
	usefulCount: number;
	notUsefulCount: number;
	lastReinforcedAt: number | null;
	mergedInto: string | null;
	repoKey: string | null;
}

export interface RankedLearningEntry extends LearningEntry {
	alias: string;
	score: number;
}

export type LearningAuditClassifierStatus =
	| "not_run"
	| "model_unavailable"
	| "api_key_unavailable"
	| "request_failed"
	| "invalid_response"
	| "success";

export type LearningAuditWriterStatus = "not_run" | "store" | "skip" | "failed";

export interface LearningAuditInsert {
	id: string;
	createdAt: number;
	updatedAt: number;
	sessionId: string;
	cwd: string;
	sourceMessageHash: string;
	userMessagePreview: string;
	scope: LearningScope | "";
	trigger: string;
	confidence: number | null;
	reason: string;
	classifierStatus: LearningAuditClassifierStatus;
	classifierModel: string;
	classifierError: string;
	writerStatus: LearningAuditWriterStatus;
	writerModel: string;
	writerExitCode: number | null;
	stored: boolean;
	outcome: string;
	auditDir: string;
	auditJsonPath: string;
	classifierRequestPath: string;
	classifierResponsePath: string;
	writerRequestPath: string;
	writerResultPath: string;
	writerSessionPath: string;
	writerOutputPath: string;
}

export interface LearningInsert {
	scope: LearningScope;
	cwd: string;
	repoKey?: string;
	content: string;
	sourceMessageHash: string;
	trigger: string;
	confidence: number;
	nowSec: number;
}

export interface ConsolidationClaim {
	jobKey: string;
	ownershipToken: string;
	inputWatermark: number;
}

interface LearningRow {
	id: string;
	scope: string;
	cwd: string;
	content: string;
	content_hash: string;
	source_message_hash: string;
	trigger: string;
	confidence: number;
	created_at: number;
	updated_at: number;
	status: string;
	status_changed_at: number | null;
	strength: number;
	useful_count: number;
	not_useful_count: number;
	last_reinforced_at: number | null;
	merged_into: string | null;
	repo_key: string | null;
}

type ValidLearningRow = LearningRow & { scope: LearningScope; status: LearningStatus };

interface JobRow {
	status: string;
	lease_until: number | null;
	retry_at: number | null;
	retry_remaining: number;
	last_success_watermark: number | null;
}

const CONSOLIDATION_JOB_KIND = "consolidation";

export function openLearningDb(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec("PRAGMA busy_timeout=5000");
	db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS live_learnings (
	id TEXT PRIMARY KEY,
	scope TEXT NOT NULL,
	cwd TEXT NOT NULL,
	content TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	source_message_hash TEXT NOT NULL,
	trigger TEXT NOT NULL,
	confidence REAL NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE(scope, cwd, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_live_learnings_scope_cwd_updated
ON live_learnings(scope, cwd, updated_at DESC);

CREATE TABLE IF NOT EXISTS live_learning_audit_events (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	source_message_hash TEXT NOT NULL,
	user_message_preview TEXT NOT NULL,
	scope TEXT NOT NULL,
	trigger TEXT NOT NULL,
	confidence REAL,
	reason TEXT NOT NULL,
	classifier_status TEXT NOT NULL,
	classifier_model TEXT NOT NULL,
	classifier_error TEXT NOT NULL,
	writer_status TEXT NOT NULL,
	writer_model TEXT NOT NULL,
	writer_exit_code INTEGER,
	stored INTEGER NOT NULL,
	outcome TEXT NOT NULL,
	audit_dir TEXT NOT NULL,
	audit_json_path TEXT NOT NULL,
	classifier_request_path TEXT NOT NULL,
	classifier_response_path TEXT NOT NULL,
	writer_request_path TEXT NOT NULL,
	writer_result_path TEXT NOT NULL,
	writer_session_path TEXT NOT NULL,
	writer_output_path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_learning_audit_events_created
ON live_learning_audit_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_learning_audit_events_session
ON live_learning_audit_events(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS live_learning_feedback (
	id TEXT PRIMARY KEY,
	learning_id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	verdict TEXT NOT NULL,
	reason TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_learning_feedback_learning
ON live_learning_feedback(learning_id, created_at DESC);

CREATE TABLE IF NOT EXISTS live_learning_jobs (
	kind TEXT NOT NULL,
	job_key TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'idle',
	worker_id TEXT,
	ownership_token TEXT,
	started_at INTEGER,
	finished_at INTEGER,
	lease_until INTEGER,
	retry_at INTEGER,
	retry_remaining INTEGER NOT NULL DEFAULT 3,
	input_watermark INTEGER,
	last_success_watermark INTEGER,
	last_error TEXT,
	PRIMARY KEY (kind, job_key)
);
`);
	migrateLearningColumns(db);
	db.prepare("UPDATE live_learnings SET last_reinforced_at = updated_at WHERE last_reinforced_at IS NULL").run();
	return db;
}

export function closeLearningDb(db: Database): void {
	db.close();
}

export function learningContentHash(scope: LearningScope, cwd: string, content: string): string {
	return Bun.hash(`${scope}\u0000${cwd}\u0000${normalizeLearningContent(content)}`).toString(16);
}

export function learningMessageHash(content: string): string {
	return Bun.hash(normalizeLearningContent(content)).toString(16);
}

export function normalizeLearningContent(content: string): string {
	return content.trim().replace(/\s+/g, " ").toLowerCase();
}

export function upsertLearning(db: Database, input: LearningInsert): boolean {
	const key = resolveScopeKey(input.scope, input.cwd, input.repoKey);
	const contentHash = learningContentHash(input.scope, key.cwd, input.content);
	const id = `learning-${input.nowSec}-${contentHash}`;
	return withImmediateTransaction(db, () => {
		const inserted = db
			.prepare(`
INSERT INTO live_learnings (
	id, scope, cwd, content, content_hash, source_message_hash, trigger, confidence, created_at, updated_at,
	status, strength, useful_count, not_useful_count, last_reinforced_at, repo_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 0, 0, ?, ?)
ON CONFLICT(scope, cwd, content_hash) DO NOTHING
`)
			.run(
				id,
				input.scope,
				key.cwd,
				input.content,
				contentHash,
				input.sourceMessageHash,
				input.trigger,
				input.confidence,
				input.nowSec,
				input.nowSec,
				input.nowSec,
				key.repoKey,
			);
		if (hasChanges(inserted)) return true;
		const conflict = selectByUniqueKey(db, input.scope, key.cwd, contentHash);
		if (!conflict) return false;
		const winner = resolveActiveConflictWinner(db, conflict, input.nowSec, {
			confidence: input.confidence,
			refresh: {
				sourceMessageHash: input.sourceMessageHash,
				trigger: input.trigger,
			},
		});
		if (!winner) return false;
		return reinforceActiveRow(
			db,
			winner.id,
			input.confidence,
			input.nowSec,
			winner.id === conflict.id ? { sourceMessageHash: input.sourceMessageHash, trigger: input.trigger } : undefined,
		);
	});
}

export function listActiveLearnings(
	db: Database,
	opts: { repoKey: string; limitPerScope: number; halfLifeDays: number; nowSec: number },
): RankedLearningEntry[] {
	const limit = Math.max(1, Math.floor(opts.limitPerScope));
	const halfLifeDays = opts.halfLifeDays > 0 ? opts.halfLifeDays : 45;
	const rows = db
		.prepare(`
SELECT * FROM live_learnings
WHERE status = 'active'
	AND (
		(scope = 'global' AND cwd = '')
		OR (scope = 'repo' AND COALESCE(repo_key, cwd) = ?)
	)
`)
		.all(opts.repoKey) as LearningRow[];
	const ranked = rows
		.filter(isLearningRow)
		.map(row => {
			const entry = toLearningEntry(row);
			const lastActivity = entry.lastReinforcedAt ?? entry.updatedAt;
			const ageDays = Math.max(0, (opts.nowSec - lastActivity) / 86_400);
			const score =
				(entry.strength + 1.5 * entry.usefulCount - 2 * entry.notUsefulCount) * Math.exp(-ageDays / halfLifeDays);
			return { ...entry, alias: entry.contentHash.slice(0, 12), score };
		})
		.filter(entry => entry.notUsefulCount - entry.usefulCount < 3);
	const selected: RankedLearningEntry[] = [];
	for (const scope of ["global", "repo"] as const) {
		selected.push(
			...ranked
				.filter(entry => entry.scope === scope)
				.sort(compareRankedEntries)
				.slice(0, limit),
		);
	}
	return selected;
}

export function healCurrentCwdRows(db: Database, opts: { cwd: string; repoKey: string; nowSec: number }): number {
	const rows = db
		.prepare(`
SELECT * FROM live_learnings
WHERE scope = 'repo' AND repo_key IS NULL AND cwd = ?
ORDER BY id ASC
`)
		.all(opts.cwd) as LearningRow[];
	let healed = 0;
	for (const row of rows) {
		if (isLearningRow(row) && healLegacyRow(db, row.id, row.updated_at, opts.repoKey, opts.nowSec)) healed += 1;
	}
	return healed;
}

export async function healSiblingLegacyCwds(
	db: Database,
	opts: { repoKey: string; resolveKey: (cwd: string) => Promise<string>; probeLimit: number; nowSec: number },
): Promise<number> {
	const probeLimit = Math.max(0, Math.min(16, Math.floor(opts.probeLimit)));
	if (probeLimit === 0) return 0;
	const cwdRows = db
		.prepare(`
SELECT DISTINCT cwd
FROM live_learnings
WHERE scope = 'repo' AND repo_key IS NULL AND cwd <> ?
ORDER BY cwd ASC
`)
		.all(opts.repoKey) as Array<{ cwd: string }>;
	let healed = 0;
	let probes = 0;
	for (const { cwd } of cwdRows) {
		if (probes >= probeLimit) break;
		if (!(await directoryExists(cwd))) continue;
		probes += 1;
		if ((await opts.resolveKey(cwd)) !== opts.repoKey) continue;
		const rows = db
			.prepare(`
SELECT * FROM live_learnings
WHERE scope = 'repo' AND repo_key IS NULL AND cwd = ?
ORDER BY id ASC
`)
			.all(cwd) as LearningRow[];
		for (const row of rows) {
			if (isLearningRow(row) && healLegacyRow(db, row.id, row.updated_at, opts.repoKey, opts.nowSec)) healed += 1;
		}
	}
	return healed;
}

export function sweepTombstoneTouches(db: Database, opts: { repoKey: string; nowSec: number }): number {
	const rows = db
		.prepare(`
SELECT * FROM live_learnings
WHERE status <> 'active'
	AND (
		status_changed_at IS NULL
		OR updated_at > status_changed_at
	)
	AND (
		(scope = 'global' AND cwd = '')
		OR (scope = 'repo' AND COALESCE(repo_key, cwd) = ?)
	)
ORDER BY id ASC
`)
		.all(opts.repoKey) as LearningRow[];
	let processed = 0;
	for (const row of rows) {
		if (!isLearningRow(row)) continue;
		const handled = withImmediateTransaction(db, () => {
			const current = selectById(db, row.id);
			if (!current || current.status === "active") return false;
			if (current.status_changed_at === null) {
				return hasChanges(
					db
						.prepare("UPDATE live_learnings SET status_changed_at = updated_at WHERE id = ? AND updated_at = ?")
						.run(current.id, current.updated_at),
				);
			}
			if (current.updated_at <= current.status_changed_at) return false;
			const survivor = current.status === "merged" ? resolveActiveSurvivor(db, current.id) : null;
			if (survivor) {
				reinforceActiveRow(db, survivor.id, survivor.confidence, opts.nowSec);
				return hasChanges(
					db
						.prepare("UPDATE live_learnings SET status_changed_at = updated_at WHERE id = ? AND updated_at = ?")
						.run(current.id, current.updated_at),
				);
			}
			return reactivateRow(db, current.id, current.confidence, opts.nowSec);
		});
		if (handled) processed += 1;
	}
	return processed;
}

export function findActiveByAliasPrefix(db: Database, opts: { aliasPrefix: string; repoKey: string }): LearningEntry[] {
	const prefix = opts.aliasPrefix.toLowerCase();
	if (!/^[a-f0-9]{6,16}$/.test(prefix)) return [];
	const rows = db
		.prepare(`
SELECT * FROM live_learnings
WHERE status = 'active'
	AND (
		(scope = 'global' AND cwd = '')
		OR (scope = 'repo' AND COALESCE(repo_key, cwd) = ?)
	)
ORDER BY id ASC
`)
		.all(opts.repoKey) as LearningRow[];
	return rows
		.filter(isLearningRow)
		.filter(row => row.content_hash.toLowerCase().startsWith(prefix))
		.map(toLearningEntry);
}

export function recordLearningFeedback(
	db: Database,
	opts: {
		learningId: string;
		sessionId: string;
		verdict: "useful" | "not_useful";
		reason?: string;
		nowSec: number;
	},
): boolean {
	return withImmediateTransaction(db, () => {
		const updated =
			opts.verdict === "useful"
				? db
						.prepare(`
UPDATE live_learnings
SET useful_count = useful_count + 1,
	strength = MIN(10, strength + 0.5),
	last_reinforced_at = ?,
	updated_at = ?
WHERE id = ? AND status = 'active'
`)
						.run(opts.nowSec, opts.nowSec, opts.learningId)
				: db
						.prepare(`
UPDATE live_learnings
SET not_useful_count = not_useful_count + 1,
	strength = MAX(0, strength - 1),
	updated_at = ?
WHERE id = ? AND status = 'active'
`)
						.run(opts.nowSec, opts.learningId);
		if (!hasChanges(updated)) return false;
		db.prepare(`
INSERT INTO live_learning_feedback (id, learning_id, session_id, verdict, reason, created_at)
VALUES (?, ?, ?, ?, ?, ?)
`).run(
			`learning-feedback-${crypto.randomUUID()}`,
			opts.learningId,
			opts.sessionId,
			opts.verdict,
			opts.reason ?? null,
			opts.nowSec,
		);
		return true;
	});
}

export function reinforceLearning(db: Database, opts: { id: string; confidence: number; nowSec: number }): boolean {
	return reinforceActiveRow(db, opts.id, opts.confidence, opts.nowSec);
}

export function archiveLearning(
	db: Database,
	opts: { id: string; guardUpdatedAt: number | null; nowSec: number },
): boolean {
	const statement =
		opts.guardUpdatedAt === null
			? db.prepare(`
UPDATE live_learnings
SET status = 'archived', status_changed_at = ?, merged_into = NULL, updated_at = ?
WHERE id = ? AND status = 'active'
`)
			: db.prepare(`
UPDATE live_learnings
SET status = 'archived', status_changed_at = ?, merged_into = NULL, updated_at = ?
WHERE id = ? AND status = 'active' AND updated_at = ?
`);
	const result =
		opts.guardUpdatedAt === null
			? statement.run(opts.nowSec, opts.nowSec, opts.id)
			: statement.run(opts.nowSec, opts.nowSec, opts.id, opts.guardUpdatedAt);
	return hasChanges(result);
}

export function rescopeLearning(
	db: Database,
	opts: { id: string; scope: LearningScope; repoKey: string; guardUpdatedAt: number; nowSec: number },
): boolean {
	return moveLearning(db, {
		id: opts.id,
		guardUpdatedAt: opts.guardUpdatedAt,
		nowSec: opts.nowSec,
		scope: opts.scope,
		repoKey: opts.repoKey,
	});
}

export function rewriteLearning(
	db: Database,
	opts: { id: string; content: string; guardUpdatedAt: number; nowSec: number },
): boolean {
	return moveLearning(db, {
		id: opts.id,
		guardUpdatedAt: opts.guardUpdatedAt,
		nowSec: opts.nowSec,
		content: opts.content,
	});
}

interface ConsolidatedEntryOptions {
	scope: LearningScope;
	repoKey: string;
	content: string;
	strength: number;
	usefulCount: number;
	notUsefulCount: number;
	confidence: number;
	createdAt: number;
	lastReinforcedAt: number | null;
	nowSec: number;
}

export function insertConsolidatedEntry(db: Database, opts: ConsolidatedEntryOptions): { id: string } {
	return withImmediateTransaction(db, () => insertConsolidatedEntryInTransaction(db, opts));
}

export function mergeConsolidatedEntries(
	db: Database,
	opts: ConsolidatedEntryOptions & { sources: Array<{ id: string; guardUpdatedAt: number }> },
): boolean {
	return withImmediateTransaction(db, () => {
		for (const source of opts.sources) {
			const current = db
				.prepare("SELECT 1 FROM live_learnings WHERE id = ? AND status = 'active' AND updated_at = ?")
				.get(source.id, source.guardUpdatedAt);
			if (current === null || current === undefined) return false;
		}

		const survivor = insertConsolidatedEntryInTransaction(db, opts, new Set(opts.sources.map(source => source.id)));
		for (const source of opts.sources) {
			if (source.id === survivor.id) continue;
			if (
				!markMergedInto(db, {
					id: source.id,
					into: survivor.id,
					guardUpdatedAt: source.guardUpdatedAt,
					nowSec: opts.nowSec,
				})
			) {
				throw new Error("Consolidation source changed after guard validation");
			}
		}
		return true;
	});
}

function insertConsolidatedEntryInTransaction(
	db: Database,
	opts: ConsolidatedEntryOptions,
	sourceIds?: ReadonlySet<string>,
): { id: string } {
	const key = resolveScopeKey(opts.scope, opts.repoKey, opts.repoKey);
	const contentHash = learningContentHash(opts.scope, key.cwd, opts.content);
	const insertedId = `learning-consolidated-${opts.nowSec}-${contentHash}`;
	const inserted = db
		.prepare(`
INSERT INTO live_learnings (
	id, scope, cwd, content, content_hash, source_message_hash, trigger, confidence, created_at, updated_at,
	status, strength, useful_count, not_useful_count, last_reinforced_at, repo_key
) VALUES (?, ?, ?, ?, ?, ?, 'consolidation', ?, ?, ?, 'active', ?, ?, ?, ?, ?)
ON CONFLICT(scope, cwd, content_hash) DO NOTHING
`)
		.run(
			insertedId,
			opts.scope,
			key.cwd,
			opts.content,
			contentHash,
			learningMessageHash(opts.content),
			opts.confidence,
			opts.createdAt,
			opts.nowSec,
			clamp(opts.strength, 0, 10),
			clamp(Math.floor(opts.usefulCount), 0, 999),
			clamp(Math.floor(opts.notUsefulCount), 0, 999),
			opts.lastReinforcedAt ?? opts.nowSec,
			key.repoKey,
		);
	if (hasChanges(inserted)) return { id: insertedId };
	const conflict = selectByUniqueKey(db, opts.scope, key.cwd, contentHash);
	if (!conflict) return { id: insertedId };
	const winner = resolveActiveConflictWinner(db, conflict, opts.nowSec, { confidence: opts.confidence });
	if (!winner) return { id: insertedId };
	const existingLastReinforcedAt =
		winner.id === conflict.id && conflict.status !== "active"
			? conflict.last_reinforced_at
			: winner.last_reinforced_at;
	if (sourceIds?.has(winner.id)) {
		replaceConsolidatedStats(db, winner.id, opts, existingLastReinforcedAt);
	} else {
		accumulateConsolidatedStats(db, winner.id, opts, existingLastReinforcedAt);
	}
	return { id: winner.id };
}

export function markMergedInto(
	db: Database,
	opts: { id: string; into: string; guardUpdatedAt: number; nowSec: number },
): boolean {
	return hasChanges(
		db
			.prepare(`
UPDATE live_learnings
SET status = 'merged', status_changed_at = ?, merged_into = ?, updated_at = ?
WHERE id = ? AND status = 'active' AND updated_at = ?
`)
			.run(opts.nowSec, opts.into, opts.nowSec, opts.id, opts.guardUpdatedAt),
	);
}

export function resolveActiveSurvivor(db: Database, id: string, maxHops = 5): LearningEntry | null {
	const visited = new Set<string>();
	let currentId = id;
	for (let hops = 0; hops <= maxHops; hops += 1) {
		if (visited.has(currentId)) return null;
		visited.add(currentId);
		const current = selectById(db, currentId);
		if (!current) return null;
		if (current.status === "active") return toLearningEntry(current);
		if (current.status !== "merged" || !current.merged_into) return null;
		currentId = current.merged_into;
	}
	return null;
}

export function computeLearningWatermark(
	db: Database,
	target: { scope: LearningScope; repoKey: string; nowSec: number },
): number {
	const row =
		target.scope === "global"
			? (db
					.prepare("SELECT MAX(updated_at) AS watermark FROM live_learnings WHERE scope = 'global' AND cwd = ''")
					.get() as { watermark: number | null } | null)
			: (db
					.prepare(
						"SELECT MAX(updated_at) AS watermark FROM live_learnings WHERE scope = 'repo' AND COALESCE(repo_key, cwd) = ?",
					)
					.get(target.repoKey) as { watermark: number | null } | null);
	if (!row?.watermark) return 0;
	return Math.min(row.watermark, target.nowSec - 1);
}

export function tryClaimConsolidationJob(
	db: Database,
	opts: {
		jobKey: string;
		workerId: string;
		leaseSeconds: number;
		nowSec: number;
		inputWatermark: number;
		retryLimit: number;
		force?: boolean;
	},
):
	| { kind: "claimed"; claim: ConsolidationClaim }
	| { kind: "skipped_not_dirty" }
	| { kind: "skipped_running" }
	| { kind: "skipped_retry_backoff" } {
	const retryLimit = Math.max(0, Math.floor(opts.retryLimit));
	return withImmediateTransaction(db, () => {
		db.prepare(`
INSERT OR IGNORE INTO live_learning_jobs (kind, job_key, status, retry_remaining)
VALUES (?, ?, 'idle', ?)
`).run(CONSOLIDATION_JOB_KIND, opts.jobKey, retryLimit);
		db.prepare(`
UPDATE live_learning_jobs
SET retry_remaining = ?, retry_at = NULL
WHERE kind = ? AND job_key = ? AND status <> 'running' AND retry_remaining = 0
	AND ? > COALESCE(input_watermark, -1)
`).run(retryLimit, CONSOLIDATION_JOB_KIND, opts.jobKey, opts.inputWatermark);
		const ownershipToken = crypto.randomUUID();
		const claimed = db
			.prepare(`
UPDATE live_learning_jobs
SET status = 'running', worker_id = ?, ownership_token = ?, started_at = ?, finished_at = NULL,
	lease_until = ?, retry_at = NULL, last_error = NULL, input_watermark = ?,
	retry_remaining = CASE WHEN input_watermark IS NULL OR input_watermark < ? THEN ? ELSE retry_remaining END
WHERE kind = ? AND job_key = ?
	AND NOT (status = 'running' AND lease_until IS NOT NULL AND lease_until > ?)
	AND (? = 1 OR ? > COALESCE(last_success_watermark, -1))
	AND retry_remaining > 0
	AND (retry_at IS NULL OR retry_at <= ?)
`)
			.run(
				opts.workerId,
				ownershipToken,
				opts.nowSec,
				opts.nowSec + opts.leaseSeconds,
				opts.inputWatermark,
				opts.inputWatermark,
				retryLimit,
				CONSOLIDATION_JOB_KIND,
				opts.jobKey,
				opts.nowSec,
				opts.force ? 1 : 0,
				opts.inputWatermark,
				opts.nowSec,
			);
		if (hasChanges(claimed)) {
			return {
				kind: "claimed",
				claim: { jobKey: opts.jobKey, ownershipToken, inputWatermark: opts.inputWatermark },
			};
		}
		const job = selectJob(db, opts.jobKey);
		if (job?.status === "running" && job.lease_until !== null && job.lease_until > opts.nowSec) {
			return { kind: "skipped_running" };
		}
		if (job && (job.retry_remaining <= 0 || (job.retry_at !== null && job.retry_at > opts.nowSec))) {
			return { kind: "skipped_retry_backoff" };
		}
		return { kind: "skipped_not_dirty" };
	});
}

export function isConsolidationClaimHeld(db: Database, opts: { claim: ConsolidationClaim; nowSec: number }): boolean {
	const row = db
		.prepare(`
SELECT 1
FROM live_learning_jobs
WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ? AND lease_until > ?
`)
		.get(CONSOLIDATION_JOB_KIND, opts.claim.jobKey, opts.claim.ownershipToken, opts.nowSec);
	return row !== null && row !== undefined;
}

export function markConsolidationSucceeded(db: Database, opts: { claim: ConsolidationClaim; nowSec: number }): boolean {
	return hasChanges(
		db
			.prepare(`
UPDATE live_learning_jobs
SET status = 'idle', finished_at = ?, lease_until = NULL, retry_at = NULL, last_error = NULL,
	last_success_watermark = ?
WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?
`)
			.run(
				opts.nowSec,
				opts.claim.inputWatermark,
				CONSOLIDATION_JOB_KIND,
				opts.claim.jobKey,
				opts.claim.ownershipToken,
			),
	);
}

export function markConsolidationFailed(
	db: Database,
	opts: { claim: ConsolidationClaim; error: string; retryDelaySeconds: number; nowSec: number },
): boolean {
	return hasChanges(
		db
			.prepare(`
UPDATE live_learning_jobs
SET status = 'error', finished_at = ?, lease_until = NULL, retry_at = ?,
	retry_remaining = CASE WHEN retry_remaining > 0 THEN retry_remaining - 1 ELSE 0 END,
	last_error = ?
WHERE kind = ? AND job_key = ? AND status = 'running' AND ownership_token = ?
`)
			.run(
				opts.nowSec,
				opts.nowSec + opts.retryDelaySeconds,
				opts.error,
				CONSOLIDATION_JOB_KIND,
				opts.claim.jobKey,
				opts.claim.ownershipToken,
			),
	);
}

export function insertLearningAudit(db: Database, input: LearningAuditInsert): void {
	db.prepare(`
INSERT OR REPLACE INTO live_learning_audit_events (
	id,
	created_at,
	updated_at,
	session_id,
	cwd,
	source_message_hash,
	user_message_preview,
	scope,
	trigger,
	confidence,
	reason,
	classifier_status,
	classifier_model,
	classifier_error,
	writer_status,
	writer_model,
	writer_exit_code,
	stored,
	outcome,
	audit_dir,
	audit_json_path,
	classifier_request_path,
	classifier_response_path,
	writer_request_path,
	writer_result_path,
	writer_session_path,
	writer_output_path
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
		input.id,
		input.createdAt,
		input.updatedAt,
		input.sessionId,
		input.cwd,
		input.sourceMessageHash,
		input.userMessagePreview,
		input.scope,
		input.trigger,
		input.confidence,
		input.reason,
		input.classifierStatus,
		input.classifierModel,
		input.classifierError,
		input.writerStatus,
		input.writerModel,
		input.writerExitCode,
		input.stored ? 1 : 0,
		input.outcome,
		input.auditDir,
		input.auditJsonPath,
		input.classifierRequestPath,
		input.classifierResponsePath,
		input.writerRequestPath,
		input.writerResultPath,
		input.writerSessionPath,
		input.writerOutputPath,
	);
}

export function listLearningEntries(db: Database, cwd: string, limitPerScope: number): LearningEntry[] {
	const limit = Math.max(1, Math.floor(limitPerScope));
	const globalRows = selectLegacyLearningRows(db, "global", "", limit);
	const repoRows = selectLegacyLearningRows(db, "repo", cwd, limit);
	return [...globalRows, ...repoRows];
}

export function clearLearningData(db: Database, cwd: string, scope: LearningScope | "all" = "all"): void {
	if (scope === "global") {
		db.prepare("DELETE FROM live_learnings WHERE scope = 'global' AND cwd = ''").run();
		return;
	}
	if (scope === "repo") {
		db.prepare("DELETE FROM live_learnings WHERE scope = 'repo' AND cwd = ?").run(cwd);
		return;
	}
	db.prepare("DELETE FROM live_learnings WHERE (scope = 'global' AND cwd = '') OR (scope = 'repo' AND cwd = ?)").run(
		cwd,
	);
}

function migrateLearningColumns(db: Database): void {
	const columns = db.prepare("PRAGMA table_info(live_learnings)").all() as Array<{ name: string }>;
	const names = new Set(columns.map(column => column.name));
	const migrations: Array<{ name: string; sql: string }> = [
		{ name: "status", sql: "ALTER TABLE live_learnings ADD COLUMN status TEXT NOT NULL DEFAULT 'active'" },
		{ name: "status_changed_at", sql: "ALTER TABLE live_learnings ADD COLUMN status_changed_at INTEGER" },
		{ name: "strength", sql: "ALTER TABLE live_learnings ADD COLUMN strength REAL NOT NULL DEFAULT 1" },
		{ name: "useful_count", sql: "ALTER TABLE live_learnings ADD COLUMN useful_count INTEGER NOT NULL DEFAULT 0" },
		{
			name: "not_useful_count",
			sql: "ALTER TABLE live_learnings ADD COLUMN not_useful_count INTEGER NOT NULL DEFAULT 0",
		},
		{ name: "last_reinforced_at", sql: "ALTER TABLE live_learnings ADD COLUMN last_reinforced_at INTEGER" },
		{ name: "merged_into", sql: "ALTER TABLE live_learnings ADD COLUMN merged_into TEXT" },
		{ name: "repo_key", sql: "ALTER TABLE live_learnings ADD COLUMN repo_key TEXT" },
	];
	for (const migration of migrations) {
		if (names.has(migration.name)) continue;
		try {
			db.exec(migration.sql);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/duplicate column name/i.test(message)) throw error;
		}
	}
}

function resolveScopeKey(
	scope: LearningScope,
	cwd: string,
	repoKey: string | undefined,
): { cwd: string; repoKey: string | null } {
	if (scope === "global") return { cwd: "", repoKey: "" };
	if (repoKey !== undefined) return { cwd: repoKey, repoKey };
	return { cwd, repoKey: null };
}

function selectById(db: Database, id: string): ValidLearningRow | null {
	const row = db.prepare("SELECT * FROM live_learnings WHERE id = ?").get(id) as LearningRow | null;
	return row && isLearningRow(row) ? row : null;
}

function selectByUniqueKey(
	db: Database,
	scope: LearningScope,
	cwd: string,
	contentHash: string,
): ValidLearningRow | null {
	const row = db
		.prepare("SELECT * FROM live_learnings WHERE scope = ? AND cwd = ? AND content_hash = ?")
		.get(scope, cwd, contentHash) as LearningRow | null;
	return row && isLearningRow(row) ? row : null;
}

function selectJob(db: Database, jobKey: string): JobRow | null {
	return db
		.prepare(`
SELECT status, lease_until, retry_at, retry_remaining, last_success_watermark
FROM live_learning_jobs WHERE kind = ? AND job_key = ?
`)
		.get(CONSOLIDATION_JOB_KIND, jobKey) as JobRow | null;
}

function selectLegacyLearningRows(db: Database, scope: LearningScope, cwd: string, limit: number): LearningEntry[] {
	const rows = db
		.prepare(`
SELECT * FROM live_learnings
WHERE scope = ? AND cwd = ?
ORDER BY updated_at DESC, created_at DESC
LIMIT ?
`)
		.all(scope, cwd, limit) as LearningRow[];
	return rows.filter(isLearningRow).map(toLearningEntry);
}

function accumulateConsolidatedStats(
	db: Database,
	id: string,
	opts: ConsolidatedEntryOptions,
	existingLastReinforcedAt: number | null,
): boolean {
	return hasChanges(
		db
			.prepare(`
UPDATE live_learnings
SET strength = MIN(10, strength + ?),
	useful_count = MIN(999, useful_count + ?),
	not_useful_count = MIN(999, not_useful_count + ?),
	confidence = MAX(confidence, ?),
	last_reinforced_at = ?,
	updated_at = ?
WHERE id = ? AND status = 'active'
`)
			.run(
				clamp(opts.strength, 0, 10),
				clamp(Math.floor(opts.usefulCount), 0, 999),
				clamp(Math.floor(opts.notUsefulCount), 0, 999),
				opts.confidence,
				maxNullable(existingLastReinforcedAt, opts.lastReinforcedAt),
				opts.nowSec,
				id,
			),
	);
}

function replaceConsolidatedStats(
	db: Database,
	id: string,
	opts: ConsolidatedEntryOptions,
	existingLastReinforcedAt: number | null,
): boolean {
	return hasChanges(
		db
			.prepare(`
UPDATE live_learnings
SET strength = ?,
	useful_count = ?,
	not_useful_count = ?,
	confidence = MAX(confidence, ?),
	last_reinforced_at = ?,
	updated_at = ?
WHERE id = ? AND status = 'active'
`)
			.run(
				clamp(opts.strength, 0, 10),
				clamp(Math.floor(opts.usefulCount), 0, 999),
				clamp(Math.floor(opts.notUsefulCount), 0, 999),
				opts.confidence,
				maxNullable(existingLastReinforcedAt, opts.lastReinforcedAt),
				opts.nowSec,
				id,
			),
	);
}

function reinforceActiveRow(
	db: Database,
	id: string,
	confidence: number,
	nowSec: number,
	refresh?: { sourceMessageHash: string; trigger: string },
): boolean {
	const result = refresh
		? db
				.prepare(`
UPDATE live_learnings
SET strength = MIN(10, strength + 1), confidence = MAX(confidence, ?),
	last_reinforced_at = ?, updated_at = ?, source_message_hash = ?, trigger = ?
WHERE id = ? AND status = 'active'
`)
				.run(confidence, nowSec, nowSec, refresh.sourceMessageHash, refresh.trigger, id)
		: db
				.prepare(`
UPDATE live_learnings
SET strength = MIN(10, strength + 1), confidence = MAX(confidence, ?),
	last_reinforced_at = ?, updated_at = ?
WHERE id = ? AND status = 'active'
`)
				.run(confidence, nowSec, nowSec, id);
	return hasChanges(result);
}

function reactivateRow(
	db: Database,
	id: string,
	confidence: number,
	nowSec: number,
	refresh?: { sourceMessageHash: string; trigger: string },
): boolean {
	const result = refresh
		? db
				.prepare(`
UPDATE live_learnings
SET status = 'active', status_changed_at = ?, merged_into = NULL, strength = MAX(1, strength),
	confidence = MAX(confidence, ?), last_reinforced_at = ?, updated_at = ?,
	source_message_hash = ?, trigger = ?
WHERE id = ? AND status <> 'active'
`)
				.run(nowSec, confidence, nowSec, nowSec, refresh.sourceMessageHash, refresh.trigger, id)
		: db
				.prepare(`
UPDATE live_learnings
SET status = 'active', status_changed_at = ?, merged_into = NULL, strength = MAX(1, strength),
	confidence = MAX(confidence, ?), last_reinforced_at = ?, updated_at = ?
WHERE id = ? AND status <> 'active'
`)
				.run(nowSec, confidence, nowSec, nowSec, id);
	return hasChanges(result);
}

function resolveActiveConflictWinner(
	db: Database,
	conflict: ValidLearningRow,
	nowSec: number,
	reactivation: { confidence: number; refresh?: { sourceMessageHash: string; trigger: string } },
): ValidLearningRow | null {
	if (conflict.status === "active") return conflict;
	if (conflict.status === "merged") {
		const survivor = resolveActiveSurvivor(db, conflict.id);
		if (survivor) {
			const activeSurvivor = selectById(db, survivor.id);
			if (activeSurvivor?.status === "active") return activeSurvivor;
		}
	}
	if (!reactivateRow(db, conflict.id, reactivation.confidence, nowSec, reactivation.refresh)) return null;
	const reactivated = selectById(db, conflict.id);
	return reactivated?.status === "active" ? reactivated : null;
}

function healLegacyRow(db: Database, id: string, guardUpdatedAt: number, repoKey: string, nowSec: number): boolean {
	return withImmediateTransaction(db, () => {
		const row = db
			.prepare(`
SELECT * FROM live_learnings
WHERE id = ? AND updated_at = ? AND scope = 'repo' AND repo_key IS NULL
`)
			.get(id, guardUpdatedAt) as LearningRow | null;
		if (!row || !isLearningRow(row)) return false;
		const contentHash = learningContentHash("repo", repoKey, row.content);
		const winner = selectByUniqueKey(db, "repo", repoKey, contentHash);
		if (winner && winner.id !== row.id) return mergeIntoWinner(db, row, winner, nowSec);
		return hasChanges(
			db
				.prepare(`
UPDATE live_learnings
SET cwd = ?, repo_key = ?, content_hash = ?, updated_at = ?
WHERE id = ? AND updated_at = ? AND repo_key IS NULL
`)
				.run(repoKey, repoKey, contentHash, nowSec, row.id, row.updated_at),
		);
	});
}

function moveLearning(
	db: Database,
	opts: {
		id: string;
		guardUpdatedAt: number;
		nowSec: number;
		scope?: LearningScope;
		repoKey?: string;
		content?: string;
	},
): boolean {
	return withImmediateTransaction(db, () => {
		const row = db
			.prepare("SELECT * FROM live_learnings WHERE id = ? AND updated_at = ? AND status = 'active'")
			.get(opts.id, opts.guardUpdatedAt) as LearningRow | null;
		if (!row || !isLearningRow(row)) return false;
		const scope = opts.scope ?? row.scope;
		const content = opts.content ?? row.content;
		const repoKey = scope === "global" ? "" : (opts.repoKey ?? row.repo_key ?? row.cwd);
		const key = resolveScopeKey(scope, repoKey, repoKey);
		const contentHash = learningContentHash(scope, key.cwd, content);
		const winner = selectByUniqueKey(db, scope, key.cwd, contentHash);
		if (winner && winner.id !== row.id) return mergeIntoWinner(db, row, winner, opts.nowSec);
		return hasChanges(
			db
				.prepare(`
UPDATE live_learnings
SET scope = ?, cwd = ?, repo_key = ?, content = ?, content_hash = ?, updated_at = ?
WHERE id = ? AND updated_at = ? AND status = 'active'
`)
				.run(scope, key.cwd, key.repoKey, content, contentHash, opts.nowSec, row.id, row.updated_at),
		);
	});
}

function mergeIntoWinner(db: Database, loser: LearningRow, conflict: ValidLearningRow, nowSec: number): boolean {
	const winner = resolveActiveConflictWinner(db, conflict, nowSec, { confidence: conflict.confidence });
	if (!winner || winner.id === loser.id) return false;
	const lastReinforcedAt = maxNullable(winner.last_reinforced_at, loser.last_reinforced_at);
	const accumulated = db
		.prepare(`
UPDATE live_learnings
SET strength = MIN(10, strength + ?),
	useful_count = MIN(999, useful_count + ?),
	not_useful_count = MIN(999, not_useful_count + ?),
	confidence = MAX(confidence, ?),
	last_reinforced_at = ?,
	updated_at = ?
WHERE id = ? AND status = 'active'
`)
		.run(
			loser.strength,
			loser.useful_count,
			loser.not_useful_count,
			loser.confidence,
			lastReinforcedAt,
			nowSec,
			winner.id,
		);
	if (!hasChanges(accumulated)) return false;
	return hasChanges(
		db
			.prepare(`
UPDATE live_learnings
SET status = 'merged', status_changed_at = ?, merged_into = ?, updated_at = ?
WHERE id = ? AND updated_at = ?
`)
			.run(nowSec, winner.id, nowSec, loser.id, loser.updated_at),
	);
}

function compareRankedEntries(left: RankedLearningEntry, right: RankedLearningEntry): number {
	if (right.score !== left.score) return right.score - left.score;
	if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
	if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
	return left.id.localeCompare(right.id);
}

function toLearningEntry(row: ValidLearningRow): LearningEntry {
	return {
		id: row.id,
		scope: row.scope,
		cwd: row.cwd,
		content: row.content,
		contentHash: row.content_hash,
		sourceMessageHash: row.source_message_hash,
		trigger: row.trigger,
		confidence: row.confidence,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		status: row.status,
		statusChangedAt: row.status_changed_at,
		strength: row.strength,
		usefulCount: row.useful_count,
		notUsefulCount: row.not_useful_count,
		lastReinforcedAt: row.last_reinforced_at,
		mergedInto: row.merged_into,
		repoKey: row.repo_key,
	};
}

function isLearningRow(row: LearningRow): row is ValidLearningRow {
	return (
		(row.scope === "global" || row.scope === "repo") &&
		(row.status === "active" || row.status === "merged" || row.status === "archived")
	);
}

function maxNullable(left: number | null, right: number | null): number | null {
	if (left === null) return right;
	if (right === null) return left;
	return Math.max(left, right);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function hasChanges(result: { changes: number }): boolean {
	return result.changes > 0;
}

function withImmediateTransaction<T>(db: Database, operation: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = operation();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

async function directoryExists(directory: string): Promise<boolean> {
	try {
		return (await fs.stat(directory)).isDirectory();
	} catch {
		return false;
	}
}
