# Context GC Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable context-unloading OMP extension plugin that lets the agent unload no-longer-needed tool results, file reads, skill payloads, and related context surfaces from the LLM-facing context while preserving a small summary plus a recall reference backed by SQLite.

**Architecture:** Add a new workspace package `@oh-my-pi/context-gc-plugin` that registers an OMP extension. The plugin stores unloaded payloads and registry metadata in a SQLite database under the OMP agent data directory, appends small session `custom` entries for branch/reload linkage, projects unloaded items out of LLM-facing context via the extension `context` event, and exposes `context_inventory`, `context_unload`, `context_recall`, and `context_pin` tools.

**Tech Stack:** Bun, TypeScript, OMP extension API from `@oh-my-pi/pi-coding-agent`, `bun:sqlite`, Bun test runner, existing OMP session/artifact APIs.

---

## Current-code facts the implementation relies on

- Session files are durable JSONL under `~/.omp/agent/sessions/--<cwd-encoded>--/<timestamp>_<sessionId>.jsonl`; entries are append-only at runtime (`docs/session.md:28-56`).
- `custom` session entries persist extension state and do not enter model context; `custom_message` entries do enter model context (`packages/coding-agent/src/session/session-manager.ts:139-216`, `docs/session.md:223-251`, `docs/session.md:386-400`).
- Extension context has read-only session access including `getSessionId`, `getSessionFile`, `getBranch`, `getEntries`, `getArtifactsDir`, `saveArtifact`, and artifact lookup helpers (`packages/coding-agent/src/session/session-manager.ts:282-304`).
- Extensions can register tools and subscribe to `context`, `before_agent_start`, `tool_result`, `user_bash`, and `user_python` events (`packages/coding-agent/src/extensibility/extensions/types.ts:848-905`).
- `context` handlers can replace the messages sent to the provider (`packages/coding-agent/src/extensibility/extensions/types.ts:742-744`).
- Tool result handlers can replace tool result content/details before it is persisted into the conversation (`packages/coding-agent/src/extensibility/shared-events.ts:272-283`).
- Built-in tool registration lives in `packages/coding-agent/src/tools/index.ts:303-342`; dynamic tools include MCP (`mcp__...`), extension tools, custom tools, image generation, TTS, Exa, and websets.

---

## Design decisions

1. **SQLite is the durable source of truth for unloaded context.** Session artifacts are still written as an interoperability mirror when available, but recall must work from the DB after the process exits.
2. **Session JSONL gets only small linkage entries.** Each unload writes `api.appendEntry("context-gc", { op, id, sessionId, status, summary, payloadHash })`; these entries survive resume without sending content to the LLM.
3. **The plugin does not delete or rewrite user transcript history.** It replaces only the LLM-facing projection during `context` transformation. The TUI/session file remain auditable.
4. **The agent makes the unload decision by calling `context_unload`.** The plugin nudges the agent with `before_agent_start`; deterministic auto-unload is limited to safe payload classes and disabled by default.
5. **Recall is bounded by default.** `context_recall` returns selected ranges/search slices unless `mode: "raw"` is explicitly requested.
6. **Tool inventory is policy-driven, not hardcoded to only current examples.** The classifier covers known built-ins and also catches any unknown MCP/extension/custom tool by output size and metadata.

---

## Exact context surfaces to support

### Built-in tools from `BUILTIN_TOOLS`

| Tool | Policy | Reason |
|---|---|---|
| `read` | candidate | File, URL, archive, SQLite, image/document extracts can dominate context. |
| `bash` | candidate | Command output can be large; preserve exit code and summary. |
| `edit` | conservative | Usually small but patch failures can be large; never unload while an edit/resolve action is pending. |
| `ast_grep` | candidate | Structural search output can be large. |
| `ast_edit` | conservative | Diff previews can be large; avoid unloading pending apply/discard flows. |
| `render_mermaid` | candidate | Render metadata/artifacts can be summarized. |
| `ask` | candidate | Advisor output may be long and should be recallable. |
| `debug` | candidate | Stack traces, variables, and output can be large. |
| `eval` | candidate | Python/JS cell output can be large; includes stdout/display artifacts. |
| `ssh` | candidate | Remote command output mirrors bash risk. |
| `github` | candidate | Issues/PRs/comments can be large. |
| `find` | candidate | Directory inventories can be large. |
| `search` | candidate | Text search results can be large. |
| `lsp` | candidate | References/diagnostics/symbols can be large. |
| `inspect_image` | candidate | Image analysis text can be large; binary should be referenced, not copied. |
| `browser` | candidate | Observe/extract/screenshot metadata can be large. |
| `checkpoint` | pinned | Session-state control; keep unless result exceeds threshold and is pure text. |
| `rewind` | pinned | Session-state control; keep unless result exceeds threshold and is pure text. |
| `task` | candidate | Subagent output can be long; preserve `agent://...` references. |
| `workflow` | candidate | Workflow output and agent summaries can be long. |
| `job` | candidate | Background job output can be long. |
| `irc` | candidate | Message logs can be summarized when large. |
| `todo_write` | pinned | Active planning state; do not unload. |
| `web_search` | candidate | Search results can be large. |
| `search_tool_bm25` | pinned | Tool discovery state; keep compact result. |
| `write` | conservative | Usually small; preserve write errors and pending safety context. |
| `memory_edit` | pinned | Memory mutation state. |
| `retain` | pinned | Memory mutation state. |
| `recall` | candidate | Memory recall output can be large and recoverable. |
| `reflect` | candidate | Synthesized memory output can be long. |

### Hidden/session tools

| Tool | Policy | Reason |
|---|---|---|
| `yield` | pinned | Control-flow tool. |
| `report_finding` | pinned | Review output should remain visible. |
| `report_tool_issue` | pinned | QA/error reporting should remain visible. |
| `resolve` | pinned | Pending action state must not be hidden. |
| `goal` | pinned | Goal-mode state must stay available. |

### Dynamic/custom tools

- MCP tools: any name starting with `mcp__`.
- SDK/custom extension tools registered via `registerTool` or `customTools`.
- User-discovered tools from `.omp/tools` and `.claude/tools`.
- `generate_image`.
- `tts`.
- Exa tools: `exa_search`, `exa_researcher_start`, `exa_researcher_poll`.
- Webset tools: `webset_create`, `webset_list`, `webset_get`, `webset_update`, `webset_delete`, `webset_items_list`, `webset_item_get`, `webset_search_create`, `webset_search_get`, `webset_search_cancel`, `webset_enrichment_create`, `webset_enrichment_get`, `webset_enrichment_update`, `webset_enrichment_delete`, `webset_enrichment_cancel`, `webset_monitor_create`.

### Non-tool context surfaces

- `$skill` and `/skill` injected skill `custom_message` payloads.
- `read skill://...` output.
- `@file` / file mention messages.
- User `!cmd` bash execution messages.
- User `$code` python execution messages.
- Subagent outputs referenced by `agent://...`.
- Artifact references `artifact://...`.
- Local scratch references `local://...`.
- Image blocks and generated image metadata.
- Auto-loaded context files (`AGENTS.md`, project context) are pinned by default; support unload only behind an explicit future setting because they may contain active instructions.

---

## File structure

