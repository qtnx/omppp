import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import {
	CONTEXT_GC_DB_VERSION,
	type ContextKind,
	type ContextPayload,
	type ContextRecord,
	type ContextSource,
	type ContextStatus,
	contextKindSchema,
	contextStatusSchema,
} from "./schema";

export interface OpenContextGcStoreOptions {
	dbPath?: string;
}

export interface UpsertRecordInput {
	id?: string;
	sessionId: string;
	sessionFile?: string | null;
	status?: ContextStatus;
	kind: ContextKind;
	source: ContextSource;
	payloadHash: string;
	artifactId?: string | null;
	sourceUri?: string | null;
	summary: string;
	tokenEstimate?: number;
	createdAt?: string;
	updatedAt?: string;
	unloadedAt?: string | null;
	recallCount?: number;
}

export interface ListRecordsFilter {
	sessionId?: string;
	status?: ContextStatus;
	includePinned?: boolean;
	limit?: number;
}

export interface ContextGcAggregateScope {
	sessionId?: string;
}

export interface ContextGcAggregateBucket {
	key: string;
	records: number;
	tokens: number;
	recallCount: number;
}

export interface ContextGcAggregateTotals {
	records: number;
	tokens: number;
	recallCount: number;
	byStatus: ContextGcAggregateBucket[];
	byKind: ContextGcAggregateBucket[];
}

export interface ContextGcGlobalStats {
	sessions: number;
	payloads: number;
	payloadBytes: number;
	totals: ContextGcAggregateTotals;
}

interface PayloadRow {
	hash: string;
	media_type: string;
	byte_length: number;
	text: string;
	text_projection: string;
	created_at: string;
}

interface RecordRow {
	id: string;
	session_id: string;
	session_file: string | null;
	status: string;
	kind: string;
	source_json: string;
	payload_hash: string;
	artifact_id: string | null;
	source_uri: string | null;
	summary: string;
	token_estimate: number;
	created_at: string;
	updated_at: string;
	unloaded_at: string | null;
	recall_count: number;
}

interface ColumnInfo {
	name: string;
}

interface LegacyPayloadRow {
	payload_hash: string;
	content: string;
	content_type: string;
	byte_length: number;
	created_at: string;
	text_projection?: string | null;
}

interface LegacyRecordRow {
	record_id: string;
	session_id: string;
	kind: string;
	source_json: string;
	payload_hash: string;
	source_uri?: string | null;
	summary: string;
	status: string;
	policy?: string | null;
	token_count?: number | null;
	created_at: string;
	updated_at: string;
	unloaded_at?: string | null;
	recalled_count?: number | null;
}

export function getContextGcDbPath(agentDir: string): string {
	return path.join(agentDir, "context-gc.sqlite");
}

export function getDefaultDbPath(): string {
	return getContextGcDbPath(getAgentDir());
}

export function openContextGcStore(options: OpenContextGcStoreOptions = {}): ContextGcStore {
	return new ContextGcStore(options.dbPath ?? getDefaultDbPath());
}

export class ContextGcStore {
	#db: Database;
	#closed = false;

