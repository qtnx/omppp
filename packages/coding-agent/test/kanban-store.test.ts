import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KanbanError } from "@oh-my-pi/pi-coding-agent/kanban/errors";
import {
	KANBAN_SCHEMA_VERSION,
	type KanbanIdempotencyOperation,
	KanbanStore,
	type KanbanStoreOptions,
} from "@oh-my-pi/pi-coding-agent/kanban/store";
import type { KanbanTaskCreate } from "@oh-my-pi/pi-coding-agent/kanban/types";

const roots: string[] = [];

function task(title: string, status: KanbanTaskCreate["status"] = "backlog"): KanbanTaskCreate {
	return {
		title,
		status,
		priority: "medium",
		description: null,
		assignee: null,
		labels: [],
		dueAt: null,
	};
}

function operation(key: string, route: string, body: unknown): KanbanIdempotencyOperation {
	return { key, method: "POST", route, body };
}

async function createStore(options: KanbanStoreOptions = {}): Promise<{ store: KanbanStore; dbPath: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-kanban-store-"));
	roots.push(root);
	const dbPath = path.join(root, "kanban.db");
	return { store: KanbanStore.open(dbPath, options), dbPath };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("KanbanStore", () => {
	it("applies schema migrations idempotently and reopens with WAL and foreign keys", async () => {
		const { store, dbPath } = await createStore();
		expect(store.schemaVersion()).toBe(KANBAN_SCHEMA_VERSION);
		expect(store.foreignKeysEnabled()).toBe(true);
		store.close();

		const reopened = KanbanStore.open(dbPath);
		expect(reopened.schemaVersion()).toBe(KANBAN_SCHEMA_VERSION);
		reopened.close();

		const db = new Database(dbPath, { readonly: true });
		try {
			const migrations = db.prepare("SELECT version FROM kanban_schema_migrations ORDER BY version").all();
			expect(migrations).toEqual([{ version: KANBAN_SCHEMA_VERSION }]);
			expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
		} finally {
			db.close();
		}
	});

	it("allocates monotonic short task ids per board", async () => {
		const { store } = await createStore();
		try {
			const first = store.createTask("board-a", task("First"), operation("create-a1", "/tasks", task("First"))).data;
			const second = store.createTask(
				"board-a",
				task("Second"),
				operation("create-a2", "/tasks", task("Second")),
			).data;
			const otherBoard = store.createTask(
				"board-b",
				task("Other"),
				operation("create-b1", "/tasks", task("Other")),
			).data;

			expect(first.shortId).toBe(1);
			expect(second.shortId).toBe(2);
			expect(otherBoard.shortId).toBe(1);
		} finally {
			store.close();
		}
	});

	it("does not reissue a short id after deleting the newest task", async () => {
		const { store } = await createStore();
		try {
			const first = store.createTask("board-a", task("First"), operation("create-a1", "/tasks", task("First"))).data;
			const second = store.createTask(
				"board-a",
				task("Second"),
				operation("create-a2", "/tasks", task("Second")),
			).data;
			const newest = store.createTask(
				"board-a",
				task("Third"),
				operation("create-a3", "/tasks", task("Third")),
			).data;

			store.deleteTask("board-a", newest.id, { expectedVersion: newest.version });
			const replacement = store.createTask(
				"board-a",
				task("Replacement"),
				operation("create-a4", "/tasks", task("Replacement")),
			).data;

			expect(replacement.shortId).toBe(4);
			expect(new Set([first.shortId, second.shortId, replacement.shortId]).size).toBe(3);
		} finally {
			store.close();
		}
	});

	it("does not reissue a short id after deleting every task on a board", async () => {
		const { store } = await createStore();
		try {
			const first = store.createTask("board-a", task("First"), operation("create-a1", "/tasks", task("First"))).data;
			const second = store.createTask(
				"board-a",
				task("Second"),
				operation("create-a2", "/tasks", task("Second")),
			).data;

			store.deleteTask("board-a", second.id, { expectedVersion: second.version });
			store.deleteTask("board-a", first.id, { expectedVersion: first.version });
			const replacement = store.createTask(
				"board-a",
				task("Replacement"),
				operation("create-a3", "/tasks", task("Replacement")),
			).data;

			expect(replacement.shortId).toBe(3);
			expect(replacement.shortId).not.toBe(1);
		} finally {
			store.close();
		}
	});

	it("keeps short-id allocation after reopening a board database", async () => {
		const { store, dbPath } = await createStore();
		try {
			store.createTask("board-a", task("First"), operation("create-a1", "/tasks", task("First")));
			store.createTask("board-a", task("Second"), operation("create-a2", "/tasks", task("Second")));
		} finally {
			store.close();
		}

		const reopened = KanbanStore.open(dbPath);
		try {
			const third = reopened.createTask(
				"board-a",
				task("Third"),
				operation("create-a3", "/tasks", task("Third")),
			).data;
			expect(third.shortId).toBe(3);
		} finally {
			reopened.close();
		}
	});

	it("backfills legacy task short ids by board creation order without repeating the migration", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-kanban-store-"));
		roots.push(root);
		const dbPath = path.join(root, "kanban.db");
		const legacy = new Database(dbPath);
		try {
			legacy.exec(`
				CREATE TABLE kanban_schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at TEXT NOT NULL
				);
				INSERT INTO kanban_schema_migrations(version, applied_at) VALUES (3, '2026-01-01T00:00:00.000Z');
				CREATE TABLE kanban_tasks (
					id TEXT PRIMARY KEY,
					board_id TEXT NOT NULL,
					status TEXT NOT NULL,
					position INTEGER NOT NULL,
					title TEXT NOT NULL,
					description TEXT,
					assignee TEXT,
					labels_json TEXT NOT NULL,
					due_at TEXT,
					priority TEXT NOT NULL,
					version INTEGER NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
			`);
			const insert = legacy.prepare(`
				INSERT INTO kanban_tasks(
					id, board_id, status, position, title, description, assignee, labels_json, due_at,
					priority, version, created_at, updated_at
				) VALUES (?, ?, 'backlog', 0, ?, NULL, NULL, '[]', NULL, 'medium', 1, ?, ?)
			`);
			insert.run("task-first", "board-a", "First", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
			insert.run("task-second-a", "board-a", "Second", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
			insert.run("task-second-b", "board-a", "Third", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
			insert.run("task-other-board", "board-b", "Other", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
		} finally {
			legacy.close();
		}

		const migrated = KanbanStore.open(dbPath);
		try {
			expect(migrated.getTask("board-a", "task-first").shortId).toBe(1);
			expect(migrated.getTask("board-a", "task-second-a").shortId).toBe(2);
			expect(migrated.getTask("board-a", "task-second-b").shortId).toBe(3);
			expect(migrated.getTask("board-b", "task-other-board").shortId).toBe(1);
		} finally {
			migrated.close();
		}

		const reopened = KanbanStore.open(dbPath);
		try {
			expect(reopened.getTask("board-a", "task-second-b").shortId).toBe(3);
		} finally {
			reopened.close();
		}

		const db = new Database(dbPath, { readonly: true });
		try {
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_tasks WHERE short_id IS NULL").get()).toEqual({
				count: 0,
			});
			expect(
				db
					.prepare("SELECT COUNT(*) AS count FROM kanban_schema_migrations WHERE version = ?")
					.get(KANBAN_SCHEMA_VERSION),
			).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it("backfills cached legacy task mutation responses with short ids", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-kanban-store-"));
		roots.push(root);
		const dbPath = path.join(root, "kanban.db");
		const createdAt = "2026-01-01T00:00:00.000Z";
		const route = "/api/v1/boards/board-a/tasks";
		const body = { title: "First", status: "backlog", priority: "medium" };
		const requestHash = new Bun.CryptoHasher("sha256")
			.update(`POST\n${route}\n{"priority":"medium","status":"backlog","title":"First"}`)
			.digest("hex");
		const legacy = new Database(dbPath);
		try {
			legacy.exec(`
				CREATE TABLE kanban_schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at TEXT NOT NULL
				);
				INSERT INTO kanban_schema_migrations(version, applied_at) VALUES (3, '${createdAt}');
				CREATE TABLE kanban_tasks (
					id TEXT PRIMARY KEY,
					board_id TEXT NOT NULL,
					status TEXT NOT NULL,
					position INTEGER NOT NULL,
					title TEXT NOT NULL,
					description TEXT,
					assignee TEXT,
					labels_json TEXT NOT NULL,
					due_at TEXT,
					priority TEXT NOT NULL,
					version INTEGER NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE TABLE kanban_idempotency (
					board_id TEXT NOT NULL,
					idempotency_key TEXT NOT NULL,
					request_hash TEXT NOT NULL,
					method TEXT NOT NULL,
					route TEXT NOT NULL,
					status INTEGER NOT NULL,
					response_json TEXT NOT NULL,
					created_at TEXT NOT NULL,
					PRIMARY KEY (board_id, idempotency_key)
				);
			`);
			legacy
				.prepare(`
					INSERT INTO kanban_tasks(
						id, board_id, status, position, title, description, assignee, labels_json, due_at,
						priority, version, created_at, updated_at
					) VALUES (?, ?, 'backlog', 0, ?, NULL, NULL, '[]', NULL, 'medium', 1, ?, ?)
				`)
				.run("task-first", "board-a", "First", createdAt, createdAt);
			legacy
				.prepare(`
					INSERT INTO kanban_idempotency(
						board_id, idempotency_key, request_hash, method, route, status, response_json, created_at
					) VALUES (?, ?, ?, 'POST', ?, 201, ?, ?)
				`)
				.run(
					"board-a",
					"legacy-key",
					requestHash,
					route,
					JSON.stringify({
						data: {
							id: "task-first",
							boardId: "board-a",
							status: "backlog",
							position: 0,
							title: "First",
							description: null,
							assignee: null,
							labels: [],
							dueAt: null,
							priority: "medium",
							version: 1,
							createdAt,
							updatedAt: createdAt,
							commentCount: 0,
						},
					}),
					createdAt,
				);
		} finally {
			legacy.close();
		}

		const migrated = KanbanStore.open(dbPath);
		try {
			const replay = migrated.createTask("board-a", task("First"), operation("legacy-key", route, body));
			expect(replay).toMatchObject({ replayed: true, data: { id: "task-first", shortId: 1 } });
		} finally {
			migrated.close();
		}
	});

	it("backfills short ids into legacy activity task snapshots", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-kanban-store-"));
		roots.push(root);
		const dbPath = path.join(root, "kanban.db");
		const createdAt = "2026-01-01T00:00:00.000Z";
		const legacy = new Database(dbPath);
		try {
			legacy.exec(`
				CREATE TABLE kanban_schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at TEXT NOT NULL
				);
				INSERT INTO kanban_schema_migrations(version, applied_at) VALUES (3, '${createdAt}');
				CREATE TABLE kanban_tasks (
					id TEXT PRIMARY KEY,
					board_id TEXT NOT NULL,
					status TEXT NOT NULL,
					position INTEGER NOT NULL,
					title TEXT NOT NULL,
					description TEXT,
					assignee TEXT,
					labels_json TEXT NOT NULL,
					due_at TEXT,
					priority TEXT NOT NULL,
					version INTEGER NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE TABLE kanban_activity (
					cursor INTEGER PRIMARY KEY AUTOINCREMENT,
					id TEXT NOT NULL UNIQUE,
					board_id TEXT NOT NULL,
					task_id TEXT,
					type TEXT NOT NULL,
					created_at TEXT NOT NULL,
					data_json TEXT NOT NULL
				);
			`);
			legacy
				.prepare(`
					INSERT INTO kanban_tasks(
						id, board_id, status, position, title, description, assignee, labels_json, due_at,
						priority, version, created_at, updated_at
					) VALUES (?, ?, 'backlog', 0, ?, NULL, NULL, '[]', NULL, 'medium', 1, ?, ?)
				`)
				.run("task-first", "board-a", "First", createdAt, createdAt);
			legacy
				.prepare(`
					INSERT INTO kanban_activity(id, board_id, task_id, type, created_at, data_json)
					VALUES (?, ?, ?, 'task.created', ?, ?)
				`)
				.run(
					"activity-first",
					"board-a",
					"task-first",
					createdAt,
					JSON.stringify({
						task: {
							id: "task-first",
							boardId: "board-a",
							title: "First",
						},
					}),
				);
		} finally {
			legacy.close();
		}

		const migrated = KanbanStore.open(dbPath);
		try {
			expect(migrated.getTask("board-a", "task-first").shortId).toBe(1);
			expect(migrated.getBoard("board-a").activity).toEqual([
				expect.objectContaining({
					id: "activity-first",
					data: { task: { id: "task-first", boardId: "board-a", title: "First", shortId: 1 } },
				}),
			]);
		} finally {
			migrated.close();
		}

		const db = new Database(dbPath, { readonly: true });
		try {
			const activity = db.prepare("SELECT data_json FROM kanban_activity WHERE id = ?").get("activity-first") as {
				data_json: string;
			};
			expect(JSON.parse(activity.data_json)).toEqual({
				task: { id: "task-first", boardId: "board-a", title: "First", shortId: 1 },
			});
		} finally {
			db.close();
		}
	});

	it("tracks live board sessions without duplicates and excludes stale or removed sessions", async () => {
		let now = new Date("2026-01-01T00:00:00.000Z");
		const { store } = await createStore({ now: () => now });
		const boardId = "project-board";
		try {
			store.upsertSession(boardId, "session-a", "swift-otter");
			now = new Date("2026-01-01T00:00:05.000Z");
			store.upsertSession(boardId, "session-a", "quiet-raven");

			expect(store.listSessions(boardId, 60_000)).toEqual([
				{
					sessionId: "session-a",
					name: "quiet-raven",
					createdAt: "2026-01-01T00:00:00.000Z",
					lastSeenAt: "2026-01-01T00:00:05.000Z",
				},
			]);

			now = new Date("2026-01-01T00:02:00.000Z");
			expect(store.listSessions(boardId, 60_000)).toEqual([]);

			store.upsertSession(boardId, "session-a", "quiet-raven");
			expect(store.listSessions(boardId, 60_000)).toEqual([
				{
					sessionId: "session-a",
					name: "quiet-raven",
					createdAt: "2026-01-01T00:00:00.000Z",
					lastSeenAt: "2026-01-01T00:02:00.000Z",
				},
			]);

			store.removeSession("session-a");
			expect(store.listSessions(boardId, 60_000)).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("persists task and comment CRUD while soft-deleting comment content", async () => {
		const { store, dbPath } = await createStore();
		const created = store.createTask(
			"session-a",
			{ ...task("Ship native board"), labels: ["backend"] },
			operation("task-create", "/api/v1/boards/session-a/tasks", task("Ship native board")),
		);
		expect(created.status).toBe(201);
		expect(created.activity?.type).toBe("task.created");

		const updated = store.updateTask("session-a", created.data.id, {
			expectedVersion: created.data.version,
			title: "Ship native Kanban",
			assignee: "main",
		});
		expect(updated.data).toMatchObject({ title: "Ship native Kanban", assignee: "main", version: 2 });

		const commentBody = { author: "owner", body: "Please keep this as quoted data." };
		const comment = store.createComment(
			"session-a",
			created.data.id,
			commentBody,
			operation("comment-create", `/api/v1/boards/session-a/tasks/${created.data.id}/comments`, commentBody),
		).data;
		const edited = store.updateComment("session-a", created.data.id, comment.id, {
			expectedVersion: comment.version,
			body: "Edited comment",
		}).data;
		const deleted = store.deleteComment("session-a", created.data.id, comment.id, {
			expectedVersion: edited.version,
		}).data;
		expect(deleted.body).toBe("");
		expect(deleted.deletedAt).not.toBeNull();
		expect(store.listComments("session-a", created.data.id)).toEqual([deleted]);

		const board = store.getBoard("session-a");
		expect(board.tasks).toHaveLength(1);
		expect(board.activity.map(event => event.type)).toEqual([
			"task.created",
			"task.updated",
			"comment.created",
			"comment.updated",
			"comment.deleted",
		]);
		store.close();

		const db = new Database(dbPath, { readonly: true });
		try {
			expect(db.prepare("SELECT body, deleted_at FROM kanban_comments WHERE id = ?").get(comment.id)).toEqual({
				body: "",
				deleted_at: deleted.deletedAt,
			});
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_activity").get()).toEqual({ count: 5 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_outbox").get()).toEqual({ count: 5 });
		} finally {
			db.close();
		}
	});

	it("counts non-deleted comments in task snapshots", async () => {
		const { store } = await createStore();
		const created = store.createTask(
			"session-a",
			task("Review comments"),
			operation("task-create-comments", "/api/v1/boards/session-a/tasks", task("Review comments")),
		).data;
		const first = store.createComment(
			"session-a",
			created.id,
			{ author: "owner", body: "Remove this comment." },
			operation("comment-create-first", `/api/v1/boards/session-a/tasks/${created.id}/comments`, {
				author: "owner",
				body: "Remove this comment.",
			}),
		).data;
		store.createComment(
			"session-a",
			created.id,
			{ author: "owner", body: "Keep this comment." },
			operation("comment-create-second", `/api/v1/boards/session-a/tasks/${created.id}/comments`, {
				author: "owner",
				body: "Keep this comment.",
			}),
		);
		store.deleteComment("session-a", created.id, first.id, { expectedVersion: first.version });

		expect(store.getBoard("session-a").tasks).toEqual([expect.objectContaining({ id: created.id, commentCount: 1 })]);
		store.close();
	});

	it("reorders densely across columns and rolls back stale writes", async () => {
		const { store, dbPath } = await createStore();
		const first = store.createTask(
			"session-a",
			task("First"),
			operation("first", "/api/v1/boards/session-a/tasks", task("First")),
		).data;
		store.createTask(
			"session-a",
			task("Second"),
			operation("second", "/api/v1/boards/session-a/tasks", task("Second")),
		);
		const third = store.createTask(
			"session-a",
			task("Third"),
			operation("third", "/api/v1/boards/session-a/tasks", task("Third")),
		).data;
		store.createTask(
			"session-a",
			task("Ready", "ready"),
			operation("ready", "/api/v1/boards/session-a/tasks", task("Ready", "ready")),
		);

		const movedThird = store.moveTask(
			"session-a",
			third.id,
			{ expectedVersion: third.version, status: "backlog", index: 0 },
			operation("move-third", `/api/v1/boards/session-a/tasks/${third.id}/moves`, {
				expectedVersion: third.version,
				status: "backlog",
				index: 0,
			}),
		).data;
		expect(movedThird).toMatchObject({ status: "backlog", position: 0 });
		expect(
			store
				.getBoard("session-a")
				.tasks.filter(item => item.status === "backlog")
				.map(item => [item.title, item.position]),
		).toEqual([
			["Third", 0],
			["First", 1],
			["Second", 2],
		]);

		const latestFirst = store.getTask("session-a", first.id);
		const movedFirst = store.moveTask(
			"session-a",
			first.id,
			{ expectedVersion: latestFirst.version, status: "ready", index: 1 },
			operation("move-first", `/api/v1/boards/session-a/tasks/${first.id}/moves`, {
				expectedVersion: latestFirst.version,
				status: "ready",
				index: 1,
			}),
		).data;
		expect(movedFirst).toMatchObject({ status: "ready", position: 1 });

		const before = store.getBoard("session-a");
		expect(() =>
			store.moveTask(
				"session-a",
				first.id,
				{ expectedVersion: latestFirst.version, status: "done", index: 0 },
				operation("stale-move", `/api/v1/boards/session-a/tasks/${first.id}/moves`, {
					expectedVersion: latestFirst.version,
					status: "done",
					index: 0,
				}),
			),
		).toThrow(KanbanError);
		expect(store.getBoard("session-a")).toEqual(before);
		store.close();

		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db
				.prepare("SELECT status, position FROM kanban_tasks WHERE board_id = ? ORDER BY status, position")
				.all("session-a") as Array<{ status: string; position: number }>;
			for (const status of new Set(rows.map(row => row.status))) {
				expect(rows.filter(row => row.status === status).map(row => row.position)).toEqual(
					rows.filter(row => row.status === status).map((_, index) => index),
				);
			}
		} finally {
			db.close();
		}
	});

	it("does not claim an unassigned task without an explicit claim value", async () => {
		const { store } = await createStore();
		const created = store.createTask(
			"session-a",
			task("HTTP move"),
			operation("http-move-create", "/api/v1/boards/session-a/tasks", task("HTTP move")),
		).data;

		const moved = store.moveTask(
			"session-a",
			created.id,
			{ expectedVersion: created.version, status: "in_progress", index: 0 },
			operation("http-move", `/api/v1/boards/session-a/tasks/${created.id}/moves`, {
				expectedVersion: created.version,
				status: "in_progress",
				index: 0,
			}),
		).data;

		expect(moved).toMatchObject({ status: "in_progress", assignee: null, version: 2 });
		store.close();
	});

	it("does not claim a task when moving it outside in_progress", async () => {
		const { store } = await createStore();
		const created = store.createTask(
			"session-a",
			task("Review move"),
			operation("review-move-create", "/api/v1/boards/session-a/tasks", task("Review move")),
		).data;

		const moved = store.moveTask(
			"session-a",
			created.id,
			{ expectedVersion: created.version, status: "review", index: 0 },
			operation("review-move", `/api/v1/boards/session-a/tasks/${created.id}/moves`, {
				expectedVersion: created.version,
				status: "review",
				index: 0,
			}),
			{ claimBy: "swift-otter" },
		);

		expect(moved.data).toMatchObject({ status: "review", assignee: null, version: 2 });
		expect(moved.activity?.data).toMatchObject({ task: expect.objectContaining({ assignee: null }) });
		store.close();
	});

	it("replays canonical idempotent responses and persists outbox acknowledgement", async () => {
		const { store, dbPath } = await createStore();
		const input = task("Canonical");
		const route = "/api/v1/boards/session-a/tasks";
		const first = store.createTask(
			"session-a",
			input,
			operation("same-key", route, { title: "Canonical", status: "backlog", priority: "medium" }),
		);
		const replay = store.createTask(
			"session-a",
			input,
			operation("same-key", route, { priority: "medium", status: "backlog", title: "Canonical" }),
		);
		expect(replay).toMatchObject({ status: 201, data: first.data, replayed: true, activity: null });
		expect(() =>
			store.createTask(
				"session-a",
				task("Different"),
				operation("same-key", route, { title: "Different", status: "backlog", priority: "medium" }),
			),
		).toThrow(KanbanError);

		const firstActivity = first.activity;
		if (!firstActivity) throw new Error("Create-task activity was missing");
		const pending = store.listUndelivered("session-a");
		expect(pending).toHaveLength(1);
		store.close();

		const reopened = KanbanStore.open(dbPath);
		expect(reopened.listUndelivered("session-a").map(event => event.id)).toEqual([firstActivity.id]);
		reopened.markDelivered("session-a", firstActivity.id);
		reopened.close();

		const db = new Database(dbPath, { readonly: true });
		try {
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_tasks").get()).toEqual({ count: 1 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_activity").get()).toEqual({ count: 1 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_outbox").get()).toEqual({ count: 1 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM kanban_idempotency").get()).toEqual({ count: 1 });
			expect(db.prepare("SELECT delivered_at IS NOT NULL AS delivered FROM kanban_outbox").get()).toEqual({
				delivered: 1,
			});
		} finally {
			db.close();
		}
	});
});