- Create: `packages/context-gc-plugin/package.json` — workspace package manifest and OMP extension entry.
- Create: `packages/context-gc-plugin/tsconfig.json` — package typecheck config.
- Create: `packages/context-gc-plugin/src/extension.ts` — extension entry; registers events, commands, tools.
- Create: `packages/context-gc-plugin/src/schema.ts` — shared literal unions, DB row types, tool input schemas.
- Create: `packages/context-gc-plugin/src/storage.ts` — SQLite database open, migrations, payload/record/event persistence.
- Create: `packages/context-gc-plugin/src/session-state.ts` — rebuild current branch state from DB plus session metadata.
- Create: `packages/context-gc-plugin/src/tool-classification.ts` — exact unload policy table and dynamic classification.
- Create: `packages/context-gc-plugin/src/extract.ts` — convert messages/tool results into text payloads and metadata.
- Create: `packages/context-gc-plugin/src/summary.ts` — deterministic fallback summaries and validation of agent-provided summaries.
- Create: `packages/context-gc-plugin/src/context-transform.ts` — replace unloaded payloads in LLM-facing messages with summaries and recall refs.
- Create: `packages/context-gc-plugin/src/reminder.ts` — concise before-turn reminder for unload candidates.
- Create: `packages/context-gc-plugin/src/tools/context-inventory.ts` — inventory tool.
- Create: `packages/context-gc-plugin/src/tools/context-unload.ts` — unload tool.
- Create: `packages/context-gc-plugin/src/tools/context-recall.ts` — recall tool.
- Create: `packages/context-gc-plugin/src/tools/context-pin.ts` — pin/unpin tool.
- Create: `packages/context-gc-plugin/test/storage.test.ts`.
- Create: `packages/context-gc-plugin/test/tool-classification.test.ts`.
- Create: `packages/context-gc-plugin/test/summary.test.ts`.
- Create: `packages/context-gc-plugin/test/context-transform.test.ts`.
- Create: `packages/context-gc-plugin/test/tools.test.ts`.
- Modify: `package.json` only if a package-level script is needed; Bun workspaces already include `packages/*`, so no workspace change is needed.
- Modify: `packages/coding-agent/CHANGELOG.md` under `[Unreleased]` after implementation because this repo tracks user-visible package changes per package.

---

### Task 1: Scaffold the extension package

**Files:**
- Create: `packages/context-gc-plugin/package.json`
- Create: `packages/context-gc-plugin/tsconfig.json`
- Create: `packages/context-gc-plugin/src/extension.ts`
- Create: `packages/context-gc-plugin/src/schema.ts`

- [ ] **Step 1: Create package manifest**

Create `packages/context-gc-plugin/package.json`:

```json
{
	"type": "module",
	"name": "@oh-my-pi/context-gc-plugin",
	"version": "15.7.4",
	"description": "Durable context unloading extension for omp",
	"homepage": "https://omp.sh",
	"author": "Can Boluk",
	"license": "MIT",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/can1357/oh-my-pi.git",
		"directory": "packages/context-gc-plugin"
	},
	"keywords": ["context", "extension", "memory", "unload"],
	"scripts": {
		"check": "biome check . && bun run check:types",
		"check:types": "tsgo -p tsconfig.json --noEmit",
		"test": "bun test --parallel",
		"lint": "biome lint .",
		"fix": "biome check --write --unsafe .",
		"fmt": "biome format --write ."
	},
	"dependencies": {
		"@oh-my-pi/pi-coding-agent": "workspace:*",
		"@oh-my-pi/pi-utils": "workspace:*",
		"zod": "catalog:"
	},
	"devDependencies": {
		"@types/bun": "catalog:"
	},
	"peerDependencies": {
		"@oh-my-pi/pi-coding-agent": "^15"
	},
	"engines": {
		"bun": ">=1.3.14"
	},
	"omp": {
		"extensions": ["./src/extension.ts"],
		"settings": {
			"enabled": { "type": "boolean", "default": true },
			"dbPath": { "type": "string", "default": "" },
			"minCandidateTokens": { "type": "number", "default": 1200, "min": 100 },
			"reminderThresholdTokens": { "type": "number", "default": 8000, "min": 1000 },
			"keepRecentTurns": { "type": "number", "default": 2, "min": 0 },
			"recallMaxBytes": { "type": "number", "default": 24000, "min": 1024 },
			"autoUnloadMode": {
				"type": "enum",
				"values": ["off", "agent", "safe"],
				"default": "agent"
			}
		}
	},
	"files": ["src", "README.md"]
}
```

- [ ] **Step 2: Create TypeScript config**

Create `packages/context-gc-plugin/tsconfig.json`:

```json
{
	"extends": "../tsconfig.workspace.json",
	"include": ["src", "test"]
}
```

- [ ] **Step 3: Define shared schema and types**

Create `packages/context-gc-plugin/src/schema.ts`:

```ts
import * as z from "zod/v4";

export const CONTEXT_GC_CUSTOM_TYPE = "context-gc";
export const CONTEXT_GC_DB_VERSION = 1;

export const contextKindSchema = z.enum([
	"tool_result",
	"file_read",
	"file_mention",
	"skill",
	"bash_execution",
	"python_execution",
	"subagent_output",
	"browser_output",
	"mcp_output",
	"custom_tool_output",
]);

export const contextStatusSchema = z.enum(["candidate", "unloaded", "pinned"]);
export const contextPolicySchema = z.enum(["candidate", "conservative", "pinned"]);

export type ContextKind = z.infer<typeof contextKindSchema>;
export type ContextStatus = z.infer<typeof contextStatusSchema>;
export type ContextPolicy = z.infer<typeof contextPolicySchema>;

export interface ContextSource {
	entryId?: string;
	toolCallId?: string;
	toolName?: string;
	path?: string;
	uri?: string;
	command?: string;
	skillName?: string;
}

export interface ContextRecord {
	id: string;
	sessionId: string;
	sessionFile: string | null;
	status: ContextStatus;
	kind: ContextKind;
	source: ContextSource;
	payloadHash: string;
	artifactId: string | null;
	sourceUri: string | null;
	summary: string;
	tokenEstimate: number;
	createdAt: string;
	updatedAt: string;
	unloadedAt: string | null;
	recallCount: number;
}

export interface ContextPayload {
	hash: string;
	mediaType: string;
	byteLength: number;
	text: string;
	createdAt: string;
}

export interface ContextGcDelta {
	op: "candidate" | "unload" | "pin" | "unpin" | "recall";
	id: string;
	sessionId: string;
	payloadHash?: string;
	status?: ContextStatus;
	summary?: string;
	reason?: string;
	createdAt: string;
}

export const inventoryInputSchema = z.object({
	status: contextStatusSchema.optional(),
	includePinned: z.boolean().optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

export const unloadInputSchema = z.object({
	ids: z.array(z.string().min(1)).min(1),
	summary: z.string().min(12).max(4000),
	reason: z.string().min(3).max(1000),
});

export const recallInputSchema = z.object({
	id: z.string().min(1),
	mode: z.enum(["summary", "range", "search", "raw"]).optional(),
	selector: z.string().max(200).optional(),
	maxBytes: z.number().int().min(1024).max(200000).optional(),
});

export const pinInputSchema = z.object({
	ids: z.array(z.string().min(1)).min(1),
	pinned: z.boolean().default(true),
	reason: z.string().min(3).max(1000),
});
```

- [ ] **Step 4: Add minimal extension entry**

Create `packages/context-gc-plugin/src/extension.ts`:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CONTEXT_GC_CUSTOM_TYPE } from "./schema";

export default function contextGcExtension(pi: ExtensionAPI): void {
	pi.setLabel("Context GC");
	pi.on("session_start", () => {
		pi.appendEntry(CONTEXT_GC_CUSTOM_TYPE, {
			op: "candidate",
			id: "context-gc-session-start",
			sessionId: "unknown",
			createdAt: new Date().toISOString(),
		});
	});
}
```

- [ ] **Step 5: Verify scaffold typecheck**

Run:

```bash
bun --cwd=packages/context-gc-plugin run check
```

Expected: typecheck and biome complete without errors.

- [ ] **Step 6: Checkpoint**

If the user explicitly asked for commits, run:

```bash
git add packages/context-gc-plugin package.json bun.lock
git commit -m "feat(context-gc): scaffold context unloading plugin"
```

If the user did not ask for commits, record the changed files in the handoff instead.

---

### Task 2: Add durable SQLite storage

**Files:**
- Create: `packages/context-gc-plugin/src/storage.ts`
- Test: `packages/context-gc-plugin/test/storage.test.ts`

- [ ] **Step 1: Write storage tests first**

Create `packages/context-gc-plugin/test/storage.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openContextGcStore } from "../src/storage";

const tempDirs: string[] = [];

