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

async function createStore(): Promise<{ store: KanbanStore; dbPath: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-kanban-store-"));
	roots.push(root);
	const dbPath = path.join(root, "kanban.db");
	return { store: KanbanStore.open(dbPath), dbPath };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("KanbanStore", () => {
	it("applies migration 1 idempotently and reopens with WAL and foreign keys", async () => {
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

	it("persists task and comment CRUD while soft-deleting comment content", async () => {
		const { store, dbPath } = await createStore();
		const created = store.createTask(
			"session-a",
			{ ...task("Ship native board"), labels: ["backend"] },
			operation("task-create", "/api/v1/sessions/session-a/tasks", task("Ship native board")),
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
			operation("comment-create", `/api/v1/sessions/session-a/tasks/${created.data.id}/comments`, commentBody),
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

	it("reorders densely across columns and rolls back stale writes", async () => {
		const { store, dbPath } = await createStore();
		const first = store.createTask(
			"session-a",
			task("First"),
			operation("first", "/api/v1/sessions/session-a/tasks", task("First")),
		).data;
		store.createTask(
			"session-a",
			task("Second"),
			operation("second", "/api/v1/sessions/session-a/tasks", task("Second")),
		);
		const third = store.createTask(
			"session-a",
			task("Third"),
			operation("third", "/api/v1/sessions/session-a/tasks", task("Third")),
		).data;
		store.createTask(
			"session-a",
			task("Ready", "ready"),
			operation("ready", "/api/v1/sessions/session-a/tasks", task("Ready", "ready")),
		);

		const movedThird = store.moveTask(
			"session-a",
			third.id,
			{ expectedVersion: third.version, status: "backlog", index: 0 },
			operation("move-third", `/api/v1/sessions/session-a/tasks/${third.id}/moves`, {
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
			operation("move-first", `/api/v1/sessions/session-a/tasks/${first.id}/moves`, {
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
				operation("stale-move", `/api/v1/sessions/session-a/tasks/${first.id}/moves`, {
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
				.prepare("SELECT status, position FROM kanban_tasks WHERE session_id = ? ORDER BY status, position")
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

	it("replays canonical idempotent responses and persists outbox acknowledgement", async () => {
		const { store, dbPath } = await createStore();
		const input = task("Canonical");
		const route = "/api/v1/sessions/session-a/tasks";
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
