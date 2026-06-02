import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CONTEXT_GC_DB_VERSION } from "../src/schema";
import { type ContextGcStore, openContextGcStore } from "../src/storage";

let tempDir: string | undefined;
let store: ContextGcStore | undefined;

afterEach(() => {
	store?.close();
	store = undefined;
	if (tempDir) {
		fs.rmSync(tempDir, { force: true, recursive: true });
		tempDir = undefined;
	}
});

describe("ContextGcStore", () => {
	it("persists payloads and records across close and reopen", () => {
		const dbPath = makeDbPath();
		store = openContextGcStore({ dbPath });

		const payload = store.putPayload(
			"text/plain;charset=utf-8",
			"Full tool output that should not stay in LLM context.",
		);
		const record = store.upsertRecord({
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			source: {
				entryId: "message-1",
				toolCallId: "tool-call-1",
				toolName: "read",
				path: "src/file.ts",
			},
			kind: "file_read",
			payloadHash: payload.hash,
			artifactId: "artifact-1",
			sourceUri: "file://src/file.ts",
			summary: "Read src/file.ts",
			status: "unloaded",
			tokenEstimate: 12,
		});

		store.close();
		store = openContextGcStore({ dbPath });

		expect(store.getPayload(payload.hash)).toEqual(payload);
		expect(store.getRecord(record.id)).toEqual(record);
		expect(store.listRecords({ sessionId: "session-1", status: "unloaded" })).toEqual([record]);
		expect(readUserVersion(dbPath)).toBe(CONTEXT_GC_DB_VERSION);
	});

	it("updates status and recall counters without duplicating payload rows", () => {
		const dbPath = makeDbPath();
		store = openContextGcStore({ dbPath });

		const payload = store.putPayload(
			"text/plain;charset=utf-8",
			"A durable payload shared by record state transitions.",
		);
		const record = store.upsertRecord({
			sessionId: "session-2",
			sessionFile: null,
			source: { entryId: "message-2" },
			kind: "tool_result",
			payloadHash: payload.hash,
			summary: "Tool result summary",
		});

		expect(countPayloadRows(dbPath)).toBe(1);
		const unloaded = store.setStatus(record.id, "unloaded", "Compact unloaded summary");
		const recalled = store.incrementRecall(record.id);

		const reinventory = store.upsertRecord({
			id: record.id,
			sessionId: "session-2",
			sessionFile: null,
			source: { entryId: "message-2" },
			kind: "tool_result",
			payloadHash: payload.hash,
			summary: "Tool result summary after re-inventory",
			status: "unloaded",
			tokenEstimate: 17,
		});
		const pinned = store.setStatus(record.id, "pinned");

		expect(reinventory.recallCount).toBe(1);
		expect(reinventory.unloadedAt).toBe(recalled.unloadedAt);

		expect(countPayloadRows(dbPath)).toBe(1);
		expect(unloaded.payloadHash).toBe(payload.hash);
		expect(unloaded.status).toBe("unloaded");
		expect(unloaded.summary).toBe("Compact unloaded summary");
		expect(unloaded.unloadedAt).not.toBeNull();
		expect(recalled.recallCount).toBe(1);
		expect(pinned.payloadHash).toBe(payload.hash);
		expect(pinned.status).toBe("pinned");
	});

	it("stores structured payloads losslessly with a derived text projection", () => {
		store = openContextGcStore({ dbPath: makeDbPath() });
		const structured = JSON.stringify([
			{ type: "text", text: "header" },
			{ type: "image", data: "BASE64DATA", mimeType: "image/png" },
		]);
		const projection = "header\n[image:image/png]";

		const payload = store.putPayload("application/json;charset=utf-8", structured, projection);

		expect(payload.mediaType).toBe("application/json;charset=utf-8");
		expect(payload.text).toBe(structured);
		expect(payload.textProjection).toBe(projection);
		// Hash is keyed off the stored bytes so same-projection structured payloads remain distinct.
		expect(payload.hash).toBe(Bun.SHA256.hash(structured, "hex"));
		expect(store.getPayload(payload.hash)).toEqual(payload);

		const otherStructured = JSON.stringify([
			{ type: "text", text: "header" },
			{ type: "image", data: "DIFFERENT_BASE64DATA", mimeType: "image/png" },
		]);
		const otherPayload = store.putPayload("application/json;charset=utf-8", otherStructured, projection);
		expect(otherPayload.hash).not.toBe(payload.hash);
		expect(store.getPayload(otherPayload.hash)?.text).toBe(otherStructured);
	});

	it("migrates legacy v1 payload tables by backfilling text_projection", () => {
		const dbPath = makeDbPath();
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const legacy = new Database(dbPath, { create: true, strict: true });
		legacy.run(`
			CREATE TABLE context_gc_payloads (
				hash TEXT PRIMARY KEY,
				media_type TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				text TEXT NOT NULL,
				created_at TEXT NOT NULL
			)
		`);
		legacy.run(
			`INSERT INTO context_gc_payloads (hash, media_type, byte_length, text, created_at)
			 VALUES ('h1', 'text/plain;charset=utf-8', 6, 'legacy', '2026-01-01T00:00:00.000Z')`,
		);
		legacy.run("PRAGMA user_version = 1");
		legacy.close();

		store = openContextGcStore({ dbPath });
		const payload = store.getPayload("h1");
		expect(payload?.text).toBe("legacy");
		expect(payload?.textProjection).toBe("legacy");
		expect(readUserVersion(dbPath)).toBe(CONTEXT_GC_DB_VERSION);
	});

	it("migrates v1 record tables by adding session_file", () => {
		const dbPath = makeDbPath();
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const legacy = new Database(dbPath, { create: true, strict: true });
		legacy.run(`
			CREATE TABLE context_gc_payloads (
				hash TEXT PRIMARY KEY,
				media_type TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				text TEXT NOT NULL,
				text_projection TEXT NOT NULL,
				created_at TEXT NOT NULL
			)
		`);
		legacy.run(`
			CREATE TABLE context_gc_records (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				status TEXT NOT NULL,
				kind TEXT NOT NULL,
				source_json TEXT NOT NULL,
				payload_hash TEXT NOT NULL REFERENCES context_gc_payloads(hash) ON DELETE RESTRICT,
				artifact_id TEXT,
				source_uri TEXT,
				summary TEXT NOT NULL,
				token_estimate INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				unloaded_at TEXT,
				recall_count INTEGER NOT NULL DEFAULT 0
			)
		`);
		legacy.run(
			`INSERT INTO context_gc_payloads (hash, media_type, byte_length, text, text_projection, created_at)
			 VALUES ('h2', 'text/plain;charset=utf-8', 7, 'legacy2', 'legacy2', '2026-01-01T00:00:00.000Z')`,
		);
		legacy.run(
			`INSERT INTO context_gc_records
				(id, session_id, status, kind, source_json, payload_hash, artifact_id, source_uri, summary,
					token_estimate, created_at, updated_at, unloaded_at, recall_count)
			 VALUES ('r2', 'session-v1', 'candidate', 'tool_result', '{"toolName":"read"}', 'h2', NULL, NULL,
				'legacy record', 4, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', NULL, 0)`,
		);
		legacy.close();

		store = openContextGcStore({ dbPath });

		expect(store.getRecord("r2")?.sessionFile).toBeNull();
		const payload = store.putPayload("text/plain;charset=utf-8", "new payload");
		const next = store.upsertRecord({
			sessionId: "session-v1",
			sessionFile: "/tmp/session.jsonl",
			source: { toolName: "read" },
			kind: "tool_result",
			payloadHash: payload.hash,
			summary: "new record",
		});
		expect(next.sessionFile).toBe("/tmp/session.jsonl");
	});

	it("migrates legacy pre-structured schema with content columns", () => {
		const dbPath = makeDbPath();
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const legacy = new Database(dbPath, { create: true, strict: true });
		legacy.run(`
			CREATE TABLE context_gc_payloads (
				payload_hash TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				content_type TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				created_at TEXT NOT NULL
			)
		`);
		legacy.run(`
			CREATE TABLE context_gc_records (
				record_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				source_json TEXT NOT NULL,
				payload_hash TEXT NOT NULL REFERENCES context_gc_payloads(payload_hash) ON DELETE RESTRICT,
				summary TEXT NOT NULL,
				status TEXT NOT NULL,
				policy TEXT NOT NULL,
				token_count INTEGER,
				recalled_count INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				unloaded_at TEXT
			)
		`);
		legacy.run(
			`INSERT INTO context_gc_payloads (payload_hash, content, content_type, byte_length, created_at)
			 VALUES ('legacy-hash', 'legacy payload', 'text/plain;charset=utf-8', 14, '2026-01-01T00:00:00.000Z')`,
		);
		legacy.run(
			`INSERT INTO context_gc_records
				(record_id, session_id, kind, source_json, payload_hash, summary, status, policy, token_count,
					recalled_count, created_at, updated_at, unloaded_at)
			 VALUES ('legacy-record', 'session-legacy', 'tool-result', '{"toolName":"read"}', 'legacy-hash',
				'legacy summary', 'active', 'auto', 3, 2, '2026-01-01T00:00:00.000Z',
				'2026-01-01T00:00:01.000Z', NULL)`,
		);
		legacy.close();

		store = openContextGcStore({ dbPath });

		expect(store.getPayload("legacy-hash")).toMatchObject({
			hash: "legacy-hash",
			mediaType: "text/plain;charset=utf-8",
			text: "legacy payload",
			textProjection: "legacy payload",
		});
		expect(store.getRecord("legacy-record")).toMatchObject({
			id: "legacy-record",
			sessionId: "session-legacy",
			status: "candidate",
			kind: "tool_result",
			payloadHash: "legacy-hash",
			summary: "legacy summary",
			tokenEstimate: 3,
			recallCount: 2,
		});
	});

	it("computes uncapped aggregate totals for database and one session", () => {
		store = openContextGcStore({ dbPath: makeDbPath() });
		const payload = store.putPayload("text/plain;charset=utf-8", "payload");
		store.upsertRecord({
			id: "s1-a",
			sessionId: "session-aggregate",
			kind: "tool_result",
			status: "candidate",
			source: {},
			payloadHash: payload.hash,
			summary: "candidate summary",
			tokenEstimate: 11,
			recallCount: 2,
		});
		store.upsertRecord({
			id: "s1-b",
			sessionId: "session-aggregate",
			kind: "file_read",
			status: "unloaded",
			source: {},
			payloadHash: payload.hash,
			summary: "unloaded summary",
			tokenEstimate: 7,
			recallCount: 1,
		});
		store.upsertRecord({
			id: "s2-a",
			sessionId: "other-session",
			kind: "file_read",
			status: "pinned",
			source: {},
			payloadHash: payload.hash,
			summary: "pinned summary",
			tokenEstimate: 5,
			recallCount: 4,
		});

		const sessionAggregate = store.getAggregateTotals({ sessionId: "session-aggregate" });
		const databaseAggregate = store.getAggregateTotals();

		expect(sessionAggregate.records).toBe(2);
		expect(sessionAggregate.tokens).toBe(18);
		expect(sessionAggregate.recallCount).toBe(3);
		expect(sessionAggregate.byStatus.map(bucket => [bucket.key, bucket.records, bucket.tokens])).toEqual([
			["candidate", 1, 11],
			["unloaded", 1, 7],
		]);
		expect(databaseAggregate.records).toBe(3);
		expect(databaseAggregate.tokens).toBe(23);
		expect(databaseAggregate.recallCount).toBe(7);
	});
});

function makeDbPath(): string {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-gc-storage-"));
	return path.join(tempDir, "nested", "context-gc.sqlite");
}

function countPayloadRows(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_gc_payloads").get();
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

function readUserVersion(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
		return row?.user_version ?? 0;
	} finally {
		db.close();
	}
}