async function tempDbPath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "context-gc-"));
	tempDirs.push(dir);
	return path.join(dir, "context-gc.sqlite");
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("ContextGcStore", () => {
	test("persists payloads and records across reopen", async () => {
		const dbPath = await tempDbPath();
		const first = openContextGcStore({ dbPath });
		const payload = first.putPayload("text/plain", "large tool output");
		first.upsertRecord({
			id: "ctx_test",
			sessionId: "session-a",
			sessionFile: "/tmp/session.jsonl",
			status: "candidate",
			kind: "tool_result",
			source: { toolName: "bash", toolCallId: "call-a" },
			payloadHash: payload.hash,
			artifactId: null,
			sourceUri: null,
			summary: "A bash command produced large tool output.",
			tokenEstimate: 4,
		});
		first.close();

		const second = openContextGcStore({ dbPath });
		const record = second.getRecord("ctx_test");
		expect(record?.payloadHash).toBe(payload.hash);
		expect(record?.source.toolName).toBe("bash");
		expect(second.getPayload(payload.hash)?.text).toBe("large tool output");
		second.close();
	});

	test("updates status without duplicating payload", async () => {
		const dbPath = await tempDbPath();
		const store = openContextGcStore({ dbPath });
		const payload = store.putPayload("text/plain", "same output");
		store.upsertRecord({
			id: "ctx_status",
			sessionId: "session-a",
			sessionFile: null,
			status: "candidate",
			kind: "file_read",
			source: { toolName: "read", path: "README.md" },
			payloadHash: payload.hash,
			artifactId: null,
			sourceUri: "README.md",
			summary: "README content was read.",
			tokenEstimate: 2,
		});
		store.setStatus("ctx_status", "unloaded", "README content summarized for recall.");
		expect(store.getRecord("ctx_status")?.status).toBe("unloaded");
		expect(store.listRecords({ sessionId: "session-a", status: "unloaded" })).toHaveLength(1);
		store.close();
	});
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun --cwd=packages/context-gc-plugin test test/storage.test.ts
```

Expected: FAIL because `../src/storage` does not exist.

- [ ] **Step 3: Implement SQLite store**

Create `packages/context-gc-plugin/src/storage.ts`:

```ts
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { CONTEXT_GC_DB_VERSION, type ContextKind, type ContextPayload, type ContextRecord, type ContextSource, type ContextStatus } from "./schema";

export interface OpenContextGcStoreOptions {
	dbPath?: string;
}

export interface UpsertRecordInput {
	id: string;
	sessionId: string;
	sessionFile: string | null;
	status: ContextStatus;
	kind: ContextKind;
	source: ContextSource;
	payloadHash: string;
	artifactId: string | null;
	sourceUri: string | null;
	summary: string;
	tokenEstimate: number;
}

export interface ListRecordFilter {
	sessionId: string;
	status?: ContextStatus;
	includePinned?: boolean;
	limit?: number;
}

export function getDefaultDbPath(): string {
	return path.join(getAgentDir(), "context-gc.sqlite");
}

export function openContextGcStore(options: OpenContextGcStoreOptions = {}): ContextGcStore {
	return new ContextGcStore(options.dbPath ?? getDefaultDbPath());
}

export class ContextGcStore {
	readonly #db: Database;
	readonly #dbPath: string;

	constructor(dbPath: string) {
		this.#dbPath = dbPath;
		this.#db = new Database(dbPath, { create: true, strict: true });
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec("PRAGMA foreign_keys = ON");
		this.#migrate();
	}

	get dbPath(): string {
		return this.#dbPath;
	}

	close(): void {
		this.#db.close();
	}

	putPayload(mediaType: string, text: string): ContextPayload {
		const hash = Bun.SHA256.hash(text, "hex");
		const now = new Date().toISOString();
		const byteLength = Buffer.byteLength(text, "utf8");
		this.#db
			.query(
				`INSERT OR IGNORE INTO payloads (hash, media_type, byte_length, text, created_at)
				 VALUES ($hash, $mediaType, $byteLength, $text, $createdAt)`,
			)
			.run({ hash, mediaType, byteLength, text, createdAt: now });
		return { hash, mediaType, byteLength, text, createdAt: now };
	}

	getPayload(hash: string): ContextPayload | null {
		const row = this.#db
			.query(
				`SELECT hash, media_type AS mediaType, byte_length AS byteLength, text, created_at AS createdAt
				 FROM payloads WHERE hash = $hash`,
			)
			.get({ hash }) as ContextPayload | null;
		return row;
	}

	upsertRecord(input: UpsertRecordInput): void {
		const now = new Date().toISOString();
		this.#db
			.query(
				`INSERT INTO records (
					id, session_id, session_file, status, kind, source_json, payload_hash,
					artifact_id, source_uri, summary, token_estimate, created_at, updated_at,
					unloaded_at, recall_count
				) VALUES (
					$id, $sessionId, $sessionFile, $status, $kind, $sourceJson, $payloadHash,
					$artifactId, $sourceUri, $summary, $tokenEstimate, $createdAt, $updatedAt,
					NULL, 0
				) ON CONFLICT(id) DO UPDATE SET
					status = excluded.status,
					kind = excluded.kind,
					source_json = excluded.source_json,
					payload_hash = excluded.payload_hash,
					artifact_id = excluded.artifact_id,
					source_uri = excluded.source_uri,
					summary = excluded.summary,
					token_estimate = excluded.token_estimate,
					updated_at = excluded.updated_at`,
			)
			.run({
				id: input.id,
				sessionId: input.sessionId,
				sessionFile: input.sessionFile,
				status: input.status,
				kind: input.kind,
				sourceJson: JSON.stringify(input.source),
				payloadHash: input.payloadHash,
				artifactId: input.artifactId,
				sourceUri: input.sourceUri,
				summary: input.summary,
				tokenEstimate: input.tokenEstimate,
				createdAt: now,
				updatedAt: now,
			});
	}

	getRecord(id: string): ContextRecord | null {
		const row = this.#db.query(`SELECT * FROM records WHERE id = $id`).get({ id }) as Record<string, unknown> | null;
		return row ? mapRecord(row) : null;
	}

	listRecords(filter: ListRecordFilter): ContextRecord[] {
		const limit = filter.limit ?? 100;
		const includePinned = filter.includePinned === true;
		const statusClause = filter.status ? "AND status = $status" : includePinned ? "" : "AND status != 'pinned'";
		const rows = this.#db
			.query(`SELECT * FROM records WHERE session_id = $sessionId ${statusClause} ORDER BY updated_at DESC LIMIT $limit`)
			.all({ sessionId: filter.sessionId, status: filter.status, limit }) as Array<Record<string, unknown>>;
		return rows.map(mapRecord);
	}

	setStatus(id: string, status: ContextStatus, summary?: string): void {
		const now = new Date().toISOString();
		this.#db
			.query(
				`UPDATE records
				 SET status = $status,
				     summary = COALESCE($summary, summary),
				     unloaded_at = CASE WHEN $status = 'unloaded' THEN COALESCE(unloaded_at, $now) ELSE unloaded_at END,
				     updated_at = $now
				 WHERE id = $id`,
			)
			.run({ id, status, summary: summary ?? null, now });
	}

	incrementRecall(id: string): void {
		this.#db.query(`UPDATE records SET recall_count = recall_count + 1, updated_at = $now WHERE id = $id`).run({
			id,
			now: new Date().toISOString(),
		});
	}

	#privateMigrationsTable(): void {
		this.#db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
	}

	#migrate(): void {
		const dir = path.dirname(this.#dbPath);
		fs.mkdir(dir, { recursive: true }).catch(() => undefined);
		this.#privateMigrationsTable();
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS payloads (
				hash TEXT PRIMARY KEY,
				media_type TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				text TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS records (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				session_file TEXT,
				status TEXT NOT NULL CHECK(status IN ('candidate', 'unloaded', 'pinned')),
				kind TEXT NOT NULL,
				source_json TEXT NOT NULL,
				payload_hash TEXT NOT NULL REFERENCES payloads(hash),
				artifact_id TEXT,
				source_uri TEXT,
				summary TEXT NOT NULL,
				token_estimate INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				unloaded_at TEXT,
				recall_count INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_records_session_status ON records(session_id, status, updated_at);
			CREATE INDEX IF NOT EXISTS idx_records_payload_hash ON records(payload_hash);
		`);
		this.#db
			.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', $version)`)
			.run({ version: String(CONTEXT_GC_DB_VERSION) });
	}
}

