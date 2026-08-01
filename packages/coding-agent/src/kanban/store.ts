import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { KanbanError, notFound, versionConflict } from "./errors";
import type {
	KanbanActivity,
	KanbanActivityType,
	KanbanBoardSnapshot,
	KanbanComment,
	KanbanCommentCreate,
	KanbanCommentUpdate,
	KanbanExpectedVersion,
	KanbanMove,
	KanbanMutation,
	KanbanPriority,
	KanbanStatus,
	KanbanTask,
	KanbanTaskCreate,
	KanbanTaskUpdate,
} from "./types";

export const KANBAN_SCHEMA_VERSION = 1;
const ACTIVITY_SNAPSHOT_LIMIT = 200;

export interface KanbanIdempotencyOperation {
	key: string;
	method: "POST";
	route: string;
	body: unknown;
}

export interface KanbanStoreOptions {
	now?: () => Date;
	createId?: () => string;
}

interface TaskRow {
	id: string;
	session_id: string;
	status: string;
	position: number;
	title: string;
	description: string | null;
	assignee: string | null;
	labels_json: string;
	due_at: string | null;
	repo: string | null;
	worktree: string | null;
	branch: string | null;
	acceptance_criteria_json: string;
	blocker_reason: string | null;
	priority: string;
	version: number;
	created_at: string;
	updated_at: string;
}

interface CommentRow {
	id: string;
	task_id: string;
	author: string;
	body: string;
	version: number;
	created_at: string;
	edited_at: string | null;
	deleted_at: string | null;
}

interface ActivityRow {
	id: string;
	cursor: number;
	session_id: string;
	task_id: string | null;
	type: string;
	created_at: string;
	data_json: string;
}

