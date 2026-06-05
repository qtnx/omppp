import { Database } from "bun:sqlite";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import type {
	ReviewFindingDetail,
	ReviewFindingDetailRecord,
	ReviewFindingGenerateResponse,
	ReviewFindingGenerationEventsResponse,
	ReviewFindingLessonGeneration,
	ReviewFindingLessonGenerationEvent,
	ReviewFindingLessonGenerationEventKind,
	ReviewFindingLessonGenerationProgress,
	ReviewFindingLessonGenerationProgressTool,
	ReviewFindingLessonGenerationStatus,
	ReviewFindingListResponse,
	ReviewFindingPriorityLabel,
	ReviewFindingRepoSummary,
	ReviewFindingStatus,
	ReviewFindingSummary,
} from "./shared-types";

const PRIORITY_ORD: Record<ReviewFindingPriorityLabel, 0 | 1 | 2 | 3> = {
	P0: 0,
	P1: 1,
	P2: 2,
	P3: 3,
};
const MAX_GENERATED_FIELD_LENGTH = 500;
const MAX_GENERATED_LIST_ITEMS = 8;
const MAX_GENERATION_EVENTS = 200;
const MAX_EVENT_MESSAGE_LENGTH = 500;
const MAX_EVENT_LINE_LENGTH = 240;
const MAX_EVENT_LINES = 12;
const MAX_EVENT_TOOLS = 8;

const EMPTY_LIST: ReviewFindingListResponse = { findings: [], total: 0, repos: [] };