function mapRecord(row: Record<string, unknown>): ContextRecord {
	return {
		id: String(row.id),
		sessionId: String(row.session_id),
		sessionFile: row.session_file === null ? null : String(row.session_file),
		status: row.status as ContextRecord["status"],
		kind: row.kind as ContextRecord["kind"],
		source: JSON.parse(String(row.source_json)) as ContextSource,
		payloadHash: String(row.payload_hash),
		artifactId: row.artifact_id === null ? null : String(row.artifact_id),
		sourceUri: row.source_uri === null ? null : String(row.source_uri),
		summary: String(row.summary),
		tokenEstimate: Number(row.token_estimate),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		unloadedAt: row.unloaded_at === null ? null : String(row.unloaded_at),
		recallCount: Number(row.recall_count),
	};
}
```

- [ ] **Step 4: Run storage tests**

Run:

```bash
bun --cwd=packages/context-gc-plugin test test/storage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run package check**

Run:

```bash
bun --cwd=packages/context-gc-plugin run check
```

Expected: PASS.

---

### Task 3: Implement exact tool classification

**Files:**
- Create: `packages/context-gc-plugin/src/tool-classification.ts`
- Test: `packages/context-gc-plugin/test/tool-classification.test.ts`

- [ ] **Step 1: Write classification tests**

Create `packages/context-gc-plugin/test/tool-classification.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { classifyContextSurface, KNOWN_TOOL_POLICIES } from "../src/tool-classification";

describe("tool classification", () => {
	test("covers built-in and hidden tools explicitly", () => {
		for (const name of [
			"read",
			"bash",
			"edit",
			"ast_grep",
			"ast_edit",
			"render_mermaid",
			"ask",
			"debug",
			"eval",
			"ssh",
			"github",
			"find",
			"search",
			"lsp",
			"inspect_image",
			"browser",
			"checkpoint",
			"rewind",
			"task",
			"workflow",
			"job",
			"irc",
			"todo_write",
			"web_search",
			"search_tool_bm25",
			"write",
			"memory_edit",
			"retain",
			"recall",
			"reflect",
			"yield",
			"report_finding",
			"report_tool_issue",
			"resolve",
			"goal",
		]) {
			expect(KNOWN_TOOL_POLICIES[name], name).toBeDefined();
		}
	});

	test("classifies dynamic MCP and custom tools", () => {
		expect(classifyContextSurface({ toolName: "mcp__github_get_issue" }).policy).toBe("candidate");
		expect(classifyContextSurface({ toolName: "generate_image" }).kind).toBe("custom_tool_output");
		expect(classifyContextSurface({ toolName: "tts" }).policy).toBe("conservative");
		expect(classifyContextSurface({ toolName: "unknown_extension_tool" }).policy).toBe("candidate");
	});

	test("detects file reads and skill reads", () => {
		expect(classifyContextSurface({ toolName: "read", sourceUri: "skill://python-pro" }).kind).toBe("skill");
		expect(classifyContextSurface({ toolName: "read", sourceUri: "packages/coding-agent/src/tools/index.ts" }).kind).toBe("file_read");
	});
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun --cwd=packages/context-gc-plugin test test/tool-classification.test.ts
```

Expected: FAIL because `tool-classification.ts` does not exist.

- [ ] **Step 3: Implement classifier**

Create `packages/context-gc-plugin/src/tool-classification.ts`:

```ts
import type { ContextKind, ContextPolicy } from "./schema";

export interface ToolPolicy {
	policy: ContextPolicy;
	kind: ContextKind;
	reason: string;
}

export interface ClassifyInput {
	toolName?: string;
	sourceUri?: string;
	customType?: string;
}

export const KNOWN_TOOL_POLICIES: Record<string, ToolPolicy> = {
	read: { policy: "candidate", kind: "file_read", reason: "Read output can contain large file, URL, archive, document, SQLite, or internal URI content." },
	bash: { policy: "candidate", kind: "bash_execution", reason: "Command output can be large and is recoverable from DB recall." },
	edit: { policy: "conservative", kind: "tool_result", reason: "Edit results can include important patch anchors or pending failure details." },
	ast_grep: { policy: "candidate", kind: "tool_result", reason: "Structural search output can be large." },
	ast_edit: { policy: "conservative", kind: "tool_result", reason: "AST edit previews may require resolve/apply context." },
	render_mermaid: { policy: "candidate", kind: "tool_result", reason: "Render output is recoverable and often summarized." },
	ask: { policy: "candidate", kind: "tool_result", reason: "Advisor output can be long." },
	debug: { policy: "candidate", kind: "tool_result", reason: "Debug output can contain stack and variables." },
	eval: { policy: "candidate", kind: "tool_result", reason: "Eval output can be large." },
	ssh: { policy: "candidate", kind: "tool_result", reason: "Remote command output can be large." },
	github: { policy: "candidate", kind: "tool_result", reason: "GitHub issue and PR output can be large." },
	find: { policy: "candidate", kind: "tool_result", reason: "File listings can be large." },
	search: { policy: "candidate", kind: "tool_result", reason: "Search results can be large." },
	lsp: { policy: "candidate", kind: "tool_result", reason: "Language server results can be large." },
	inspect_image: { policy: "candidate", kind: "tool_result", reason: "Image analysis output can be summarized." },
	browser: { policy: "candidate", kind: "browser_output", reason: "Browser observations and extracts can be large." },
	checkpoint: { policy: "pinned", kind: "tool_result", reason: "Checkpoint state is control context." },
	rewind: { policy: "pinned", kind: "tool_result", reason: "Rewind state is control context." },
	task: { policy: "candidate", kind: "subagent_output", reason: "Subagent output can be long and usually has agent references." },
	workflow: { policy: "candidate", kind: "subagent_output", reason: "Workflow output can contain multiple agent summaries." },
	job: { policy: "candidate", kind: "tool_result", reason: "Background job output can be large." },
	irc: { policy: "candidate", kind: "tool_result", reason: "IRC logs can be summarized." },
	todo_write: { policy: "pinned", kind: "tool_result", reason: "Todo state is active planning context." },
	web_search: { policy: "candidate", kind: "tool_result", reason: "Web search results can be large." },
	search_tool_bm25: { policy: "pinned", kind: "tool_result", reason: "Tool discovery state should remain compact and visible." },
	write: { policy: "conservative", kind: "tool_result", reason: "Write results and errors can affect subsequent edits." },
	memory_edit: { policy: "pinned", kind: "tool_result", reason: "Memory mutation state should stay visible." },
	retain: { policy: "pinned", kind: "tool_result", reason: "Memory mutation state should stay visible." },
	recall: { policy: "candidate", kind: "tool_result", reason: "Memory recall output can be large and recallable." },
	reflect: { policy: "candidate", kind: "tool_result", reason: "Memory reflection output can be large and recallable." },
	yield: { policy: "pinned", kind: "tool_result", reason: "Control-flow tool." },
	report_finding: { policy: "pinned", kind: "tool_result", reason: "Review findings should remain visible." },
	report_tool_issue: { policy: "pinned", kind: "tool_result", reason: "QA report should remain visible." },
	resolve: { policy: "pinned", kind: "tool_result", reason: "Pending action resolution state must not be hidden." },
	goal: { policy: "pinned", kind: "tool_result", reason: "Goal-mode state should remain visible." },
	generate_image: { policy: "candidate", kind: "custom_tool_output", reason: "Generated image metadata can be large and binary payloads should be referenced." },
	tts: { policy: "conservative", kind: "custom_tool_output", reason: "TTS output is usually small and file-oriented." },
	exa_search: { policy: "candidate", kind: "custom_tool_output", reason: "Exa search output can be large." },
	exa_researcher_start: { policy: "candidate", kind: "custom_tool_output", reason: "Exa researcher state can be summarized." },
	exa_researcher_poll: { policy: "candidate", kind: "custom_tool_output", reason: "Exa research result can be large." },
	webset_create: { policy: "candidate", kind: "custom_tool_output", reason: "Webset response can be summarized." },
	webset_list: { policy: "candidate", kind: "custom_tool_output", reason: "Webset lists can be large." },
	webset_get: { policy: "candidate", kind: "custom_tool_output", reason: "Webset details can be recalled." },
	webset_update: { policy: "candidate", kind: "custom_tool_output", reason: "Webset response can be summarized." },
	webset_delete: { policy: "conservative", kind: "custom_tool_output", reason: "Delete confirmation should remain visible." },
	webset_items_list: { policy: "candidate", kind: "custom_tool_output", reason: "Webset item lists can be large." },
	webset_item_get: { policy: "candidate", kind: "custom_tool_output", reason: "Webset item details can be recalled." },
	webset_search_create: { policy: "candidate", kind: "custom_tool_output", reason: "Webset search response can be summarized." },
	webset_search_get: { policy: "candidate", kind: "custom_tool_output", reason: "Webset search results can be large." },
	webset_search_cancel: { policy: "conservative", kind: "custom_tool_output", reason: "Cancel confirmation should remain visible." },
	webset_enrichment_create: { policy: "candidate", kind: "custom_tool_output", reason: "Enrichment response can be summarized." },
	webset_enrichment_get: { policy: "candidate", kind: "custom_tool_output", reason: "Enrichment results can be large." },
	webset_enrichment_update: { policy: "candidate", kind: "custom_tool_output", reason: "Enrichment update response can be summarized." },
	webset_enrichment_delete: { policy: "conservative", kind: "custom_tool_output", reason: "Delete confirmation should remain visible." },
	webset_enrichment_cancel: { policy: "conservative", kind: "custom_tool_output", reason: "Cancel confirmation should remain visible." },
	webset_monitor_create: { policy: "candidate", kind: "custom_tool_output", reason: "Monitor response can be summarized." },
};

export function classifyContextSurface(input: ClassifyInput): ToolPolicy {
	if (input.sourceUri?.startsWith("skill://")) {
		return { policy: "candidate", kind: "skill", reason: "Skill content is recoverable by skill URI or DB recall." };
	}
	if (input.customType?.includes("skill")) {
		return { policy: "candidate", kind: "skill", reason: "Skill custom messages can be summarized and recalled." };
	}
	const toolName = input.toolName;
	if (!toolName) return { policy: "candidate", kind: "custom_tool_output", reason: "Unknown context surface is handled by size threshold." };
	const known = KNOWN_TOOL_POLICIES[toolName];
	if (known) {
		if (toolName === "read" && input.sourceUri) {
			return { ...known, kind: input.sourceUri.startsWith("skill://") ? "skill" : "file_read" };
		}
		return known;
	}
	if (toolName.startsWith("mcp__")) {
		return { policy: "candidate", kind: "mcp_output", reason: "MCP output is dynamic and can be large." };
	}
	return { policy: "candidate", kind: "custom_tool_output", reason: "Extension/custom tool output is size-thresholded." };
}
```