	constructor(readonly dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath, { create: true, strict: true });
		this.#migrate();
	}

	/**
	 * Persist a payload. `text` is the canonical stored representation (structured JSON for
	 * image-bearing content, plain text otherwise). `textProjection` is the plain-text view
	 * used for summaries/search/range and for projection-hash matching; it defaults to `text`
	 * for text-only payloads. The payload is keyed by the hash of the stored bytes so structured
	 * payloads with identical text projections cannot alias each other.
	 */
	putPayload(mediaType: string, text: string, textProjection?: string): ContextPayload {
		this.#assertOpen();
		const projection = textProjection ?? text;
		const hash = hashPayload(text);
		const createdAt = nowIso();
		const byteLength = Buffer.byteLength(text, "utf8");

		this.#db
			.query(`
				INSERT INTO context_gc_payloads (hash, media_type, byte_length, text, text_projection, created_at)
				VALUES ($hash, $mediaType, $byteLength, $text, $textProjection, $createdAt)
				ON CONFLICT(hash) DO NOTHING
			`)
			.run({ hash, mediaType, byteLength, text, textProjection: projection, createdAt });

		const payload = this.getPayload(hash);
		if (!payload) {
			throw new Error(`Context GC payload was not persisted: ${hash}`);
		}
		return payload;
	}

	getPayload(hash: string): ContextPayload | null {
		this.#assertOpen();
		const row = this.#db
			.query<PayloadRow, { hash: string }>(`
				SELECT hash, media_type, byte_length, text, text_projection, created_at
				FROM context_gc_payloads
				WHERE hash = $hash
			`)
			.get({ hash });
		return row ? payloadFromRow(row) : null;
	}

	upsertRecord(input: UpsertRecordInput): ContextRecord {
		this.#assertOpen();
		contextKindSchema.parse(input.kind);
		const status = contextStatusSchema.parse(input.status ?? "candidate");
		const now = nowIso();
		const id = input.id ?? crypto.randomUUID();
		const createdAt = input.createdAt ?? now;
		const updatedAt = input.updatedAt ?? now;
		const unloadedAt = status === "unloaded" ? (input.unloadedAt ?? updatedAt) : (input.unloadedAt ?? null);
		const recallCount = Math.max(0, Math.trunc(input.recallCount ?? 0));
		const updateUnloadedAt = input.unloadedAt !== undefined;
		const updateRecallCount = input.recallCount !== undefined;

		this.#db
			.query(`
				INSERT INTO context_gc_records (
					id, session_id, session_file, status, kind, source_json, payload_hash,
					artifact_id, source_uri, summary, token_estimate, created_at, updated_at,
					unloaded_at, recall_count
				)
				VALUES (
					$id, $sessionId, $sessionFile, $status, $kind, $sourceJson, $payloadHash,
					$artifactId, $sourceUri, $summary, $tokenEstimate, $createdAt, $updatedAt,
					$unloadedAt, $recallCount
				)
				ON CONFLICT(id) DO UPDATE SET
					session_id = excluded.session_id,
					session_file = excluded.session_file,
					status = excluded.status,
					kind = excluded.kind,
					source_json = excluded.source_json,
					payload_hash = excluded.payload_hash,
					artifact_id = excluded.artifact_id,
					source_uri = excluded.source_uri,
					summary = excluded.summary,
					token_estimate = excluded.token_estimate,
					updated_at = excluded.updated_at,
					unloaded_at = CASE
						WHEN $updateUnloadedAt THEN excluded.unloaded_at
						ELSE context_gc_records.unloaded_at
					END,
					recall_count = CASE
						WHEN $updateRecallCount THEN excluded.recall_count
						ELSE context_gc_records.recall_count
					END
			`)
			.run({
				id,
				sessionId: input.sessionId,
				sessionFile: input.sessionFile ?? null,
				status,
				kind: input.kind,
				sourceJson: stableStringify(input.source),
				payloadHash: input.payloadHash,
				artifactId: input.artifactId ?? null,
				sourceUri: input.sourceUri ?? null,
				summary: input.summary,
				tokenEstimate: Math.max(0, Math.trunc(input.tokenEstimate ?? 0)),
				createdAt,
				updatedAt,
				unloadedAt,
				recallCount,
				updateUnloadedAt,
				updateRecallCount,
			});

		const record = this.getRecord(id);
		if (!record) {
			throw new Error(`Context GC record was not persisted: ${id}`);
		}
		return record;
	}

	getRecord(id: string): ContextRecord | null {
		this.#assertOpen();
		const row = this.#db
			.query<RecordRow, { id: string }>(`
				SELECT *
				FROM context_gc_records
				WHERE id = $id
			`)
			.get({ id });
		return row ? recordFromRow(row) : null;
	}

	listRecords(filter: ListRecordsFilter = {}): ContextRecord[] {
		this.#assertOpen();
		if (filter.status) contextStatusSchema.parse(filter.status);
		const clauses: string[] = [];
		const params: Record<string, number | string> = {
			limit: clampLimit(filter.limit),
		};

		if (filter.sessionId) {
			clauses.push("session_id = $sessionId");
			params.sessionId = filter.sessionId;
		}
		if (filter.status) {
			clauses.push("status = $status");
			params.status = filter.status;
		} else if (!(filter.includePinned ?? false)) {
			clauses.push("status <> 'pinned'");
		}

		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.#db
			.query<RecordRow, Record<string, number | string>>(`
				SELECT *
				FROM context_gc_records
				${where}
				ORDER BY updated_at DESC, id ASC
				LIMIT $limit
			`)
			.all(params);
		return rows.map(recordFromRow);
	}

	getAggregateTotals(scope: ContextGcAggregateScope = {}): ContextGcAggregateTotals {
		this.#assertOpen();
		const { where, params } = this.#aggregateScope(scope);
		const totals = this.#db
			.query<{ records: number; tokens: number | null; recallCount: number | null }, { sessionId?: string }>(`
				SELECT COUNT(*) AS records,
					COALESCE(SUM(token_estimate), 0) AS tokens,
					COALESCE(SUM(recall_count), 0) AS recallCount
				FROM context_gc_records
				${where}
			`)
			.get(params);
		return {
			records: totals?.records ?? 0,
			tokens: totals?.tokens ?? 0,
			recallCount: totals?.recallCount ?? 0,
			byStatus: this.#aggregateBy("status", scope),
			byKind: this.#aggregateBy("kind", scope),
		};
	}

	getGlobalStats(): ContextGcGlobalStats {
		this.#assertOpen();
		const storage = this.#db
			.query<{ sessions: number; payloads: number; payloadBytes: number | null }, []>(`
				SELECT
					(SELECT COUNT(DISTINCT session_id) FROM context_gc_records) AS sessions,
					(SELECT COUNT(*) FROM context_gc_payloads) AS payloads,
					(SELECT COALESCE(SUM(byte_length), 0) FROM context_gc_payloads) AS payloadBytes
			`)
			.get();
		return {
			sessions: storage?.sessions ?? 0,
			payloads: storage?.payloads ?? 0,
			payloadBytes: storage?.payloadBytes ?? 0,
			totals: this.getAggregateTotals(),
		};
	}

	setStatus(id: string, status: ContextStatus, summary?: string): ContextRecord {
		this.#assertOpen();
		const parsedStatus = contextStatusSchema.parse(status);
		const updatedAt = nowIso();
		this.#db
			.query(`
				UPDATE context_gc_records
				SET status = $status,
					summary = COALESCE($summary, summary),
					updated_at = $updatedAt,
					unloaded_at = CASE WHEN $status = 'unloaded' THEN COALESCE(unloaded_at, $updatedAt) ELSE unloaded_at END
				WHERE id = $id
			`)
			.run({ id, status: parsedStatus, summary: summary ?? null, updatedAt });
		const record = this.getRecord(id);
		if (!record) {
			throw new Error(`Context GC record not found: ${id}`);
		}
		return record;
	}

	incrementRecall(id: string): ContextRecord {
		this.#assertOpen();
		const updatedAt = nowIso();
		this.#db
			.query(`
				UPDATE context_gc_records
				SET recall_count = recall_count + 1,
					updated_at = $updatedAt
				WHERE id = $id
			`)
			.run({ id, updatedAt });
		const record = this.getRecord(id);
		if (!record) {
			throw new Error(`Context GC record not found: ${id}`);
		}
		return record;
	}

	close(): void {
		if (this.#closed) return;
		this.#db.close();
		this.#closed = true;
	}

	#migrate(): void {
		this.#db.run("PRAGMA foreign_keys = OFF");
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#migrateLegacySchemaIfNeeded();
		this.#db.run("PRAGMA foreign_keys = ON");
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS context_gc_payloads (
				hash TEXT PRIMARY KEY,
				media_type TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				text TEXT NOT NULL,
				text_projection TEXT NOT NULL,
				created_at TEXT NOT NULL
			)
		`);
		this.#ensurePayloadProjectionColumn();
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS context_gc_records (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				session_file TEXT,
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
		this.#ensureRecordColumns();
		this.#db.run("CREATE INDEX IF NOT EXISTS context_gc_records_session_idx ON context_gc_records(session_id)");
		this.#db.run("CREATE INDEX IF NOT EXISTS context_gc_records_payload_idx ON context_gc_records(payload_hash)");
		this.#db.run("CREATE INDEX IF NOT EXISTS context_gc_records_status_idx ON context_gc_records(status)");
		this.#db.run(`PRAGMA user_version = ${CONTEXT_GC_DB_VERSION}`);
	}

	#migrateLegacySchemaIfNeeded(): void {
		const payloadColumns = this.#tableColumns("context_gc_payloads");
		const recordColumns = this.#tableColumns("context_gc_records");
		if (!payloadColumns.has("payload_hash") && !recordColumns.has("record_id")) return;

		this.#db.run("BEGIN IMMEDIATE");
		try {
			this.#db.run(`
				CREATE TABLE context_gc_payloads_next (
					hash TEXT PRIMARY KEY,
					media_type TEXT NOT NULL,
					byte_length INTEGER NOT NULL,
					text TEXT NOT NULL,
					text_projection TEXT NOT NULL,
					created_at TEXT NOT NULL
				)
			`);
			if (payloadColumns.has("payload_hash")) {
				const projectionSelect = payloadColumns.has("text_projection") ? ", text_projection" : "";
				const payloads = this.#db
					.query<LegacyPayloadRow, []>(`
						SELECT payload_hash, content, content_type, byte_length, created_at${projectionSelect}
						FROM context_gc_payloads
					`)
					.all();
				const insertPayload = this.#db.query(`
					INSERT OR IGNORE INTO context_gc_payloads_next
						(hash, media_type, byte_length, text, text_projection, created_at)
					VALUES ($hash, $mediaType, $byteLength, $text, $textProjection, $createdAt)
				`);
				for (const row of payloads) {
					insertPayload.run({
						hash: row.payload_hash,
						mediaType: row.content_type,
						byteLength: row.byte_length,
						text: row.content,
						textProjection: row.text_projection || row.content,
						createdAt: row.created_at,
					});
				}
			}

			this.#db.run(`
				CREATE TABLE context_gc_records_next (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					session_file TEXT,
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
			if (recordColumns.has("record_id")) {
				const sourceUriExpression = recordColumns.has("url") ? "url" : recordColumns.has("path") ? "path" : "NULL";
				const records = this.#db
					.query<LegacyRecordRow, []>(`
						SELECT record_id, session_id, kind, source_json, payload_hash, ${sourceUriExpression} AS source_uri,
							summary, status, policy, token_count, created_at, updated_at, unloaded_at, recalled_count
						FROM context_gc_records
					`)
					.all();
				const insertRecord = this.#db.query(`
					INSERT OR IGNORE INTO context_gc_records_next
						(id, session_id, session_file, status, kind, source_json, payload_hash, artifact_id, source_uri,
							summary, token_estimate, created_at, updated_at, unloaded_at, recall_count)
					VALUES ($id, $sessionId, NULL, $status, $kind, $sourceJson, $payloadHash, NULL, $sourceUri,
						$summary, $tokenEstimate, $createdAt, $updatedAt, $unloadedAt, $recallCount)
				`);
				for (const row of records) {
					const status = normalizeLegacyStatus(row.status, row.policy);
					insertRecord.run({
						id: row.record_id,
						sessionId: row.session_id,
						status,
						kind: normalizeLegacyKind(row.kind),
						sourceJson: row.source_json,
						payloadHash: row.payload_hash,
						sourceUri: row.source_uri ?? null,
						summary: row.summary,
						tokenEstimate: Math.max(0, Math.trunc(row.token_count ?? 0)),
						createdAt: row.created_at,
						updatedAt: row.updated_at,
						unloadedAt: status === "unloaded" ? (row.unloaded_at ?? row.updated_at) : null,
						recallCount: Math.max(0, Math.trunc(row.recalled_count ?? 0)),
					});
				}
			}

			this.#db.run("DROP TABLE IF EXISTS context_gc_records");
			this.#db.run("DROP TABLE IF EXISTS context_gc_payloads");
			this.#db.run("ALTER TABLE context_gc_payloads_next RENAME TO context_gc_payloads");
			this.#db.run("ALTER TABLE context_gc_records_next RENAME TO context_gc_records");
			this.#db.run("COMMIT");
		} catch (error) {
			this.#db.run("ROLLBACK");
			throw error;
		}
	}

	#tableColumns(tableName: string): Set<string> {
		const rows = this.#db.query<ColumnInfo, []>(`PRAGMA table_info(${tableName})`).all();
		return new Set(rows.map(row => row.name));
	}

	/**
	 * Backfill the `text_projection` column for databases created before structured payload
	 * persistence (schema v1). `CREATE TABLE IF NOT EXISTS` cannot add columns to an existing
	 * table, so add it and seed the projection from the canonical `text` for legacy rows.
	 */
	#ensurePayloadProjectionColumn(): void {
		const columns = this.#tableColumns("context_gc_payloads");
		if (columns.has("text_projection")) return;
		this.#db.run("ALTER TABLE context_gc_payloads ADD COLUMN text_projection TEXT NOT NULL DEFAULT ''");
		this.#db.run("UPDATE context_gc_payloads SET text_projection = text");
	}

	#aggregateScope(scope: ContextGcAggregateScope): { where: string; params: { sessionId?: string } } {
		if (!scope.sessionId) return { where: "", params: {} };
		return { where: "WHERE session_id = $sessionId", params: { sessionId: scope.sessionId } };
	}

	#aggregateBy(column: "status" | "kind", scope: ContextGcAggregateScope): ContextGcAggregateBucket[] {
		const { where, params } = this.#aggregateScope(scope);
		const rows = this.#db
			.query<
				{ key: string; records: number; tokens: number | null; recallCount: number | null },
				{ sessionId?: string }
			>(`
				SELECT ${column} AS key,
					COUNT(*) AS records,
					COALESCE(SUM(token_estimate), 0) AS tokens,
					COALESCE(SUM(recall_count), 0) AS recallCount
				FROM context_gc_records
				${where}
				GROUP BY ${column}
				ORDER BY records DESC, key ASC
			`)
			.all(params);
		return rows.map(row => ({
			key: row.key,
			records: row.records,
			tokens: row.tokens ?? 0,
			recallCount: row.recallCount ?? 0,
		}));
	}
	#assertOpen(): void {
		if (this.#closed) {
			throw new Error("Context GC store is closed");
		}
	}

	#ensureRecordColumns(): void {
		const columns = this.#tableColumns("context_gc_records");
		if (columns.size === 0) return;
		if (!columns.has("session_file")) {
			this.#db.run("ALTER TABLE context_gc_records ADD COLUMN session_file TEXT");
		}
		if (!columns.has("artifact_id")) {
			this.#db.run("ALTER TABLE context_gc_records ADD COLUMN artifact_id TEXT");
		}
		if (!columns.has("source_uri")) {
			this.#db.run("ALTER TABLE context_gc_records ADD COLUMN source_uri TEXT");
		}
		if (!columns.has("recall_count")) {
			this.#db.run("ALTER TABLE context_gc_records ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0");
		}
	}
}

function hashPayload(text: string): string {
	return Bun.SHA256.hash(text, "hex");
}

function nowIso(): string {
	return new Date().toISOString();
}

function payloadFromRow(row: PayloadRow): ContextPayload {
	return {
		hash: row.hash,
		mediaType: row.media_type,
		byteLength: row.byte_length,
		text: row.text,
		textProjection: row.text_projection,
		createdAt: row.created_at,
	};
}

function recordFromRow(row: RecordRow): ContextRecord {
	return {
		id: row.id,
		sessionId: row.session_id,
		sessionFile: row.session_file,
		status: contextStatusSchema.parse(row.status),
		kind: contextKindSchema.parse(row.kind),
		source: parseSource(row.source_json),
		payloadHash: row.payload_hash,
		artifactId: row.artifact_id,
		sourceUri: row.source_uri,
		summary: row.summary,
		tokenEstimate: row.token_estimate,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		unloadedAt: row.unloaded_at,
		recallCount: row.recall_count,
	};
}

function parseSource(value: string): ContextSource {
	const parsed = JSON.parse(value) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Context GC record source is not an object");
	}
	return parsed as ContextSource;
}

function normalizeLegacyKind(value: string): ContextKind {
	const normalized = value.replaceAll("-", "_");
	const parsed = contextKindSchema.safeParse(normalized);
	return parsed.success ? parsed.data : "custom_tool_output";
}

function normalizeLegacyStatus(value: string, policy: string | null | undefined): ContextStatus {
	if (value === "unloaded") return "unloaded";
	if (value === "pinned" || policy === "pinned" || policy === "never") return "pinned";
	return "candidate";
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const source = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		sorted[key] = sortJsonValue(source[key]);
	}
	return sorted;
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return 100;
	return Math.min(Math.max(Math.trunc(limit), 1), 500);
}