interface IdempotencyRow {
	request_hash: string;
	status: number;
	response_json: string;
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS kanban_schema_migrations (
	version INTEGER PRIMARY KEY,
	applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_tasks (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('backlog','ready','in_progress','blocked','review','done','cancelled')),
	position INTEGER NOT NULL CHECK (position >= 0),
	title TEXT NOT NULL,
	description TEXT,
	assignee TEXT,
	labels_json TEXT NOT NULL,
	due_at TEXT,
	repo TEXT,
	worktree TEXT,
	branch TEXT,
	acceptance_criteria_json TEXT NOT NULL,
	blocker_reason TEXT,
	priority TEXT NOT NULL CHECK (priority IN ('lowest','low','medium','high','highest')),
	version INTEGER NOT NULL CHECK (version >= 1),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kanban_tasks_board_idx ON kanban_tasks(session_id, status, position);

CREATE TABLE IF NOT EXISTS kanban_comments (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
	author TEXT NOT NULL,
	body TEXT NOT NULL,
	version INTEGER NOT NULL CHECK (version >= 1),
	created_at TEXT NOT NULL,
	edited_at TEXT,
	deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS kanban_comments_task_idx ON kanban_comments(task_id, created_at, id);

CREATE TABLE IF NOT EXISTS kanban_activity (
	cursor INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	session_id TEXT NOT NULL,
	task_id TEXT,
	type TEXT NOT NULL CHECK (type IN ('task.created','task.updated','task.deleted','task.moved','comment.created','comment.updated','comment.deleted')),
	created_at TEXT NOT NULL,
	data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kanban_activity_session_cursor_idx ON kanban_activity(session_id, cursor);

CREATE TABLE IF NOT EXISTS kanban_outbox (
	event_id TEXT PRIMARY KEY REFERENCES kanban_activity(id) ON DELETE RESTRICT,
	cursor INTEGER NOT NULL UNIQUE,
	session_id TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS kanban_outbox_pending_idx ON kanban_outbox(session_id, delivered_at, cursor);

CREATE TABLE IF NOT EXISTS kanban_idempotency (
	session_id TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	method TEXT NOT NULL,
	route TEXT NOT NULL,
	status INTEGER NOT NULL,
	response_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (session_id, idempotency_key)
);
`;

function parseStringArray(serialized: string): string[] {
	const parsed: unknown = JSON.parse(serialized);
	if (!Array.isArray(parsed) || !parsed.every(value => typeof value === "string")) {
		throw new Error("Corrupt Kanban string-array column");
	}
	return parsed;
}

function parseRecord(serialized: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(serialized);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Corrupt Kanban activity data");
	}
	return { ...parsed };
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new KanbanError(422, "validation_error", "Request contains a non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new KanbanError(422, "validation_error", "Request contains an unsupported value");
}

function requestHash(operation: KanbanIdempotencyOperation): string {
	return new Bun.CryptoHasher("sha256")
		.update(`${operation.method}\n${operation.route}\n${canonicalJson(operation.body)}`)
		.digest("hex");
}

export class KanbanStore {
	readonly #db: Database;
	readonly #now: () => Date;
	readonly #createId: () => string;
	#closed = false;

	private constructor(dbPath: string, options: KanbanStoreOptions) {
		if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		this.#db = new Database(dbPath);
		this.#now = options.now ?? (() => new Date());
		this.#createId = options.createId ?? (() => crypto.randomUUID());
		this.#db.exec("PRAGMA busy_timeout = 5000");
		this.#db.exec("PRAGMA foreign_keys = ON");
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#migrate();
	}

	static open(dbPath: string, options: KanbanStoreOptions = {}): KanbanStore {
		return new KanbanStore(dbPath, options);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}

	schemaVersion(): number {
		const row = this.#db
			.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM kanban_schema_migrations")
			.get() as {
			version: number;
		};
		return row.version;
	}

	foreignKeysEnabled(): boolean {
		const row = this.#db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
		return row.foreign_keys === 1;
	}

	getBoard(sessionId: string): KanbanBoardSnapshot {
		const taskRows = this.#db
			.prepare(`
				SELECT * FROM kanban_tasks
				WHERE session_id = ?
				ORDER BY CASE status
					WHEN 'backlog' THEN 0 WHEN 'ready' THEN 1 WHEN 'in_progress' THEN 2
					WHEN 'blocked' THEN 3 WHEN 'review' THEN 4 WHEN 'done' THEN 5 ELSE 6 END,
					position, id
			`)
			.all(sessionId) as TaskRow[];
		const activityRows = this.#db
			.prepare(`
				SELECT * FROM (
					SELECT * FROM kanban_activity WHERE session_id = ? ORDER BY cursor DESC LIMIT ?
				) ORDER BY cursor ASC
			`)
			.all(sessionId, ACTIVITY_SNAPSHOT_LIMIT) as ActivityRow[];
		const cursorRow = this.#db
			.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM kanban_activity WHERE session_id = ?")
			.get(sessionId) as { cursor: number };
		return {
			tasks: taskRows.map(row => this.#taskFromRow(row)),
			activity: activityRows.map(row => this.#activityFromRow(row)),
			cursor: cursorRow.cursor,
		};
	}

	getTask(sessionId: string, taskId: string): KanbanTask {
		const row = this.#taskRow(sessionId, taskId);
		if (!row) throw notFound("Task");
		return this.#taskFromRow(row);
	}

	createTask(
		sessionId: string,
		input: KanbanTaskCreate,
		operation: KanbanIdempotencyOperation,
	): KanbanMutation<KanbanTask> {
		return this.#idempotent(sessionId, operation, 201, () => {
			const now = this.#timestamp();
			const id = this.#createId();
			const positionRow = this.#db
				.prepare("SELECT COUNT(*) AS count FROM kanban_tasks WHERE session_id = ? AND status = ?")
				.get(sessionId, input.status) as { count: number };
			const task: KanbanTask = {
				id,
				sessionId,
				status: input.status,
				position: positionRow.count,
				title: input.title,
				description: input.description ?? null,
				assignee: input.assignee ?? null,
				labels: [...(input.labels ?? [])],
				dueAt: input.dueAt ?? null,
				repo: input.repo ?? null,
				worktree: input.worktree ?? null,
				branch: input.branch ?? null,
				acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
				blockerReason: input.blockerReason ?? null,
				priority: input.priority,
				version: 1,
				createdAt: now,
				updatedAt: now,
			};
			this.#insertTask(task);
			const activity = this.#recordActivity(sessionId, task.id, "task.created", { task });
			return { data: task, activity };
		});
	}

	updateTask(sessionId: string, taskId: string, input: KanbanTaskUpdate): KanbanMutation<KanbanTask> {
		return this.#transaction(() => {
			const row = this.#taskRow(sessionId, taskId);
			if (!row) throw notFound("Task");
			if (row.version !== input.expectedVersion) throw versionConflict();
			const current = this.#taskFromRow(row);
			const changedFields: string[] = [];
			const next: KanbanTask = {
				...current,
				title: this.#updatedValue(input, "title", current.title, changedFields),
				description: this.#updatedValue(input, "description", current.description, changedFields),
				assignee: this.#updatedValue(input, "assignee", current.assignee, changedFields),
				labels: this.#updatedArray(input, "labels", current.labels, changedFields),
				dueAt: this.#updatedValue(input, "dueAt", current.dueAt, changedFields),
				repo: this.#updatedValue(input, "repo", current.repo, changedFields),
				worktree: this.#updatedValue(input, "worktree", current.worktree, changedFields),
				branch: this.#updatedValue(input, "branch", current.branch, changedFields),
				acceptanceCriteria: this.#updatedArray(
					input,
					"acceptanceCriteria",
					current.acceptanceCriteria,
					changedFields,
				),
				blockerReason: this.#updatedValue(input, "blockerReason", current.blockerReason, changedFields),
				priority: this.#updatedValue(input, "priority", current.priority, changedFields),
				version: current.version + 1,
				updatedAt: this.#timestamp(),
			};
			const result = this.#db
				.prepare(`
					UPDATE kanban_tasks SET
						title = ?, description = ?, assignee = ?, labels_json = ?, due_at = ?, repo = ?, worktree = ?,
						branch = ?, acceptance_criteria_json = ?, blocker_reason = ?, priority = ?, version = ?, updated_at = ?
					WHERE id = ? AND session_id = ? AND version = ?
				`)
				.run(
					next.title,
					next.description,
					next.assignee,
					JSON.stringify(next.labels),
					next.dueAt,
					next.repo,
					next.worktree,
					next.branch,
					JSON.stringify(next.acceptanceCriteria),
					next.blockerReason,
					next.priority,
					next.version,
					next.updatedAt,
					taskId,
					sessionId,
					input.expectedVersion,
				);
			if (result.changes !== 1) throw versionConflict();
			const activity = this.#recordActivity(sessionId, taskId, "task.updated", { task: next, changedFields });
			return { status: 200, data: next, activity, replayed: false };
		});
	}

	deleteTask(sessionId: string, taskId: string, input: KanbanExpectedVersion): KanbanMutation<null> {
		return this.#transaction(() => {
			const row = this.#taskRow(sessionId, taskId);
			if (!row) throw notFound("Task");
			if (row.version !== input.expectedVersion) throw versionConflict();
			const task = this.#taskFromRow(row);
			const result = this.#db
				.prepare("DELETE FROM kanban_tasks WHERE id = ? AND session_id = ? AND version = ?")
				.run(taskId, sessionId, input.expectedVersion);
			if (result.changes !== 1) throw versionConflict();
			const now = this.#timestamp();
			this.#db
				.prepare(`
					UPDATE kanban_tasks SET position = position - 1, version = version + 1, updated_at = ?
					WHERE session_id = ? AND status = ? AND position > ?
				`)
				.run(now, sessionId, task.status, task.position);
			const activity = this.#recordActivity(sessionId, taskId, "task.deleted", { task });
			return { status: 200, data: null, activity, replayed: false };
		});
	}

	moveTask(
		sessionId: string,
		taskId: string,
		input: KanbanMove,
		operation: KanbanIdempotencyOperation,
	): KanbanMutation<KanbanTask> {
		return this.#idempotent(sessionId, operation, 200, () => {
			const row = this.#taskRow(sessionId, taskId);
			if (!row) throw notFound("Task");
			if (row.version !== input.expectedVersion) throw versionConflict();
			const before = this.#taskFromRow(row);
			const targetIds = this.#columnTaskIds(sessionId, input.status).filter(id => id !== taskId);
			if (input.index > targetIds.length) {
				throw new KanbanError(422, "validation_error", "Move index is outside the target column");
			}
			targetIds.splice(input.index, 0, taskId);
			const now = this.#timestamp();
			if (before.status !== input.status) {
				const sourceIds = this.#columnTaskIds(sessionId, before.status).filter(id => id !== taskId);
				this.#writeColumn(sessionId, before.status, sourceIds, now);
			}
			this.#writeColumn(sessionId, input.status, targetIds, now);
			const moved = this.getTask(sessionId, taskId);
			const activity = this.#recordActivity(sessionId, taskId, "task.moved", {
				task: moved,
				fromStatus: before.status,
				fromIndex: before.position,
				toStatus: moved.status,
				toIndex: moved.position,
			});
			return { data: moved, activity };
		});
	}

	listComments(sessionId: string, taskId: string): KanbanComment[] {
		if (!this.#taskRow(sessionId, taskId)) throw notFound("Task");
		const rows = this.#db
			.prepare(`
				SELECT c.* FROM kanban_comments c
				JOIN kanban_tasks t ON t.id = c.task_id
				WHERE c.task_id = ? AND t.session_id = ?
				ORDER BY c.created_at, c.id
			`)
			.all(taskId, sessionId) as CommentRow[];
		return rows.map(row => this.#commentFromRow(row));
	}

	createComment(
		sessionId: string,
		taskId: string,
		input: KanbanCommentCreate,
		operation: KanbanIdempotencyOperation,
	): KanbanMutation<KanbanComment> {
		return this.#idempotent(sessionId, operation, 201, () => {
			if (!this.#taskRow(sessionId, taskId)) throw notFound("Task");
			const comment: KanbanComment = {
				id: this.#createId(),
				taskId,
				author: input.author,
				body: input.body,
				version: 1,
				createdAt: this.#timestamp(),
				editedAt: null,
				deletedAt: null,
			};
			this.#db
				.prepare(`
					INSERT INTO kanban_comments(id, task_id, author, body, version, created_at, edited_at, deleted_at)
					VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
				`)
				.run(comment.id, taskId, comment.author, comment.body, comment.version, comment.createdAt);
			const activity = this.#recordActivity(sessionId, taskId, "comment.created", { comment });
			return { data: comment, activity };
		});
	}

	updateComment(
		sessionId: string,
		taskId: string,
		commentId: string,
		input: KanbanCommentUpdate,
	): KanbanMutation<KanbanComment> {
		return this.#transaction(() => {
			const row = this.#commentRow(sessionId, taskId, commentId);
			if (!row) throw notFound("Comment");
			if (row.version !== input.expectedVersion) throw versionConflict();
			if (row.deleted_at) throw new KanbanError(409, "comment_deleted", "Deleted comments cannot be edited");
			const editedAt = this.#timestamp();
			const result = this.#db
				.prepare(`
					UPDATE kanban_comments SET body = ?, version = version + 1, edited_at = ?
					WHERE id = ? AND task_id = ? AND version = ? AND deleted_at IS NULL
				`)
				.run(input.body, editedAt, commentId, taskId, input.expectedVersion);
			if (result.changes !== 1) throw versionConflict();
			const comment = this.#commentFromRow(this.#commentRow(sessionId, taskId, commentId)!);
			const activity = this.#recordActivity(sessionId, taskId, "comment.updated", { comment });
			return { status: 200, data: comment, activity, replayed: false };
		});
	}

	deleteComment(
		sessionId: string,
		taskId: string,
		commentId: string,
		input: KanbanExpectedVersion,
	): KanbanMutation<KanbanComment> {
		return this.#transaction(() => {
			const row = this.#commentRow(sessionId, taskId, commentId);
			if (!row) throw notFound("Comment");
			if (row.version !== input.expectedVersion) throw versionConflict();
			if (row.deleted_at) throw new KanbanError(409, "comment_deleted", "Comment is already deleted");
			const deletedAt = this.#timestamp();
			const result = this.#db
				.prepare(`
					UPDATE kanban_comments SET body = '', version = version + 1, deleted_at = ?
					WHERE id = ? AND task_id = ? AND version = ? AND deleted_at IS NULL
				`)
				.run(deletedAt, commentId, taskId, input.expectedVersion);
			if (result.changes !== 1) throw versionConflict();
			const comment = this.#commentFromRow(this.#commentRow(sessionId, taskId, commentId)!);
			const activity = this.#recordActivity(sessionId, taskId, "comment.deleted", { comment });
			return { status: 200, data: comment, activity, replayed: false };
		});
	}

	listActivitiesAfter(sessionId: string, cursor: number, limit = 500): KanbanActivity[] {
		const rows = this.#db
			.prepare(`
				SELECT * FROM kanban_activity
				WHERE session_id = ? AND cursor > ?
				ORDER BY cursor ASC
				LIMIT ?
			`)
			.all(sessionId, cursor, limit) as ActivityRow[];
		return rows.map(row => this.#activityFromRow(row));
	}

	listUndelivered(sessionId: string): KanbanActivity[] {
		const rows = this.#db
			.prepare(`
				SELECT a.* FROM kanban_outbox o
				JOIN kanban_activity a ON a.id = o.event_id
				WHERE o.session_id = ? AND o.delivered_at IS NULL
				ORDER BY o.cursor ASC
			`)
			.all(sessionId) as ActivityRow[];
		return rows.map(row => this.#activityFromRow(row));
	}

	markDelivered(sessionId: string, eventId: string): void {
		this.#db
			.prepare(
				"UPDATE kanban_outbox SET delivered_at = ? WHERE session_id = ? AND event_id = ? AND delivered_at IS NULL",
			)
			.run(this.#timestamp(), sessionId, eventId);
	}

	#migrate(): void {
		this.#transaction(() => {
			this.#db.exec(MIGRATION_SQL);
			this.#db
				.prepare("INSERT OR IGNORE INTO kanban_schema_migrations(version, applied_at) VALUES (?, ?)")
				.run(KANBAN_SCHEMA_VERSION, this.#timestamp());
		});
	}

	#transaction<T>(run: () => T): T {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = run();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	#idempotent<T>(
		sessionId: string,
		operation: KanbanIdempotencyOperation,
		status: number,
		mutate: () => { data: T; activity: KanbanActivity },
	): KanbanMutation<T> {
		return this.#transaction(() => {
			const hash = requestHash(operation);
			const existing = this.#db
				.prepare(`
					SELECT request_hash, status, response_json FROM kanban_idempotency
					WHERE session_id = ? AND idempotency_key = ?
				`)
				.get(sessionId, operation.key) as IdempotencyRow | null;
			if (existing) {
				if (existing.request_hash !== hash) {
					throw new KanbanError(
						422,
						"idempotency_key_reused",
						"Idempotency key was already used for a different request",
					);
				}
				const parsed: unknown = JSON.parse(existing.response_json);
				if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
					throw new Error("Corrupt Kanban idempotency response");
				}
				const replayData = parsed.data as T;
				return { status: existing.status, data: replayData, activity: null, replayed: true };
			}

			const result = mutate();
			const responseJson = JSON.stringify({ data: result.data });
			this.#db
				.prepare(`
					INSERT INTO kanban_idempotency(
						session_id, idempotency_key, request_hash, method, route, status, response_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(
					sessionId,
					operation.key,
					hash,
					operation.method,
					operation.route,
					status,
					responseJson,
					this.#timestamp(),
				);
			return { status, data: result.data, activity: result.activity, replayed: false };
		});
	}

	#insertTask(task: KanbanTask): void {
		this.#db
			.prepare(`
				INSERT INTO kanban_tasks(
					id, session_id, status, position, title, description, assignee, labels_json, due_at, repo,
					worktree, branch, acceptance_criteria_json, blocker_reason, priority, version, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				task.id,
				task.sessionId,
				task.status,
				task.position,
				task.title,
				task.description,
				task.assignee,
				JSON.stringify(task.labels),
				task.dueAt,
				task.repo,
				task.worktree,
				task.branch,
				JSON.stringify(task.acceptanceCriteria),
				task.blockerReason,
				task.priority,
				task.version,
				task.createdAt,
				task.updatedAt,
			);
	}

	#recordActivity(
		sessionId: string,
		taskId: string | null,
		type: KanbanActivityType,
		data: Record<string, unknown>,
	): KanbanActivity {
		const id = this.#createId();
		const createdAt = this.#timestamp();
		const insert = this.#db
			.prepare(`
				INSERT INTO kanban_activity(id, session_id, task_id, type, created_at, data_json)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
			.run(id, sessionId, taskId, type, createdAt, JSON.stringify(data));
		const activity: KanbanActivity = {
			id,
			cursor: Number(insert.lastInsertRowid),
			sessionId,
			taskId,
			type,
			createdAt,
			data,
		};
		this.#db
			.prepare(`
				INSERT INTO kanban_outbox(event_id, cursor, session_id, payload_json, created_at, delivered_at)
				VALUES (?, ?, ?, ?, ?, NULL)
			`)
			.run(id, activity.cursor, sessionId, JSON.stringify(activity), createdAt);
		return activity;
	}

	#taskRow(sessionId: string, taskId: string): TaskRow | null {
		return this.#db
			.prepare("SELECT * FROM kanban_tasks WHERE id = ? AND session_id = ?")
			.get(taskId, sessionId) as TaskRow | null;
	}

	#commentRow(sessionId: string, taskId: string, commentId: string): CommentRow | null {
		return this.#db
			.prepare(`
				SELECT c.* FROM kanban_comments c
				JOIN kanban_tasks t ON t.id = c.task_id
				WHERE c.id = ? AND c.task_id = ? AND t.session_id = ?
			`)
			.get(commentId, taskId, sessionId) as CommentRow | null;
	}