- [ ] **Step 4: Run classification tests**

Run:

```bash
bun --cwd=packages/context-gc-plugin test test/tool-classification.test.ts
```

Expected: PASS.


---

### Task 4: Extract payloads and summaries

**Files:**
- Create: `packages/context-gc-plugin/src/extract.ts`
- Create: `packages/context-gc-plugin/src/summary.ts`
- Test: `packages/context-gc-plugin/test/summary.test.ts`

- [ ] **Step 1: Write summary tests**

Create `packages/context-gc-plugin/test/summary.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildFallbackSummary, estimateTokens, limitBytes, selectPayload } from "../src/summary";

describe("summary helpers", () => {
	test("estimates tokens without allocating model-specific encoders", () => {
		expect(estimateTokens("abcd efgh ijkl mnop")).toBeGreaterThanOrEqual(4);
	});

	test("limits UTF-8 bytes without splitting intent", () => {
		expect(limitBytes("abcdef", 4)).toBe("abcd");
	});

	test("builds deterministic summary with source metadata", () => {
		const summary = buildFallbackSummary({
			toolName: "bash",
			kind: "bash_execution",
			text: "line one\nline two\nline three",
		});
		expect(summary).toContain("bash_execution");
		expect(summary).toContain("bash");
		expect(summary).toContain("line one");
	});

	test("selects range and search recall slices", () => {
		const text = "alpha\nbeta\ngamma\ndelta";
		expect(selectPayload(text, { mode: "range", selector: "2-3", maxBytes: 100 })).toBe("beta\ngamma");
		expect(selectPayload(text, { mode: "search", selector: "gam", maxBytes: 100 })).toContain("gamma");
	});
});
```

- [ ] **Step 2: Implement summary helpers**

Create `packages/context-gc-plugin/src/summary.ts`:

```ts
import type { ContextKind } from "./schema";

export interface SummaryInput {
	toolName?: string;
	kind: ContextKind;
	text: string;
	sourceUri?: string | null;
}

export interface SelectPayloadOptions {
	mode?: "summary" | "range" | "search" | "raw";
	selector?: string;
	maxBytes: number;
}

export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

export function limitBytes(text: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return text;
	return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

export function buildFallbackSummary(input: SummaryInput): string {
	const head = input.text.split("\n").slice(0, 6).join("\n");
	const source = input.sourceUri ? ` source=${input.sourceUri}` : "";
	const tool = input.toolName ? ` tool=${input.toolName}` : "";
	return [`Unloaded ${input.kind}.${tool}${source}`, "Preview:", limitBytes(head, 1200)].join("\n");
}

export function normalizeAgentSummary(summary: string): string {
	return limitBytes(summary.trim().replace(/\n{3,}/g, "\n\n"), 4000);
}

export function selectPayload(text: string, options: SelectPayloadOptions): string {
	const mode = options.mode ?? "summary";
	if (mode === "raw") return limitBytes(text, options.maxBytes);
	if (mode === "range" && options.selector) {
		const match = /^(\d+)(?:-(\d+))?$/.exec(options.selector.trim());
		if (!match) return "Invalid range selector. Use N or N-M.";
		const start = Math.max(1, Number(match[1]));
		const end = Math.max(start, Number(match[2] ?? match[1]));
		return limitBytes(text.split("\n").slice(start - 1, end).join("\n"), options.maxBytes);
	}
	if (mode === "search" && options.selector) {
		const needle = options.selector.toLowerCase();
		const lines = text.split("\n");
		const matches: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i].toLowerCase().includes(needle)) continue;
			const from = Math.max(0, i - 2);
			const to = Math.min(lines.length, i + 3);
			matches.push(lines.slice(from, to).map((line, offset) => `${from + offset + 1}:${line}`).join("\n"));
		}
		return limitBytes(matches.join("\n---\n"), options.maxBytes);
	}
	return limitBytes(text, options.maxBytes);
}
```

- [ ] **Step 3: Implement extraction helpers**

Create `packages/context-gc-plugin/src/extract.ts`:

```ts
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

export interface ExtractedPayload {
	text: string;
	mediaType: string;
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
	const parts: string[] = [];
	for (const block of content) {
		if (isTextContent(block)) parts.push(block.text);
		else if (isImageContent(block)) parts.push(`[image:${block.mimeType ?? "unknown"}]`);
		else parts.push(JSON.stringify(block));
	}
	return parts.join("\n");
}

export function extractMessagePayload(message: AgentMessage): ExtractedPayload | null {
	if (message.role === "user" || message.role === "custom") {
		return { text: textFromContent(message.content), mediaType: "text/plain" };
	}
	if (message.role === "toolResult") {
		return { text: textFromContent(message.content), mediaType: "text/plain" };
	}
	return null;
}

function isTextContent(value: unknown): value is TextContent {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "text";
}

function isImageContent(value: unknown): value is ImageContent {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "image";
}
```

- [ ] **Step 4: Run summary tests**

Run:

```bash
bun --cwd=packages/context-gc-plugin test test/summary.test.ts
```

Expected: PASS.

---

### Task 5: Implement context projection transform

**Files:**
- Create: `packages/context-gc-plugin/src/context-transform.ts`
- Test: `packages/context-gc-plugin/test/context-transform.test.ts`

