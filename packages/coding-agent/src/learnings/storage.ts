import { Database } from "bun:sqlite";

export type LearningScope = "global" | "repo";

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
}

export interface LearningInsert {
	scope: LearningScope;
	cwd: string;
	content: string;
	sourceMessageHash: string;
	trigger: string;
	confidence: number;
	nowSec: number;
}

export function openLearningDb(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

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
`);
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
	const scopedCwd = input.scope === "global" ? "" : input.cwd;
	const contentHash = learningContentHash(input.scope, scopedCwd, input.content);
	const id = `learning-${input.nowSec}-${contentHash}`;
	const result = db
		.prepare(`
INSERT INTO live_learnings (
	id, scope, cwd, content, content_hash, source_message_hash, trigger, confidence, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(scope, cwd, content_hash) DO UPDATE SET
	source_message_hash = excluded.source_message_hash,
	trigger = excluded.trigger,
	confidence = CASE
		WHEN excluded.confidence > live_learnings.confidence THEN excluded.confidence
		ELSE live_learnings.confidence
	END,
	updated_at = excluded.updated_at
`)
		.run(
			id,
			input.scope,
			scopedCwd,
			input.content,
			contentHash,
			input.sourceMessageHash,
			input.trigger,
			input.confidence,
			input.nowSec,
			input.nowSec,
		);
	return Number(result.changes ?? 0) > 0;
}

export function listLearningEntries(db: Database, cwd: string, limitPerScope: number): LearningEntry[] {
	const limit = Math.max(1, Math.floor(limitPerScope));
	const globalRows = selectLearningRows(db, "global", "", limit);
	const repoRows = selectLearningRows(db, "repo", cwd, limit);
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

function selectLearningRows(db: Database, scope: LearningScope, cwd: string, limit: number): LearningEntry[] {
	const rows = db
		.prepare(`
SELECT id, scope, cwd, content, content_hash, source_message_hash, trigger, confidence, created_at, updated_at
FROM live_learnings
WHERE scope = ? AND cwd = ?
ORDER BY updated_at DESC, created_at DESC
LIMIT ?
`)
		.all(scope, cwd, limit) as Array<{
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
	}>;
	return rows
		.filter(
			(row): row is (typeof rows)[number] & { scope: LearningScope } =>
				row.scope === "global" || row.scope === "repo",
		)
		.map(row => ({
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
		}));
}