export interface ReviewFindingRecordItem {
	title: string;
	body: string;
	priority: ReviewFindingPriorityLabel;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

export interface ReviewFindingRecordInput {
	agentDbPath?: string;
	nowSec?: number;
	mode?: "live" | "backfill";
	repoName: string;
	repoRoot: string;
	cwd: string;
	agent: string;
	taskId: string;
	taskDescription: string;
	taskAssignment: string;
	outputPath: string;
	sessionFile: string;
	resolvedModel: string;
	taskExitCode: number;
	taskAborted: boolean;
	findings: ReviewFindingRecordItem[];
}

export interface ReviewFindingListOptions {
	agentDbPath?: string;
	query?: string | null;
	status?: ReviewFindingStatus;
	repoRoot?: string | null;
	limit?: number;
	offset?: number;
}

export interface ReviewFindingGeneratedLesson {
	facts: string[];
	lesson: string;
	rationale: string;
	applyWhen: string[];
	avoid: string[];
	sourceSummary: string;
}

export interface ReviewFindingLessonGeneratorInput {
	finding: ReviewFindingDetailRecord;
	onProgress: (progress: ReviewFindingLessonGenerationProgress) => void | Promise<void>;
}

export type ReviewFindingLessonGenerator = (
	input: ReviewFindingLessonGeneratorInput,
) => Promise<ReviewFindingGeneratedLesson> | ReviewFindingGeneratedLesson;

export interface ReviewFindingGenerationEventListOptions extends ReviewFindingStorageOptions {
	afterSequence?: number;
	limit?: number;
}

export interface ReviewFindingStorageOptions {
	agentDbPath?: string;
	nowSec?: number;
	generateReviewFindingLesson?: ReviewFindingLessonGenerator;
	runReviewFindingLessonJobsInline?: boolean;
}

interface ReviewFindingRow {
	id: string;
	fingerprint: string;
	repo_name: string;
	repo_root: string;
	cwd: string;
	agent: string;
	task_id: string;
	task_description: string;
	task_assignment: string;
	title: string;
	body: string;
	priority_label: string;
	priority_ord: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
	output_path: string;
	session_file: string;
	resolved_model: string;
	task_exit_code: number;
	task_aborted: number;
	first_seen_at: number;
	last_seen_at: number;
	occurrence_count: number;
	learning_id: string | null;
	learning_saved_at: number | null;
}

interface ReviewFindingLearningJobRow {
	id: string;
	finding_id: string;
	status: string;
	attempt_count: number;
	generated_lesson_json: string | null;
	lesson_content: string | null;
	error: string | null;
	learning_id: string | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}

interface ReviewFindingLearningEventRow {
	id: number;
	job_id: string;
	finding_id: string;
	event_type: string;
	message: string;
	progress_json: string | null;
	created_at: number;
}

interface CountRow {
	count: number;
}

interface LearningRow {
	id: string;
	content?: string;
}

interface RepoRow {
	repo_name: string;
	repo_root: string;
	pending_count: number;
	saved_count: number;
	last_seen_at: number;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function normalizeText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function normalizeForHash(value: string): string {
	return normalizeText(value).toLowerCase();
}

function learningContentHash(scope: "global" | "repo", cwd: string, content: string): string {
	return Bun.hash(`${scope}\u0000${cwd}\u0000${normalizeForHash(content)}`).toString(16);
}

function learningMessageHash(content: string): string {
	return Bun.hash(normalizeForHash(content)).toString(16);
}

function fingerprintFinding(repoRoot: string, finding: ReviewFindingRecordItem): string {
	const parts = [
		repoRoot,
		normalizeForHash(finding.title),
		normalizeForHash(finding.body),
		normalizeForHash(finding.file_path),
		String(finding.line_start),
		String(finding.line_end),
		finding.priority,
	];
	return Bun.hash(parts.join("\u0000")).toString(16);
}

function coerceLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 100;
	return Math.min(500, Math.max(1, Math.floor(value)));
}

function coerceOffset(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function coerceEventLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return MAX_GENERATION_EVENTS;
	return Math.min(MAX_GENERATION_EVENTS, Math.max(1, Math.floor(value)));
}

function coerceEventSequence(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function resolveDbPath(agentDbPath?: string): string {
	return agentDbPath ?? getAgentDbPath();
}

function openReviewDb(dbPath: string): Database {
	const db = new Database(dbPath);
	ensureReviewFindingSchema(db);
	return db;
}

function ensureReviewFindingSchema(db: Database): void {
	db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS review_findings (
	id TEXT PRIMARY KEY,
	fingerprint TEXT NOT NULL UNIQUE,
	repo_name TEXT NOT NULL,
	repo_root TEXT NOT NULL,
	cwd TEXT NOT NULL,
	agent TEXT NOT NULL,
	task_id TEXT NOT NULL,
	task_description TEXT NOT NULL,
	task_assignment TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	priority_label TEXT NOT NULL,
	priority_ord INTEGER NOT NULL,
	confidence REAL NOT NULL,
	file_path TEXT NOT NULL,
	line_start INTEGER NOT NULL,
	line_end INTEGER NOT NULL,
	output_path TEXT NOT NULL,
	session_file TEXT NOT NULL,
	resolved_model TEXT NOT NULL,
	task_exit_code INTEGER NOT NULL,
	task_aborted INTEGER NOT NULL,
	first_seen_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	occurrence_count INTEGER NOT NULL,
	learning_id TEXT,
	learning_saved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_review_findings_repo_status_last_seen
ON review_findings(repo_root, learning_saved_at, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_findings_last_seen
ON review_findings(last_seen_at DESC);

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

CREATE TABLE IF NOT EXISTS review_finding_learning_jobs (
	id TEXT PRIMARY KEY,
	finding_id TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL,
	attempt_count INTEGER NOT NULL,
	generated_lesson_json TEXT,
	lesson_content TEXT,
	error TEXT,
	learning_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_review_finding_learning_jobs_status_updated
ON review_finding_learning_jobs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS review_finding_learning_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	job_id TEXT NOT NULL,
	finding_id TEXT NOT NULL,
	event_type TEXT NOT NULL,
	message TEXT NOT NULL,
	progress_json TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_finding_learning_events_finding_id
ON review_finding_learning_events(finding_id, id);

CREATE INDEX IF NOT EXISTS idx_review_finding_learning_events_job_id
ON review_finding_learning_events(job_id, id);
`);
}

function hasValidLineRange(lineStart: number, lineEnd: number): boolean {
	return Number.isInteger(lineStart) && Number.isInteger(lineEnd) && lineStart > 0 && lineEnd >= lineStart;
}

function isValidFinding(input: ReviewFindingRecordItem): boolean {
	return (
		input.title.trim().length > 0 &&
		input.body.trim().length > 0 &&
		input.file_path.trim().length > 0 &&
		Object.hasOwn(PRIORITY_ORD, input.priority) &&
		Number.isFinite(input.confidence) &&
		input.confidence >= 0 &&
		input.confidence <= 1 &&
		hasValidLineRange(input.line_start, input.line_end)
	);
}

function liveConflictUpdateSql(): string {
	return `
ON CONFLICT(fingerprint) DO UPDATE SET
	repo_name = excluded.repo_name,
	repo_root = excluded.repo_root,
	cwd = excluded.cwd,
	agent = excluded.agent,
	task_id = excluded.task_id,
	task_description = excluded.task_description,
	task_assignment = excluded.task_assignment,
	title = excluded.title,
	body = excluded.body,
	priority_label = excluded.priority_label,
	priority_ord = excluded.priority_ord,
	confidence = excluded.confidence,
	file_path = excluded.file_path,
	line_start = excluded.line_start,
	line_end = excluded.line_end,
	output_path = excluded.output_path,
	session_file = excluded.session_file,
	resolved_model = excluded.resolved_model,
	task_exit_code = excluded.task_exit_code,
	task_aborted = excluded.task_aborted,
	last_seen_at = excluded.last_seen_at,
	occurrence_count = review_findings.occurrence_count + 1`;
}

export async function recordReviewFindings(input: ReviewFindingRecordInput): Promise<number> {
	const validFindings = input.findings.filter(isValidFinding);
	if (validFindings.length === 0) return 0;

	const nowSec = Math.floor(input.nowSec ?? nowSeconds());
	const repoRoot = input.repoRoot.trim() || input.cwd.trim();
	const repoName = input.repoName.trim() || repoRoot || input.cwd.trim() || "unknown";
	const db = openReviewDb(resolveDbPath(input.agentDbPath));
	try {
		const insert = db.prepare(`
INSERT INTO review_findings (
	id,
	fingerprint,
	repo_name,
	repo_root,
	cwd,
	agent,
	task_id,
	task_description,
	task_assignment,
	title,
	body,
	priority_label,
	priority_ord,
	confidence,
	file_path,
	line_start,
	line_end,
	output_path,
	session_file,
	resolved_model,
	task_exit_code,
	task_aborted,
	first_seen_at,
	last_seen_at,
	occurrence_count
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
${input.mode === "backfill" ? "ON CONFLICT(fingerprint) DO NOTHING" : liveConflictUpdateSql()}
`);
		let changed = 0;
		for (const finding of validFindings) {
			const fingerprint = fingerprintFinding(repoRoot, finding);
			const result = insert.run(
				`review-finding-${fingerprint}`,
				fingerprint,
				repoName,
				repoRoot,
				input.cwd,
				input.agent,
				input.taskId,
				input.taskDescription,
				input.taskAssignment,
				normalizeText(finding.title),
				finding.body.trim(),
				finding.priority,
				PRIORITY_ORD[finding.priority],
				finding.confidence,
				finding.file_path.trim(),
				Math.floor(finding.line_start),
				Math.floor(finding.line_end),
				input.outputPath,
				input.sessionFile,
				input.resolvedModel,
				Math.floor(input.taskExitCode),
				input.taskAborted ? 1 : 0,
				nowSec,
				nowSec,
			);
			changed += Number(result.changes ?? 0);
		}
		return changed;
	} finally {
		db.close();
	}
}

export async function listReviewFindings(options: ReviewFindingListOptions = {}): Promise<ReviewFindingListResponse> {
	const dbPath = resolveDbPath(options.agentDbPath);
	if (!(await Bun.file(dbPath).exists())) return EMPTY_LIST;
	const db = openReviewDb(dbPath);
	try {
		const { whereSql, params } = buildFindingWhere(options);
		const limit = coerceLimit(options.limit);
		const offset = coerceOffset(options.offset);
		const rows = db
			.prepare(`
SELECT ${summaryColumns()}
FROM review_findings
${whereSql}
ORDER BY last_seen_at DESC, first_seen_at DESC
LIMIT ? OFFSET ?
`)
			.all(...params, limit, offset) as ReviewFindingRow[];
		const countRow = db.prepare(`SELECT COUNT(*) AS count FROM review_findings ${whereSql}`).get(...params) as
			| CountRow
			| undefined;
		return {
			findings: rows.map(rowToSummary),
			total: countRow?.count ?? 0,
			repos: listRepoSummaries(db),
		};
	} finally {
		db.close();
	}
}

export async function getReviewFindingDetail(
	id: string,
	options: ReviewFindingStorageOptions = {},
): Promise<ReviewFindingDetail | null> {
	const dbPath = resolveDbPath(options.agentDbPath);
	if (!(await Bun.file(dbPath).exists())) return null;
	const db = openReviewDb(dbPath);
	try {
		const row = selectFindingRow(db, id);
		return row ? rowToDetail(db, row) : null;
	} finally {
		db.close();
	}
}

export async function listReviewFindingLessonGenerationEvents(
	id: string,
	options: ReviewFindingGenerationEventListOptions = {},
): Promise<ReviewFindingGenerationEventsResponse | null> {
	const dbPath = resolveDbPath(options.agentDbPath);
	if (!(await Bun.file(dbPath).exists())) return null;
	const db = openReviewDb(dbPath);
	try {
		const row = selectFindingRow(db, id);
		if (!row) return null;
		const job = selectLearningJob(db, row.id);
		const afterSequence = coerceEventSequence(options.afterSequence);
		const limit = coerceEventLimit(options.limit);
		const events = listGenerationEvents(db, row.id, afterSequence, limit);
		return {
			generation: rowToGeneration(db, row, job, events),
			events,
		};
	} finally {
		db.close();
	}
}

export class ReviewFindingLessonGeneratorUnavailableError extends Error {
	constructor() {
		super("Review finding lesson generator is not configured");
	}
}

export async function triggerReviewFindingLessonGeneration(
	id: string,
	options: ReviewFindingStorageOptions = {},
): Promise<ReviewFindingGenerateResponse | null> {
	const dbPath = resolveDbPath(options.agentDbPath);
	if (!(await Bun.file(dbPath).exists())) return null;
	const nowSec = Math.floor(options.nowSec ?? nowSeconds());
	let jobToRun: string | null = null;
	let response: ReviewFindingGenerateResponse | null = null;
	const db = openReviewDb(dbPath);
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = selectFindingRow(db, id);
			if (!row) {
				db.exec("ROLLBACK");
				return null;
			}
			if (row.learning_id && row.learning_saved_at !== null) {
				db.exec("COMMIT");
				return {
					...rowToDetail(db, row),
					alreadySaved: true,
				};
			}
			if (!options.generateReviewFindingLesson) {
				throw new ReviewFindingLessonGeneratorUnavailableError();
			}
			const prepared = prepareReviewFindingLessonJob(db, row, nowSec);
			jobToRun = prepared.shouldRun ? prepared.job.id : null;
			response = {
				...rowToDetail(db, row),
				alreadySaved: false,
			};
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	} finally {
		db.close();
	}

	if (jobToRun) {
		const run = runReviewFindingLessonJob(
			dbPath,
			jobToRun,
			options.generateReviewFindingLesson,
			options.runReviewFindingLessonJobsInline ? nowSec : undefined,
		);
		if (options.runReviewFindingLessonJobsInline) {
			await run;
			return getGeneratedReviewFindingResponse(id, dbPath, false);
		}
		void run;
	}
	return response;
}

async function getGeneratedReviewFindingResponse(
	id: string,
	dbPath: string,
	alreadySaved: boolean,
): Promise<ReviewFindingGenerateResponse | null> {
	const db = openReviewDb(dbPath);
	try {
		const row = selectFindingRow(db, id);
		return row ? { ...rowToDetail(db, row), alreadySaved } : null;
	} finally {
		db.close();
	}
}

function prepareReviewFindingLessonJob(
	db: Database,
	row: ReviewFindingRow,
	nowSec: number,
): { job: ReviewFindingLearningJobRow; shouldRun: boolean } {
	const existing = selectLearningJob(db, row.id);
	if (!existing) {
		const jobId = `review-learning-${nowSec}-${row.fingerprint}-${crypto.randomUUID()}`;
		db.prepare(`
INSERT INTO review_finding_learning_jobs (
	id, finding_id, status, attempt_count, created_at, updated_at
)
VALUES (?, ?, 'queued', 1, ?, ?)
`).run(jobId, row.id, nowSec, nowSec);
		insertReviewFindingLessonEvent(db, jobId, row.id, "status", "Generation queued", null, nowSec);
		const job = selectLearningJob(db, row.id);
		if (!job) throw new Error("Queued review finding learning job could not be reloaded.");
		return { job, shouldRun: true };
	}
	if (existing.status === "succeeded") return { job: existing, shouldRun: false };
	if (existing.status === "queued") return { job: existing, shouldRun: true };
	if (existing.status === "running") return { job: existing, shouldRun: false };
	db.prepare(`
UPDATE review_finding_learning_jobs
SET status = 'queued',
	attempt_count = attempt_count + 1,
	error = NULL,
	updated_at = ?,
	completed_at = NULL
WHERE id = ?
`).run(nowSec, existing.id);
	insertReviewFindingLessonEvent(db, existing.id, row.id, "status", "Generation requeued", null, nowSec);
	const job = selectLearningJob(db, row.id);
	if (!job) throw new Error("Retried review finding learning job could not be reloaded.");
	return { job, shouldRun: true };
}

async function runReviewFindingLessonJob(
	dbPath: string,
	jobId: string,
	generateReviewFindingLesson: ReviewFindingLessonGenerator | undefined,
	fixedNowSec?: number,
): Promise<void> {
	if (!generateReviewFindingLesson) return;
	const claimed = claimReviewFindingLessonJob(dbPath, jobId, fixedNowSec ?? nowSeconds());
	if (!claimed) return;
	const row = claimed;
	try {
		const generated = normalizeGeneratedLesson(
			await generateReviewFindingLesson({
				finding: rowToDetailRecord(row),
				onProgress: progress => {
					appendReviewFindingLessonEvent(
						dbPath,
						jobId,
						row.id,
						"progress",
						progress.message,
						progress,
						fixedNowSec,
					);
				},
			}),
		);
		if (!generated) throw new Error("Review finding lesson generator returned invalid structured lesson.");
		if (generatedLessonCopiesRawReviewBody(generated, row.body)) {
			throw new Error("Review finding lesson generator copied the raw review body.");
		}
		const content = formatGeneratedReviewFindingLesson(generated, row);
		if (containsRawReviewBody(content, row.body)) {
			throw new Error("Review finding lesson generator copied the raw review body.");
		}
		completeReviewFindingLessonJob(dbPath, jobId, row.id, content, generated, fixedNowSec ?? nowSeconds());
	} catch (err) {
		failReviewFindingLessonJob(dbPath, jobId, err, fixedNowSec ?? nowSeconds());
	}
}

function claimReviewFindingLessonJob(dbPath: string, jobId: string, nowSec: number): ReviewFindingRow | null {
	const db = openReviewDb(dbPath);
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const job = selectLearningJobById(db, jobId);
			if (job?.status !== "queued") {
				db.exec("COMMIT");
				return null;
			}
			const row = selectFindingRow(db, job.finding_id);
			if (!row || (row.learning_id && row.learning_saved_at !== null)) {
				db.prepare(
					"UPDATE review_finding_learning_jobs SET status = 'succeeded', updated_at = ?, completed_at = ? WHERE id = ?",
				).run(nowSec, nowSec, jobId);
				db.exec("COMMIT");
				return null;
			}
			db.prepare("UPDATE review_finding_learning_jobs SET status = 'running', updated_at = ? WHERE id = ?").run(
				nowSec,
				jobId,
			);
			insertReviewFindingLessonEvent(db, jobId, row.id, "status", "Agent started", null, nowSec);
			db.exec("COMMIT");
			return row;
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	} finally {
		db.close();
	}
}

function completeReviewFindingLessonJob(
	dbPath: string,
	jobId: string,
	findingId: string,
	content: string,
	generated: ReviewFindingGeneratedLesson,
	nowSec: number,
): void {
	const db = openReviewDb(dbPath);
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = selectFindingRow(db, findingId);
			if (!row) throw new Error("Review finding row disappeared during lesson completion.");
			const learning = storeGeneratedReviewFindingLearning(db, row, content, nowSec);
			db.prepare(
				"UPDATE review_findings SET learning_id = ?, learning_saved_at = ? WHERE id = ? AND learning_saved_at IS NULL",
			).run(learning.id, nowSec, findingId);
			db.prepare(`
UPDATE review_finding_learning_jobs
SET status = 'succeeded',
	generated_lesson_json = ?,
	lesson_content = ?,
	error = NULL,
	learning_id = ?,
	updated_at = ?,
	completed_at = ?
WHERE id = ?
`).run(JSON.stringify(generated), content, learning.id, nowSec, nowSec, jobId);
			insertReviewFindingLessonEvent(db, jobId, findingId, "status", "Lesson saved", null, nowSec);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	} finally {
		db.close();
	}
}

function failReviewFindingLessonJob(dbPath: string, jobId: string, err: unknown, nowSec: number): void {
	const db = openReviewDb(dbPath);
	try {
		const errorMessage = truncateGeneratedField(err instanceof Error ? err.message : String(err));
		db.exec("BEGIN IMMEDIATE");
		try {
			const job = selectLearningJobById(db, jobId);
			db.prepare(`
UPDATE review_finding_learning_jobs
SET status = 'failed',
	error = ?,
	updated_at = ?,
	completed_at = ?
WHERE id = ?
`).run(errorMessage, nowSec, nowSec, jobId);
			if (job) {
				insertReviewFindingLessonEvent(
					db,
					jobId,
					job.finding_id,
					"error",
					`Generation failed: ${errorMessage}`,
					null,
					nowSec,
				);
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.close();
	}
}

function appendReviewFindingLessonEvent(
	dbPath: string,
	jobId: string,
	findingId: string,
	kind: ReviewFindingLessonGenerationEventKind,
	message: string,
	progress: ReviewFindingLessonGenerationProgress | null,
	fixedNowSec?: number,
): void {
	const db = openReviewDb(dbPath);
	try {
		insertReviewFindingLessonEvent(db, jobId, findingId, kind, message, progress, fixedNowSec ?? nowSeconds());
	} finally {
		db.close();
	}
}

function insertReviewFindingLessonEvent(
	db: Database,
	jobId: string,
	findingId: string,
	kind: ReviewFindingLessonGenerationEventKind,
	message: string,
	progress: ReviewFindingLessonGenerationProgress | null,
	nowSec: number,
): void {
	const normalizedProgress = progress ? normalizeGenerationProgress(progress) : null;
	const normalizedMessage = truncateEventText(
		message || normalizedProgress?.message || kind,
		MAX_EVENT_MESSAGE_LENGTH,
	);
	db.prepare(`
INSERT INTO review_finding_learning_events (
	job_id, finding_id, event_type, message, progress_json, created_at
)
VALUES (?, ?, ?, ?, ?, ?)
`).run(
		jobId,
		findingId,
		kind,
		normalizedMessage || kind,
		normalizedProgress ? JSON.stringify(normalizedProgress) : null,
		nowSec,
	);
}

function normalizeGenerationProgress(
	progress: ReviewFindingLessonGenerationProgress,
): ReviewFindingLessonGenerationProgress {
	return {
		status: progress.status,
		message: truncateEventText(progress.message, MAX_EVENT_MESSAGE_LENGTH),
		...(progress.lastIntent ? { lastIntent: truncateEventText(progress.lastIntent, MAX_EVENT_LINE_LENGTH) } : {}),
		...(progress.currentTool ? { currentTool: truncateEventText(progress.currentTool, MAX_EVENT_LINE_LENGTH) } : {}),
		...(progress.currentToolArgs
			? { currentToolArgs: truncateEventText(progress.currentToolArgs, MAX_EVENT_LINE_LENGTH) }
			: {}),
		recentTools: normalizeProgressTools(progress.recentTools),
		recentOutput: normalizeEventLines(progress.recentOutput),
		toolCount: coerceEventNumber(progress.toolCount),
		tokens: coerceEventNumber(progress.tokens),
		...(progress.contextTokens !== undefined && Number.isFinite(progress.contextTokens)
			? { contextTokens: coerceEventNumber(progress.contextTokens) }
			: {}),
		...(progress.contextWindow !== undefined && Number.isFinite(progress.contextWindow)
			? { contextWindow: coerceEventNumber(progress.contextWindow) }
			: {}),
		cost: coerceEventCost(progress.cost),
		durationMs: coerceEventNumber(progress.durationMs),
		...(progress.resolvedModel
			? { resolvedModel: truncateEventText(progress.resolvedModel, MAX_EVENT_LINE_LENGTH) }
			: {}),
	};
}

function normalizeProgressTools(
	tools: ReviewFindingLessonGenerationProgressTool[],
): ReviewFindingLessonGenerationProgressTool[] {
	return tools.slice(0, MAX_EVENT_TOOLS).map(tool => ({
		tool: truncateEventText(tool.tool, MAX_EVENT_LINE_LENGTH),
		args: truncateEventText(tool.args, MAX_EVENT_LINE_LENGTH),
		endMs: coerceEventNumber(tool.endMs),
	}));
}

function normalizeEventLines(lines: string[]): string[] {
	return lines
		.map(line => truncateEventText(line, MAX_EVENT_LINE_LENGTH))
		.filter(line => line.length > 0)
		.slice(0, MAX_EVENT_LINES);
}

function truncateEventText(value: string, maxLength: number): string {
	const normalized = value.replaceAll("\t", "    ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

function coerceEventNumber(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function coerceEventCost(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, value);
}

function storeGeneratedReviewFindingLearning(
	db: Database,
	row: ReviewFindingRow,
	content: string,
	nowSec: number,
): LearningRow {
	const contentHash = learningContentHash("repo", row.repo_root, content);
	const sourceMessageHash = learningMessageHash(`${row.id}\u0000${row.fingerprint}\u0000generated-review-learning`);
	db.prepare(`
INSERT INTO live_learnings (
	id, scope, cwd, content, content_hash, source_message_hash, trigger, confidence, created_at, updated_at
)
VALUES (?, 'repo', ?, ?, ?, ?, 'review-finding', ?, ?, ?)
ON CONFLICT(scope, cwd, content_hash) DO UPDATE SET
	source_message_hash = excluded.source_message_hash,
	trigger = excluded.trigger,
	confidence = CASE
		WHEN excluded.confidence > live_learnings.confidence THEN excluded.confidence
		ELSE live_learnings.confidence
	END,
	updated_at = excluded.updated_at
`).run(
		`learning-${nowSec}-${contentHash}`,
		row.repo_root,
		content,
		contentHash,
		sourceMessageHash,
		row.confidence,
		nowSec,
		nowSec,
	);
	const learning = db
		.prepare("SELECT id, content FROM live_learnings WHERE scope = 'repo' AND cwd = ? AND content_hash = ?")
		.get(row.repo_root, contentHash) as LearningRow | undefined;
	if (!learning) throw new Error("Saved generated learning row could not be reloaded.");
	return learning;
}

function buildFindingWhere(options: ReviewFindingListOptions): { whereSql: string; params: Array<string | number> } {
	const clauses: string[] = [];
	const params: Array<string | number> = [];
	const repoRoot = options.repoRoot?.trim();
	if (repoRoot) {
		clauses.push("repo_root = ?");
		params.push(repoRoot);
	}
	if (options.status === "pending") {
		clauses.push("learning_saved_at IS NULL");
	} else if (options.status === "saved") {
		clauses.push("learning_saved_at IS NOT NULL");
	}
	const query = options.query?.trim();
	if (query) {
		const like = `%${query}%`;
		clauses.push(
			"(title LIKE ? OR body LIKE ? OR file_path LIKE ? OR repo_name LIKE ? OR repo_root LIKE ? OR agent LIKE ?)",
		);
		params.push(like, like, like, like, like, like);
	}
	return { whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function summaryColumns(): string {
	return `
	id,
	fingerprint,
	repo_name,
	repo_root,
	cwd,
	agent,
	task_id,
	task_description,
	task_assignment,
	title,
	body,
	priority_label,
	priority_ord,
	confidence,
	file_path,
	line_start,
	line_end,
	output_path,
	session_file,
	resolved_model,
	task_exit_code,
	task_aborted,
	first_seen_at,
	last_seen_at,
	occurrence_count,
	learning_id,
	learning_saved_at`;
}

function selectFindingRow(db: Database, id: string): ReviewFindingRow | null {
	return (
		(db.prepare(`SELECT ${summaryColumns()} FROM review_findings WHERE id = ?`).get(id) as
			| ReviewFindingRow
			| undefined) ?? null
	);
}

function selectLearningJob(db: Database, findingId: string): ReviewFindingLearningJobRow | null {
	return (
		(db.prepare("SELECT * FROM review_finding_learning_jobs WHERE finding_id = ?").get(findingId) as
			| ReviewFindingLearningJobRow
			| undefined) ?? null
	);
}

function selectLearningJobById(db: Database, jobId: string): ReviewFindingLearningJobRow | null {
	return (
		(db.prepare("SELECT * FROM review_finding_learning_jobs WHERE id = ?").get(jobId) as
			| ReviewFindingLearningJobRow
			| undefined) ?? null
	);
}

function listGenerationEvents(
	db: Database,
	findingId: string,
	afterSequence = 0,
	limit = MAX_GENERATION_EVENTS,
): ReviewFindingLessonGenerationEvent[] {
	if (afterSequence <= 0) {
		const rows = db
			.prepare(`
SELECT id, job_id, finding_id, event_type, message, progress_json, created_at
FROM review_finding_learning_events
WHERE finding_id = ?
ORDER BY id DESC
LIMIT ?
`)
			.all(findingId, limit) as ReviewFindingLearningEventRow[];
		return rows.reverse().map(rowToGenerationEvent);
	}
	const rows = db
		.prepare(`
SELECT id, job_id, finding_id, event_type, message, progress_json, created_at
FROM review_finding_learning_events
WHERE finding_id = ? AND id > ?
ORDER BY id ASC
LIMIT ?
`)
		.all(findingId, afterSequence, limit) as ReviewFindingLearningEventRow[];
	return rows.map(rowToGenerationEvent);
}

function rowToGenerationEvent(row: ReviewFindingLearningEventRow): ReviewFindingLessonGenerationEvent {
	return {
		sequence: row.id,
		jobId: row.job_id,
		findingId: row.finding_id,
		kind: normalizeEventKind(row.event_type),
		message: row.message,
		progress: parseGenerationProgress(row.progress_json),
		createdAt: row.created_at,
	};
}

function normalizeEventKind(kind: string): ReviewFindingLessonGenerationEventKind {
	if (kind === "status" || kind === "progress" || kind === "error") return kind;
	return "status";
}

function parseGenerationProgress(progressJson: string | null): ReviewFindingLessonGenerationProgress | null {
	if (!progressJson) return null;
	try {
		const parsed: unknown = JSON.parse(progressJson);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		return normalizeGenerationProgress({
			status: typeof record.status === "string" ? normalizeJobStatus(record.status) : "running",
			message: readEventString(record.message) ?? "Agent progress",
			lastIntent: readEventString(record.lastIntent) ?? undefined,
			currentTool: readEventString(record.currentTool) ?? undefined,
			currentToolArgs: readEventString(record.currentToolArgs) ?? undefined,
			recentTools: readProgressTools(record.recentTools),
			recentOutput: readProgressLines(record.recentOutput),
			toolCount: readEventNumber(record.toolCount),
			tokens: readEventNumber(record.tokens),
			contextTokens: readOptionalEventNumber(record.contextTokens),
			contextWindow: readOptionalEventNumber(record.contextWindow),
			cost: readEventNumber(record.cost),
			durationMs: readEventNumber(record.durationMs),
			resolvedModel: readEventString(record.resolvedModel) ?? undefined,
		});
	} catch {
		return null;
	}
}

function readProgressTools(value: unknown): ReviewFindingLessonGenerationProgressTool[] {
	if (!Array.isArray(value)) return [];
	const tools: ReviewFindingLessonGenerationProgressTool[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		tools.push({
			tool: readEventString(record.tool) ?? "",
			args: readEventString(record.args) ?? "",
			endMs: readEventNumber(record.endMs),
		});
		if (tools.length >= MAX_EVENT_TOOLS) break;
	}
	return tools;
}

function readProgressLines(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const lines: string[] = [];
	for (const item of value) {
		const line = readEventString(item);
		if (line) lines.push(line);
		if (lines.length >= MAX_EVENT_LINES) break;
	}
	return lines;
}

function readEventString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text.length > 0 ? text : null;
}

function readEventNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readOptionalEventNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function selectLearningContent(db: Database, learningId: string | null): string | null {
	if (!learningId) return null;
	const learning = db.prepare("SELECT content FROM live_learnings WHERE id = ?").get(learningId) as
		| LearningRow
		| undefined;
	return typeof learning?.content === "string" ? learning.content : null;
}

function listRepoSummaries(db: Database): ReviewFindingRepoSummary[] {
	const rows = db
		.prepare(`
SELECT
	repo_name,
	repo_root,
	SUM(CASE WHEN learning_saved_at IS NULL THEN 1 ELSE 0 END) AS pending_count,
	SUM(CASE WHEN learning_saved_at IS NULL THEN 0 ELSE 1 END) AS saved_count,
	MAX(last_seen_at) AS last_seen_at
FROM review_findings
GROUP BY repo_root, repo_name
ORDER BY last_seen_at DESC, repo_name ASC
`)
		.all() as RepoRow[];
	return rows.map(row => ({
		repoName: row.repo_name,
		repoRoot: row.repo_root,
		pendingCount: row.pending_count,
		savedCount: row.saved_count,
	}));
}

function rowToSummary(row: ReviewFindingRow): ReviewFindingSummary {
	return {
		id: row.id,
		repoName: row.repo_name,
		repoRoot: row.repo_root,
		agent: row.agent,
		taskId: row.task_id,
		taskDescription: row.task_description,
		title: row.title,
		bodyPreview: row.body.length > 180 ? `${row.body.slice(0, 177)}...` : row.body,
		priorityLabel: row.priority_label as ReviewFindingPriorityLabel,
		priority: row.priority_ord,
		confidence: row.confidence,
		filePath: row.file_path,
		lineStart: row.line_start,
		lineEnd: row.line_end,
		taskExitCode: row.task_exit_code,
		taskAborted: row.task_aborted === 1,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
		occurrenceCount: row.occurrence_count,
		learningId: row.learning_id,
		learningSavedAt: row.learning_saved_at,
	};
}

function rowToDetailRecord(row: ReviewFindingRow): ReviewFindingDetailRecord {
	return {
		...rowToSummary(row),
		cwd: row.cwd,
		body: row.body,
		taskAssignment: row.task_assignment,
		outputPath: row.output_path,
		sessionFile: row.session_file,
		resolvedModel: row.resolved_model,
	};
}

function normalizeGeneratedLesson(value: unknown): ReviewFindingGeneratedLesson | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const facts = normalizeStringList(record.facts);
	const applyWhen = normalizeStringList(record.applyWhen);
	const avoid = normalizeStringList(record.avoid, { allowEmpty: true });
	const lesson = normalizeGeneratedString(record.lesson);
	const rationale = normalizeGeneratedString(record.rationale);
	const sourceSummary = normalizeGeneratedString(record.sourceSummary);
	if (facts.length === 0 || applyWhen.length === 0 || !lesson || !rationale || !sourceSummary) return null;
	return { facts, lesson, rationale, applyWhen, avoid, sourceSummary };
}

function normalizeStringList(value: unknown, options: { allowEmpty?: boolean } = {}): string[] {
	if (!Array.isArray(value)) return [];
	const items: string[] = [];
	for (const item of value) {
		const normalized = normalizeGeneratedString(item);
		if (!normalized) continue;
		items.push(normalized);
		if (items.length >= MAX_GENERATED_LIST_ITEMS) break;
	}
	return items.length > 0 || options.allowEmpty ? items : [];
}

function normalizeGeneratedString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = truncateGeneratedField(normalizeText(value));
	return normalized.length > 0 ? normalized : null;
}

function truncateGeneratedField(value: string): string {
	return value.length > MAX_GENERATED_FIELD_LENGTH ? `${value.slice(0, MAX_GENERATED_FIELD_LENGTH - 1)}…` : value;
}

function generatedLessonCopiesRawReviewBody(generated: ReviewFindingGeneratedLesson, rawBody: string): boolean {
	const normalizedBody = normalizeForRawBodyCheck(rawBody);
	if (!normalizedBody) return false;
	const fields = [
		...generated.facts,
		generated.lesson,
		generated.rationale,
		...generated.applyWhen,
		...generated.avoid,
		generated.sourceSummary,
	];
	const combined = normalizeForRawBodyCheck(fields.join(" "));
	return (
		fields.some(field => normalizedFieldCopiesRawBody(normalizeForRawBodyCheck(field), normalizedBody)) ||
		normalizedFieldCopiesRawBody(combined, normalizedBody)
	);
}

function normalizedFieldCopiesRawBody(normalizedField: string, normalizedBody: string): boolean {
	if (normalizedField.includes(normalizedBody)) return true;
	const truncatedField = normalizedField.endsWith("…") ? normalizedField.slice(0, -1).trim() : normalizedField;
	return truncatedField.length >= 24 && normalizedBody.includes(truncatedField);
}

function normalizeForRawBodyCheck(value: string): string {
	return normalizeText(value).toLowerCase();
}

function containsRawReviewBody(content: string, rawBody: string): boolean {
	const normalizedBody = normalizeForRawBodyCheck(rawBody);
	return normalizedBody.length > 0 && normalizeForRawBodyCheck(content).includes(normalizedBody);
}

function rowToDetail(db: Database, row: ReviewFindingRow): ReviewFindingDetail {
	const job = selectLearningJob(db, row.id);
	const learningContent = selectLearningContent(db, row.learning_id);
	return {
		finding: rowToDetailRecord(row),
		lessonPreview: job?.lesson_content ?? learningContent,
		generation: rowToGeneration(db, row, job),
	};
}

function rowToGeneration(
	db: Database,
	row: ReviewFindingRow,
	job: ReviewFindingLearningJobRow | null,
	events = listGenerationEvents(db, row.id),
): ReviewFindingLessonGeneration {
	if (job) {
		return {
			jobId: job.id,
			status: normalizeJobStatus(job.status),
			error: job.error,
			createdAt: job.created_at,
			updatedAt: job.updated_at,
			completedAt: job.completed_at,
			events,
		};
	}
	if (row.learning_id && row.learning_saved_at !== null) {
		return {
			jobId: null,
			status: "succeeded",
			error: null,
			createdAt: row.learning_saved_at,
			updatedAt: row.learning_saved_at,
			completedAt: row.learning_saved_at,
			events,
		};
	}
	return {
		jobId: null,
		status: "idle",
		error: null,
		createdAt: null,
		updatedAt: null,
		completedAt: null,
		events,
	};
}

function normalizeJobStatus(status: string): ReviewFindingLessonGenerationStatus {
	if (status === "queued" || status === "running" || status === "succeeded" || status === "failed") return status;
	return "failed";
}

export function formatGeneratedReviewFindingLesson(
	generated: ReviewFindingGeneratedLesson,
	finding: ReviewFindingRow | ReviewFindingDetailRecord,
): string {
	const filePath = "file_path" in finding ? finding.file_path : finding.filePath;
	const lineStart = "line_start" in finding ? finding.line_start : finding.lineStart;
	const lineEnd = "line_end" in finding ? finding.line_end : finding.lineEnd;
	const title = "title" in finding ? finding.title : "";
	const fileLocation = `${filePath}:${lineStart}${lineEnd !== lineStart ? `-${lineEnd}` : ""}`;
	return [
		"Repo learning from generated review finding lesson:",
		"Facts:",
		...generated.facts.map(fact => `- ${fact}`),
		"Lesson:",
		`- ${generated.lesson}`,
		"Rationale:",
		`- ${generated.rationale}`,
		"Apply when:",
		...generated.applyWhen.map(item => `- ${item}`),
		"Avoid:",
		...(generated.avoid.length > 0
			? generated.avoid.map(item => `- ${item}`)
			: ["- No specific avoid guidance generated."]),
		"Source:",
		`- Finding: ${title}`,
		`- Location: ${fileLocation}`,
		`- Summary: ${generated.sourceSummary}`,
	].join("\n");
}