- [ ] **Step 1: Write transform tests**

Create `packages/context-gc-plugin/test/context-transform.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { projectUnloadedContext } from "../src/context-transform";
import type { ContextRecord } from "../src/schema";

function record(overrides: Partial<ContextRecord>): ContextRecord {
	return {
		id: "ctx_a",
		sessionId: "s1",
		sessionFile: null,
		status: "unloaded",
		kind: "tool_result",
		source: { toolName: "bash", toolCallId: "call_a" },
		payloadHash: "hash",
		artifactId: null,
		sourceUri: null,
		summary: "Bash output showed tests passed.",
		tokenEstimate: 1000,
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		unloadedAt: "2026-06-01T00:00:00.000Z",
		recallCount: 0,
		...overrides,
	};
}

describe("projectUnloadedContext", () => {
	test("replaces matching tool result content with summary and recall reference", () => {
		const messages: AgentMessage[] = [
			{ role: "toolResult", toolCallId: "call_a", content: [{ type: "text", text: "very long output" }] },
		];
		const projected = projectUnloadedContext(messages, [record({})]);
		expect(JSON.stringify(projected)).toContain("Context unloaded: ctx_a");
		expect(JSON.stringify(projected)).toContain("context_recall");
		expect(JSON.stringify(projected)).not.toContain("very long output");
	});

	test("does not change unmatched messages", () => {
		const messages: AgentMessage[] = [{ role: "user", content: "hello" }];
		expect(projectUnloadedContext(messages, [record({})])).toEqual(messages);
	});
});
```

- [ ] **Step 2: Implement transform**

Create `packages/context-gc-plugin/src/context-transform.ts`:

```ts
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ContextRecord } from "./schema";

export function projectUnloadedContext(messages: AgentMessage[], records: ContextRecord[]): AgentMessage[] {
	const unloaded = records.filter(record => record.status === "unloaded");
	if (unloaded.length === 0) return messages;
	return messages.map(message => projectMessage(message, unloaded));
}

function projectMessage(message: AgentMessage, records: ContextRecord[]): AgentMessage {
	if (message.role === "toolResult") {
		const record = records.find(candidate => candidate.source.toolCallId && candidate.source.toolCallId === message.toolCallId);
		if (!record) return message;
		return {
			...message,
			content: [{ type: "text", text: placeholder(record) }],
		};
	}
	if (message.role === "custom") {
		const record = records.find(candidate => candidate.source.entryId && message.customType === candidate.source.entryId);
		if (!record) return message;
		return {
			...message,
			content: placeholder(record),
		};
	}
	return message;
}

function placeholder(record: ContextRecord): string {
	const ref = record.artifactId ? ` artifact://ref=${record.artifactId}` : "";
	return [
		`[Context unloaded: ${record.id}${ref}]`,
		`Kind: ${record.kind}`,
		`Summary: ${record.summary}`,
		`Recall: context_recall({ "id": "${record.id}", "mode": "range", "selector": "1-80" })`,
	].join("\n");
}
```

- [ ] **Step 3: Run transform tests**

Run:

```bash
bun --cwd=packages/context-gc-plugin test test/context-transform.test.ts
```

Expected: PASS.

---

### Task 6: Implement agent-facing tools

**Files:**
- Create: `packages/context-gc-plugin/src/tools/context-inventory.ts`
- Create: `packages/context-gc-plugin/src/tools/context-unload.ts`
- Create: `packages/context-gc-plugin/src/tools/context-recall.ts`
- Create: `packages/context-gc-plugin/src/tools/context-pin.ts`
- Test: `packages/context-gc-plugin/test/tools.test.ts`

- [ ] **Step 1: Write tool behavior tests around storage functions**

Create `packages/context-gc-plugin/test/tools.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runContextInventory } from "../src/tools/context-inventory";
import { runContextPin } from "../src/tools/context-pin";
import { runContextRecall } from "../src/tools/context-recall";
import { runContextUnload } from "../src/tools/context-unload";
import { openContextGcStore } from "../src/storage";

const tempDirs: string[] = [];

async function makeStore() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "context-gc-tools-"));
	tempDirs.push(dir);
	const store = openContextGcStore({ dbPath: path.join(dir, "db.sqlite") });
	const payload = store.putPayload("text/plain", "alpha\nbeta\ngamma\ndelta");
	store.upsertRecord({
		id: "ctx_tools",
		sessionId: "session-tools",
		sessionFile: null,
		status: "candidate",
		kind: "tool_result",
		source: { toolName: "bash", toolCallId: "call-tools" },
		payloadHash: payload.hash,
		artifactId: null,
		sourceUri: null,
		summary: "Bash output with Greek labels.",
		tokenEstimate: 4,
	});
	return store;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("context tools", () => {
	test("inventory lists candidates", async () => {
		const store = await makeStore();
		const text = runContextInventory(store, "session-tools", { limit: 10 });
		expect(text).toContain("ctx_tools");
		store.close();
	});

	test("unload marks a candidate unloaded", async () => {
		const store = await makeStore();
		runContextUnload(store, "session-tools", {
			ids: ["ctx_tools"],
			summary: "The bash output contains alpha through delta.",
			reason: "No longer needed in active context.",
		});
		expect(store.getRecord("ctx_tools")?.status).toBe("unloaded");
		store.close();
	});

	test("recall returns bounded range", async () => {
		const store = await makeStore();
		const text = runContextRecall(store, "session-tools", { id: "ctx_tools", mode: "range", selector: "2-3", maxBytes: 100 });
		expect(text).toContain("beta");
		expect(text).toContain("gamma");
		expect(text).not.toContain("alpha");
		store.close();
	});

	test("pin toggles status", async () => {
		const store = await makeStore();
		runContextPin(store, "session-tools", { ids: ["ctx_tools"], pinned: true, reason: "Still active." });
		expect(store.getRecord("ctx_tools")?.status).toBe("pinned");
		store.close();
	});
});
```

- [ ] **Step 2: Implement tool helper functions and ToolDefinition exports**

Create the four tool files with helper functions first, then add OMP tool definitions around them in Task 7. Each helper accepts `ContextGcStore`, `sessionId`, and parsed input; this keeps tests independent of the live extension runner.

`packages/context-gc-plugin/src/tools/context-inventory.ts`:

```ts
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { z } from "zod/v4";
import { inventoryInputSchema } from "../schema";
import type { ContextGcStore } from "../storage";

export type InventoryInput = z.infer<typeof inventoryInputSchema>;

export function runContextInventory(store: ContextGcStore, sessionId: string, input: InventoryInput): string {
	const records = store.listRecords({
		sessionId,
		status: input.status,
		includePinned: input.includePinned,
		limit: input.limit ?? 50,
	});
	if (records.length === 0) return "No context GC records match the filter.";
	return records
		.map(record => [record.id, record.status, record.kind, `${record.tokenEstimate} tokens`, record.summary].join(" | "))
		.join("\n");
}

export function createContextInventoryTool(getStore: () => ContextGcStore, getSessionId: () => string): ToolDefinition<typeof inventoryInputSchema> {
	return {
		name: "context_inventory",
		label: "Context Inventory",
		description: "List context items that can be unloaded, recalled, or pinned.",
		parameters: inventoryInputSchema,
		async execute(_toolCallId, input) {
			return { content: [{ type: "text", text: runContextInventory(getStore(), getSessionId(), input) }] };
		},
	};
}
```

`packages/context-gc-plugin/src/tools/context-unload.ts`:

```ts
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { z } from "zod/v4";
import { CONTEXT_GC_CUSTOM_TYPE, unloadInputSchema } from "../schema";
import type { ContextGcStore } from "../storage";
import { normalizeAgentSummary } from "../summary";

export type UnloadInput = z.infer<typeof unloadInputSchema>;

export function runContextUnload(store: ContextGcStore, sessionId: string, input: UnloadInput): string {
	const summary = normalizeAgentSummary(input.summary);
	const updated: string[] = [];
	for (const id of input.ids) {
		const record = store.getRecord(id);
		if (!record || record.sessionId !== sessionId) continue;
		if (record.status === "pinned") continue;
		store.setStatus(id, "unloaded", summary);
		updated.push(id);
	}
	return updated.length === 0 ? "No matching unpinned context records were unloaded." : `Unloaded context records: ${updated.join(", ")}`;
}