	#columnTaskIds(sessionId: string, status: KanbanStatus): string[] {
		const rows = this.#db
			.prepare("SELECT id FROM kanban_tasks WHERE session_id = ? AND status = ? ORDER BY position, id")
			.all(sessionId, status) as Array<{ id: string }>;
		return rows.map(row => row.id);
	}

	#writeColumn(sessionId: string, status: KanbanStatus, ids: string[], now: string): void {
		const statement = this.#db.prepare(`
			UPDATE kanban_tasks
			SET status = ?, position = ?, version = version + 1, updated_at = ?
			WHERE id = ? AND session_id = ?
		`);
		for (const [position, id] of ids.entries()) {
			const result = statement.run(status, position, now, id, sessionId);
			if (result.changes !== 1) throw new Error("Kanban reorder lost a task inside its transaction");
		}
	}

	#taskFromRow(row: TaskRow): KanbanTask {
		return {
			id: row.id,
			sessionId: row.session_id,
			status: row.status as KanbanStatus,
			position: row.position,
			title: row.title,
			description: row.description,
			assignee: row.assignee,
			labels: parseStringArray(row.labels_json),
			dueAt: row.due_at,
			repo: row.repo,
			worktree: row.worktree,
			branch: row.branch,
			acceptanceCriteria: parseStringArray(row.acceptance_criteria_json),
			blockerReason: row.blocker_reason,
			priority: row.priority as KanbanPriority,
			version: row.version,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	#commentFromRow(row: CommentRow): KanbanComment {
		return {
			id: row.id,
			taskId: row.task_id,
			author: row.author,
			body: row.deleted_at ? "" : row.body,
			version: row.version,
			createdAt: row.created_at,
			editedAt: row.edited_at,
			deletedAt: row.deleted_at,
		};
	}

	#activityFromRow(row: ActivityRow): KanbanActivity {
		return {
			id: row.id,
			cursor: row.cursor,
			sessionId: row.session_id,
			taskId: row.task_id,
			type: row.type as KanbanActivityType,
			createdAt: row.created_at,
			data: parseRecord(row.data_json),
		};
	}

	#updatedValue<T extends KanbanTaskUpdate, K extends keyof T>(
		input: T,
		key: K,
		current: T[K] & (string | null),
		changedFields: string[],
	): T[K] & (string | null) {
		if (!Object.hasOwn(input, key)) return current;
		const next = input[key] as T[K] & (string | null);
		if (next !== current) changedFields.push(String(key));
		return next;
	}

	#updatedArray<T extends KanbanTaskUpdate, K extends "labels" | "acceptanceCriteria">(
		input: T,
		key: K,
		current: string[],
		changedFields: string[],
	): string[] {
		if (!Object.hasOwn(input, key)) return current;
		const next = input[key] ?? [];
		if (JSON.stringify(next) !== JSON.stringify(current)) changedFields.push(key);
		return [...next];
	}

	#timestamp(): string {
		return this.#now().toISOString();
	}
}