export function createContextUnloadTool(
	getStore: () => ContextGcStore,
	getSessionId: () => string,
	appendEntry: (customType: string, data?: unknown) => void,
): ToolDefinition<typeof unloadInputSchema> {
	return {
		name: "context_unload",
		label: "Context Unload",
		description: "Replace no-longer-needed context with a durable DB-backed summary and recall reference.",
		parameters: unloadInputSchema,
		async execute(_toolCallId, input) {
			const sessionId = getSessionId();
			const text = runContextUnload(getStore(), sessionId, input);
			for (const id of input.ids) {
				appendEntry(CONTEXT_GC_CUSTOM_TYPE, {
					op: "unload",
					id,
					sessionId,
					summary: input.summary,
					reason: input.reason,
					createdAt: new Date().toISOString(),
				});
			}
			return { content: [{ type: "text", text }] };
		},
	};
}
```

`packages/context-gc-plugin/src/tools/context-recall.ts`:

```ts
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { z } from "zod/v4";
import { recallInputSchema } from "../schema";
import type { ContextGcStore } from "../storage";
import { selectPayload } from "../summary";

export type RecallInput = z.infer<typeof recallInputSchema>;

export function runContextRecall(store: ContextGcStore, sessionId: string, input: RecallInput): string {
	const record = store.getRecord(input.id);
	if (!record || record.sessionId !== sessionId) return `Context record not found: ${input.id}`;
	const payload = store.getPayload(record.payloadHash);
	if (!payload) return `Payload missing for context record: ${input.id}`;
	store.incrementRecall(input.id);
	return selectPayload(payload.text, {
		mode: input.mode,
		selector: input.selector,
		maxBytes: input.maxBytes ?? 24000,
	});
}

export function createContextRecallTool(getStore: () => ContextGcStore, getSessionId: () => string): ToolDefinition<typeof recallInputSchema> {
	return {
		name: "context_recall",
		label: "Context Recall",
		description: "Recall DB-backed context previously unloaded by context_unload.",
		parameters: recallInputSchema,
		async execute(_toolCallId, input) {
			return { content: [{ type: "text", text: runContextRecall(getStore(), getSessionId(), input) }] };
		},
	};
}
```

`packages/context-gc-plugin/src/tools/context-pin.ts`:

```ts
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { z } from "zod/v4";
import { CONTEXT_GC_CUSTOM_TYPE, pinInputSchema } from "../schema";
import type { ContextGcStore } from "../storage";

export type PinInput = z.infer<typeof pinInputSchema>;

export function runContextPin(store: ContextGcStore, sessionId: string, input: PinInput): string {
	const status = input.pinned ? "pinned" : "candidate";
	const updated: string[] = [];
	for (const id of input.ids) {
		const record = store.getRecord(id);
		if (!record || record.sessionId !== sessionId) continue;
		store.setStatus(id, status);
		updated.push(id);
	}
	return updated.length === 0 ? "No matching context records were updated." : `${input.pinned ? "Pinned" : "Unpinned"}: ${updated.join(", ")}`;
}

export function createContextPinTool(
	getStore: () => ContextGcStore,
	getSessionId: () => string,
	appendEntry: (customType: string, data?: unknown) => void,
): ToolDefinition<typeof pinInputSchema> {
	return {
		name: "context_pin",
		label: "Context Pin",
		description: "Pin or unpin context records so they are protected from unloading.",
		parameters: pinInputSchema,
		async execute(_toolCallId, input) {
			const sessionId = getSessionId();
			const text = runContextPin(getStore(), sessionId, input);
			for (const id of input.ids) {
				appendEntry(CONTEXT_GC_CUSTOM_TYPE, {
					op: input.pinned ? "pin" : "unpin",
					id,
					sessionId,
					reason: input.reason,
					createdAt: new Date().toISOString(),
				});
			}
			return { content: [{ type: "text", text }] };
		},
	};
}
```

- [ ] **Step 3: Run tool tests**

Run:

```bash
bun --cwd=packages/context-gc-plugin test test/tools.test.ts
```

Expected: PASS.

---

### Task 7: Wire collector, reminders, tools, and transform into extension

**Files:**
- Modify: `packages/context-gc-plugin/src/extension.ts`
- Create: `packages/context-gc-plugin/src/reminder.ts`
- Create: `packages/context-gc-plugin/src/session-state.ts`

- [ ] **Step 1: Implement reminder builder**

Create `packages/context-gc-plugin/src/reminder.ts`:

```ts
import type { ContextRecord } from "./schema";

export function buildUnloadReminder(records: ContextRecord[], thresholdTokens: number): string | null {
	const candidates = records.filter(record => record.status === "candidate");
	const total = candidates.reduce((sum, record) => sum + record.tokenEstimate, 0);
	if (total < thresholdTokens || candidates.length === 0) return null;
	const top = candidates
		.slice(0, 8)
		.map(record => `- ${record.id}: ${record.kind}, ${record.tokenEstimate} tokens, ${record.summary.split("\n")[0]}`)
		.join("\n");
	return [
		"Context GC candidates are available. If any are no longer needed for the active task, call context_unload with ids, a concise summary, and a reason.",
		"Use context_pin for still-active evidence or instructions. Use context_recall before relying on unloaded details.",
		`Candidates (${total} estimated tokens):`,
		top,
	].join("\n");
}
```

- [ ] **Step 2: Implement session state helper**

Create `packages/context-gc-plugin/src/session-state.ts`:

```ts
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ContextRecord } from "./schema";
import type { ContextGcStore } from "./storage";

export function getCurrentSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() ?? "unknown-session";
}

export function getCurrentSessionFile(ctx: ExtensionContext): string | null {
	return ctx.sessionManager.getSessionFile();
}

export function listCurrentRecords(store: ContextGcStore, ctx: ExtensionContext): ContextRecord[] {
	return store.listRecords({ sessionId: getCurrentSessionId(ctx), includePinned: true, limit: 200 });
}
```

- [ ] **Step 3: Wire extension**

Replace `packages/context-gc-plugin/src/extension.ts` with:

```ts
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { projectUnloadedContext } from "./context-transform";
import { extractMessagePayload, textFromContent } from "./extract";
import { buildUnloadReminder } from "./reminder";
import { CONTEXT_GC_CUSTOM_TYPE } from "./schema";
import { getCurrentSessionFile, getCurrentSessionId, listCurrentRecords } from "./session-state";
import { openContextGcStore, type ContextGcStore } from "./storage";
import { buildFallbackSummary, estimateTokens } from "./summary";
import { classifyContextSurface } from "./tool-classification";
import { createContextInventoryTool } from "./tools/context-inventory";
import { createContextPinTool } from "./tools/context-pin";
import { createContextRecallTool } from "./tools/context-recall";
import { createContextUnloadTool } from "./tools/context-unload";

export default function contextGcExtension(pi: ExtensionAPI): void {
	pi.setLabel("Context GC");
	let store: ContextGcStore | null = null;
	const getStore = () => {
		if (!store) store = openContextGcStore();
		return store;
	};
	let currentSessionId = "unknown-session";
	const getSessionId = () => currentSessionId;

	pi.registerTool(createContextInventoryTool(getStore, getSessionId));
	pi.registerTool(createContextUnloadTool(getStore, getSessionId, pi.appendEntry.bind(pi)));
	pi.registerTool(createContextRecallTool(getStore, getSessionId));
	pi.registerTool(createContextPinTool(getStore, getSessionId, pi.appendEntry.bind(pi)));

	pi.on("session_start", (_event, ctx) => {
		currentSessionId = getCurrentSessionId(ctx);
		getStore();
	});

	pi.on("session_shutdown", () => {
		store?.close();
		store = null;
	});

	pi.on("tool_result", async (event, ctx) => {
		await collectToolResult(pi, getStore(), event, ctx);
	});

	pi.on("context", (event, ctx) => {
		currentSessionId = getCurrentSessionId(ctx);
		for (const message of event.messages) {
			const extracted = extractMessagePayload(message);
			if (!extracted) continue;
			const tokens = estimateTokens(extracted.text);
			if (tokens < 1200) continue;
			if (message.role === "custom") {
				const policy = classifyContextSurface({ customType: message.customType });
				if (policy.policy === "pinned") continue;
				const payload = getStore().putPayload(extracted.mediaType, extracted.text);
				const id = `ctx_${payload.hash.slice(0, 16)}`;
				getStore().upsertRecord({
					id,
					sessionId: getCurrentSessionId(ctx),
					sessionFile: getCurrentSessionFile(ctx),
					status: policy.policy === "candidate" ? "candidate" : "pinned",
					kind: policy.kind,
					source: { entryId: message.customType },
					payloadHash: payload.hash,
					artifactId: null,
					sourceUri: null,
					summary: buildFallbackSummary({ kind: policy.kind, text: extracted.text }),
					tokenEstimate: tokens,
				});
			}
		}
		return { messages: projectUnloadedContext(event.messages, listCurrentRecords(getStore(), ctx)) };
	});

	pi.on("before_agent_start", (_event, ctx) => {
		currentSessionId = getCurrentSessionId(ctx);
		const reminder = buildUnloadReminder(listCurrentRecords(getStore(), ctx), 8000);
		return reminder ? { message: { customType: CONTEXT_GC_CUSTOM_TYPE, content: reminder, display: false, attribution: "agent" } } : undefined;
	});
}

async function collectToolResult(pi: ExtensionAPI, store: ContextGcStore, event: ToolResultEvent, ctx: ExtensionContext): Promise<void> {
	const text = textFromContent(event.content);
	const tokens = estimateTokens(text);
	if (tokens < 1200) return;
	const sourceUri = extractSourceUri(event.details);
	const policy = classifyContextSurface({ toolName: event.toolName, sourceUri });
	if (policy.policy === "pinned") return;
	const payload = store.putPayload("text/plain", text);
	const id = `ctx_${payload.hash.slice(0, 16)}`;
	const artifactId = await ctx.sessionManager.saveArtifact(text, `context-gc-${event.toolName}`).catch(() => null);
	const summary = buildFallbackSummary({ toolName: event.toolName, kind: policy.kind, text, sourceUri });
	store.upsertRecord({
		id,
		sessionId: getCurrentSessionId(ctx),
		sessionFile: getCurrentSessionFile(ctx),
		status: "candidate",
		kind: policy.kind,
		source: { toolName: event.toolName, toolCallId: event.toolCallId, uri: sourceUri ?? undefined },
		payloadHash: payload.hash,
		artifactId,
		sourceUri: sourceUri ?? null,
		summary,
		tokenEstimate: tokens,
	});
	pi.appendEntry(CONTEXT_GC_CUSTOM_TYPE, {
		op: "candidate",
		id,
		sessionId: getCurrentSessionId(ctx),
		payloadHash: payload.hash,
		status: "candidate",
		summary,
		createdAt: new Date().toISOString(),
	});
}

function extractSourceUri(details: unknown): string | null {
	if (!details || typeof details !== "object") return null;
	const record = details as Record<string, unknown>;
	const path = record.path ?? record.url ?? record.uri ?? record.source;
	return typeof path === "string" ? path : null;
}

```

- [ ] **Step 5: Run package tests**

Run:

```bash
bun --cwd=packages/context-gc-plugin test
```

Expected: PASS.

- [ ] **Step 6: Run package check**

Run:

```bash
bun --cwd=packages/context-gc-plugin run check
```

Expected: PASS.

---

### Task 8: Add focused integration tests with mocked extension context

**Files:**
- Test: `packages/context-gc-plugin/test/extension.integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `packages/context-gc-plugin/test/extension.integration.test.ts` that exercises the extension factory with a fake API object:

```ts
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import contextGcExtension from "../src/extension";

describe("contextGcExtension", () => {
	test("registers all context tools and lifecycle handlers", () => {
		const registeredTools: string[] = [];
		const registeredEvents: string[] = [];
		const api = {
			setLabel(label: string) {
				expect(label).toBe("Context GC");
			},
			registerTool(tool: { name: string }) {
				registeredTools.push(tool.name);
			},
			on(event: string) {
				registeredEvents.push(event);
			},
			appendEntry() {},
			logger: { debug() {}, warn() {}, error() {} },
			typebox: {},
			zod: {},
			pi: {},
		} as unknown as ExtensionAPI;

		contextGcExtension(api);

		expect(registeredTools).toContain("context_inventory");
		expect(registeredTools).toContain("context_unload");
		expect(registeredTools).toContain("context_recall");
		expect(registeredTools).toContain("context_pin");
		expect(registeredEvents).toContain("context");
		expect(registeredEvents).toContain("tool_result");
		expect(registeredEvents).toContain("before_agent_start");
	});
});
```

- [ ] **Step 2: Run integration test**

Run:

```bash
bun --cwd=packages/context-gc-plugin test test/extension.integration.test.ts
```

Expected: PASS.

---

### Task 9: Add package changelog and verification

**Files:**
- Modify: `packages/coding-agent/CHANGELOG.md`
- Modify: `bun.lock` if dependency resolution changes after `bun install`

- [ ] **Step 1: Update changelog**

Under `packages/coding-agent/CHANGELOG.md` → `## [Unreleased]` → `### Added`, add:

```md
- Added a Context GC extension plugin plan for DB-backed context unloading and recall.
```

If the implementation adds a new publishable workspace package, also create `packages/context-gc-plugin/CHANGELOG.md` with:

```md
# Changelog

## [Unreleased]

### Added

- Added DB-backed context unloading extension with inventory, unload, recall, and pin tools.
```

- [ ] **Step 2: Run focused checks**

Run:

```bash
bun --cwd=packages/context-gc-plugin test
bun --cwd=packages/context-gc-plugin run check
bun check
```

Expected: all commands pass. Use `bun check`, not `tsc`.

- [ ] **Step 3: Manual runtime smoke**

In a fresh OMP session with the plugin enabled:

```text
1. Read a large file with read.
2. Call context_inventory.
3. Call context_unload for the candidate id with a summary.
4. Ask the agent to continue reasoning without recalling; verify the next context contains the summary placeholder, not the original payload.
5. Call context_recall with mode=range and selector=1-20; verify original content returns from SQLite after restarting and resuming the session.
```

Expected: unloaded context remains recallable after process exit/resume.

- [ ] **Step 4: Binary verification if user requests global install**

Only if asked to install globally, run:

```bash
bun --cwd=packages/natives run build
bun --cwd=packages/coding-agent run build
packages/coding-agent/dist/omp --version
packages/coding-agent/dist/omp --smoke-test
```

Expected: version prints and smoke test passes.

---

## Self-review

### Spec coverage

- DB-backed storage: Task 2 stores payloads and records in SQLite.
- Resume durability: Task 2 uses OMP agent data path; Task 6 recall reads DB; Task 9 includes restart/resume smoke.
- Agent decides when to unload: Task 6 provides `context_unload`; Task 7 nudges with reminder.
- Recall support: Task 6 implements `context_recall` with range/search/raw modes.
- Exact tool inventory: Task 3 defines built-in, hidden, dynamic, Exa, webset, MCP, custom, and non-tool policies.
- Skill/file/tool output coverage: Tasks 3, 4, 7 cover tool results, `read`, skill URI/custom messages, and context projection.
- No transcript deletion: Task 5 projects messages without rewriting session JSONL.

### Placeholder scan

The implementation plan includes exact files, commands, test content, and code snippets. It does not leave unknown behavior unstated.

### Type consistency

The shared types originate in `schema.ts`. Storage, tools, transform, and extension snippets use those names consistently: `ContextRecord`, `ContextPayload`, `ContextKind`, `ContextStatus`, `ContextGcStore`, `ContextSource`.

---

## Execution choice

Plan complete. Recommended execution path: **Subagent-Driven** with one agent for storage/tools, one for context transform/extension wiring, and one for tests/review. Inline execution is possible but should still preserve the task order above.
