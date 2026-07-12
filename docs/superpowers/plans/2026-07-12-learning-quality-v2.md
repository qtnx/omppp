# Live Learning v2: Quality, Rating, Background Consolidation

**Goal:** Fix live-learning quality (entries too specific, near-dupes, wrong scope), add an agent-facing rating tool, and add a background LLM consolidation job — all in `packages/coding-agent`.

**Architecture:** Keep the existing classify→write→upsert pipeline; upgrade prompts to extract general principles; add additive SQLite columns for rating/status/repo identity; rank injection by decayed score computed in JS; add a `rate_learning` tool; add a lease-guarded background consolidator subagent mirroring the `memories` jobs pattern.

**Tech stack:** Bun, bun:sqlite (WAL), taskExecutor.runSubprocess subagents, Handlebars .md prompts, arktype tool schemas.

## Evidence driving the design (queried from ~/.omp/agent/agent.db)
- 416 rows: 92 global + 324 repo; injection caps at 40/scope by `updated_at DESC` → blind recency eviction.
- Repo scope fragmented across 29 distinct `cwd` values (git worktrees of the same logical repo).
- Near-duplicate rows confirmed (2× "To save context, don't compact normal messages…").
- One-off task commands stored as durable learnings with confidence 0.92–0.98 ("Làm hẳn một modal mới.", "Edit the profile and push it").

## Global constraints (from AGENTS.md — binding for every package)
- No `console.log` — use `logger` from `@oh-my-pi/pi-utils`. Live-learning log lines MUST start with the `live-learning:` marker so `/learning logs` picks them up.
- Bun APIs over node; `Bun.file`/`Bun.write`; namespace imports for `node:fs`/`node:path`; `Promise.withResolvers()`; ES `#private`; no `private`/`public` keywords except constructor param properties; no `any`; no `ReturnType<>`; no inline/dynamic imports.
- Prompts NEVER built in code: static `.md` files imported `with { type: "text" }`, Handlebars for dynamic parts.
- Tests: no `mock.module()`; per-test `vi.spyOn` + `vi.restoreAllMocks()`; contract-level assertions; no source-grep tests; full-suite safe.
- Typecheck via `bun check` (never tsc). Do NOT commit. No project-wide suites inside packages — focused files only.
- Changelog: `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`.

## Locked contracts

### C1 — Schema migration (additive, idempotent, zero-downtime with old binaries)
In `openLearningDb` after existing DDL, run guarded migration (PRAGMA table_info → ALTER missing only, or try/catch "duplicate column"):
```sql
ALTER TABLE live_learnings ADD COLUMN status TEXT NOT NULL DEFAULT 'active';      -- 'active'|'merged'|'archived'
ALTER TABLE live_learnings ADD COLUMN status_changed_at INTEGER;                  -- set whenever status changes; NULL for legacy
ALTER TABLE live_learnings ADD COLUMN strength REAL NOT NULL DEFAULT 1;
ALTER TABLE live_learnings ADD COLUMN useful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live_learnings ADD COLUMN not_useful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live_learnings ADD COLUMN last_reinforced_at INTEGER;                 -- NULL → fallback updated_at
ALTER TABLE live_learnings ADD COLUMN merged_into TEXT;                           -- surviving entry id
ALTER TABLE live_learnings ADD COLUMN repo_key TEXT;                              -- logical repo identity; NULL for legacy rows

CREATE TABLE IF NOT EXISTS live_learning_feedback (
  id TEXT PRIMARY KEY, learning_id TEXT NOT NULL, session_id TEXT NOT NULL,
  verdict TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_learning_feedback_learning ON live_learning_feedback(learning_id, created_at DESC);

CREATE TABLE IF NOT EXISTS live_learning_jobs (       -- mirrors memories/storage.ts jobs shape
  kind TEXT NOT NULL, job_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
  worker_id TEXT, ownership_token TEXT, started_at INTEGER, finished_at INTEGER,
  lease_until INTEGER, retry_at INTEGER, retry_remaining INTEGER NOT NULL DEFAULT 3,
  input_watermark INTEGER, last_success_watermark INTEGER, last_error TEXT,
  PRIMARY KEY (kind, job_key)
);
```
Backfill (idempotent): `UPDATE live_learnings SET last_reinforced_at = updated_at WHERE last_reinforced_at IS NULL;` — do NOT bulk-backfill repo_key (NULL = legacy keyspace, healed lazily per C2).
Uniqueness stays `UNIQUE(scope, cwd, content_hash)` — no new index. Old binaries writing concurrently keep working; their rows land in the legacy keyspace or bump tombstones, both handled below.

### C2 — repoKey and the repo keyspace
`src/learnings/repo-key.ts`: `export async function resolveRepoKey(cwd: string): Promise<string>` = realpath of the parent dir of `git rev-parse --git-common-dir` (all worktrees of one repo share the common dir); Bun `$` with `.quiet().nothrow()` + `AbortSignal.timeout(2000)`; on any failure/timeout return `cwd`. Cache results in a module-level Map keyed by cwd (cache fallback results too).
- **New repo-scope writes use repoKey AS the scope key**: `cwd` column = repoKey, `repo_key` = repoKey, `content_hash = learningContentHash('repo', repoKey, content)`. The existing UNIQUE(scope,cwd,content_hash) therefore dedupes across worktrees at write time. The originating real cwd is not stored on the row (the audit table already records it per event).
- Global rows: `cwd = ''`, `repo_key = ''` (unchanged keyspace).
- Repo-scope reads: `WHERE scope='repo' AND status='active' AND COALESCE(repo_key, cwd) = <repoKey>`.
- Legacy rows (repo_key NULL) are healed by REKEYING (C4 `healLegacyRepoRows`). Dead-worktree rows whose directory no longer exists stay dormant (documented limitation).

### C3 — Alias + scoring (read-time, computed in JS — never SQL math)
- Alias = first 12 hex chars of `content_hash`, rendered `[l:abc123def456]`.
- `effectiveScore = (strength + 1.5*useful_count − 2*not_useful_count) * exp(−ageDays/halfLifeDays)`; `ageDays` from `last_reinforced_at ?? updated_at`; `halfLifeDays` = setting `learning.halfLifeDays` (default 45).
- Hidden from injection when `not_useful_count − useful_count >= 3` (still active in DB; consolidator decides archive).
- Selection: `status='active'`, per scope, sort by score desc, take `maxEntriesPerScope`.

### C4 — storage.ts API (P1 produces; P2/P3/P4/P5 consume)
```ts
export type LearningStatus = "active" | "merged" | "archived";
export interface LearningEntry { /* existing fields */ status: LearningStatus; statusChangedAt: number | null;
  strength: number; usefulCount: number; notUsefulCount: number; lastReinforcedAt: number | null;
  mergedInto: string | null; repoKey: string | null; }
export interface RankedLearningEntry extends LearningEntry { alias: string; score: number; }

export function listActiveLearnings(db: Database, opts: { repoKey: string; limitPerScope: number; halfLifeDays: number; nowSec: number }): RankedLearningEntry[];
export function healCurrentCwdRows(db: Database, opts: { cwd: string; repoKey: string; nowSec: number }): number; // sync, no subprocess probes
export function healSiblingLegacyCwds(db: Database, opts: { repoKey: string; resolveKey: (cwd: string) => Promise<string>; probeLimit: number; nowSec: number }): Promise<number>; // ≤16 probes per run
export function sweepTombstoneTouches(db: Database, opts: { repoKey: string; nowSec: number }): number;
export function findActiveByAliasPrefix(db: Database, opts: { aliasPrefix: string; repoKey: string }): LearningEntry[]; // >=6 hex chars; [] none, >1 ambiguous; searches global + this repoKey keyspace
export function recordLearningFeedback(db: Database, opts: { learningId: string; sessionId: string; verdict: "useful" | "not_useful"; reason?: string; nowSec: number }): boolean;
export function reinforceLearning(db: Database, opts: { id: string; confidence: number; nowSec: number }): boolean;
export function archiveLearning(db: Database, opts: { id: string; guardUpdatedAt: number | null; nowSec: number }): boolean;
export function rescopeLearning(db: Database, opts: { id: string; scope: LearningScope; repoKey: string; guardUpdatedAt: number; nowSec: number }): boolean;
export function rewriteLearning(db: Database, opts: { id: string; content: string; guardUpdatedAt: number; nowSec: number }): boolean;
export function insertConsolidatedEntry(db: Database, opts: { scope: LearningScope; repoKey: string; content: string; strength: number; usefulCount: number; notUsefulCount: number; confidence: number; createdAt: number; lastReinforcedAt: number | null; nowSec: number }): { id: string };
export function markMergedInto(db: Database, opts: { id: string; into: string; guardUpdatedAt: number; nowSec: number }): boolean;
export interface ConsolidationClaim { jobKey: string; ownershipToken: string; inputWatermark: number; }
export function computeLearningWatermark(db: Database, target: { scope: LearningScope; repoKey: string; nowSec: number }): number; // min(max(updated_at), nowSec-1) over ALL rows (any status) in the keyspace, 0 if none — anything written in the CURRENT second counts as unseen, so a same-second post-snapshot write keeps the job dirty (closes the 1s-granularity race; costs at most one extra convergence run)
export function tryClaimConsolidationJob(db: Database, opts: { jobKey: string; workerId: string; leaseSeconds: number; nowSec: number; inputWatermark: number; retryLimit: number; force?: boolean }): { kind: "claimed"; claim: ConsolidationClaim } | { kind: "skipped_not_dirty" } | { kind: "skipped_running" } | { kind: "skipped_retry_backoff" };
export function markConsolidationSucceeded(db: Database, opts: { claim: ConsolidationClaim; nowSec: number }): boolean;
export function markConsolidationFailed(db: Database, opts: { claim: ConsolidationClaim; error: string; retryDelaySeconds: number; nowSec: number }): boolean;
```
Semantics (locked):
- **Tombstone-aware upsert (fixes B1).** `upsertLearning({scope, repoKey, content, ...})` runs in ONE IMMEDIATE transaction: `INSERT ... ON CONFLICT DO NOTHING`; when changes=0, SELECT the conflicting row: status='active' → reinforce it (strength=MIN(10,strength+1), confidence=MAX, last_reinforced_at=updated_at=now, source/trigger refreshed); status='merged' → `resolveActiveSurvivor` (follow merged_into, ≤5 hops) and reinforce the survivor; survivor archived or chain broken → reactivate the archived/last row: status='active', status_changed_at=now, merged_into=NULL, last_reinforced_at=now, strength=MAX(1,strength). A tombstone is NEVER flipped active while merged_into remains set. `repoKey` is an OPTIONAL param: absent → legacy cwd keyspace (existing callers keep compiling between wave 1 and P4 landing); present + scope='repo' → repoKey keyspace per C2.
- **Tombstone-touch sweep (fixes B2).** Old binaries' ON CONFLICT bumps updated_at on tombstones without touching status. `sweepTombstoneTouches`: rows in the keyspace (global + repoKey, including legacy-cwd rows) with `status<>'active' AND status_changed_at IS NOT NULL AND updated_at > status_changed_at` → apply the same redirect as upsert (reinforce survivor / reactivate), then set `status_changed_at = updated_at` to mark handled. Each row is processed in ONE IMMEDIATE transaction and the handled-marker UPDATE is guarded `WHERE id=? AND updated_at=?` — a concurrent old-binary bump between select and marker re-queues the row next sweep instead of being marked handled unredirected. Rows with `status_changed_at IS NULL` and status<>'active' get status_changed_at=updated_at (adoption, no redirect). Idempotent.
- **Heal (rekey legacy rows, extended coverage).** `healLegacyRepoRows`: (1) rows `scope='repo' AND repo_key IS NULL AND cwd = <current cwd>` → rekey to repoKey; (2) for each OTHER distinct legacy cwd in repo scope: if that directory exists on disk AND `resolveKey(thatCwd)` returns this repoKey → rekey its rows too (heals live sibling worktrees; nested foreign repos excluded because their resolveKey differs; non-existent dirs skipped). Sibling-probe healing runs ONLY inside the consolidator's claimed background run (step 0, before snapshot) — the injection build performs just the current-cwd rekey with zero git probes, keeping first-build latency flat. Rekey = recompute content_hash under repoKey, set cwd=repoKey, repo_key=repoKey; UNIQUE conflict → merge into winner (strength=MIN(10,sum), counts summed capped at 999 — old-binary re-insert/heal oscillation cycles converge but must not inflate counters unbounded — confidence=MAX, last_reinforced_at=MAX, updated_at=now) and mark loser status='merged', status_changed_at=now, merged_into=winner. One guarded transaction per row (`WHERE id=? AND updated_at=?`); stale → skip (next build retries).
- **Feedback ordering.** `recordLearningFeedback` applies the guarded counter UPDATE first (`WHERE id=? AND status='active'`; useful → useful_count+1, strength+0.5, last_reinforced_at=now; not_useful → not_useful_count+1, strength=MAX(0,strength−1)); appends the feedback row ONLY when changes=1; returns false otherwise. Counter updates are relative — no read-modify-write.
- **Job seeding (fixes B3).** `tryClaimConsolidationJob` first runs `INSERT OR IGNORE INTO live_learning_jobs(kind, job_key, status, retry_remaining) VALUES('consolidation', ?, 'idle', ?)`, then the memories-style guarded claim UPDATE (`NOT (status='running' AND lease_until > now)`, dirtiness `input_watermark > COALESCE(last_success_watermark,-1)` unless force, retry_at backoff, retry_remaining > 0); claim sets status='running', worker_id, ownership_token, lease_until=now+leaseSeconds, input_watermark=param. changes=1 → claimed; else diagnose skip kind from the row.
- **Success watermark (never marks unseen data clean).** `markConsolidationSucceeded` sets `last_success_watermark = claim.inputWatermark` — exactly the snapshot the consolidator saw. Consolidator ops bump updated_at past it, so a mutating run leaves the job dirty; the follow-up run (≥intervalDays later) sees already-clean entries, emits all-keep ops, writes nothing, and its success marks the job clean. Cost: at most one cheap convergence run per effective consolidation. Concurrent user writes during apply keep the job dirty — correct.
- **Time discipline.** Every `nowSec` param MUST be computed immediately before the storage call — never captured before an LLM/subagent await (the writer path recomputes after the subagent returns). Watermark correctness assumes a monotone-ish shared wall clock across writer processes on this machine. P1 documents the accepted bound with a test: a write committed with a stale nowSec ≤ last_success_watermark stays unseen until the next fresh write re-dirties the job.
- `reinforceLearning`: strength=MIN(10,strength+1), last_reinforced_at=now, updated_at=now, confidence=MAX(existing,new), `WHERE id=? AND status='active'`.
- `rescopeLearning`/`rewriteLearning`: rekey/rehash with the same conflict→merge rules as heal; optimistic guard on updated_at.
- `resolveActiveSurvivor(db, id, maxHops=5)` exported for reuse by upsert/sweep; follows merged_into with a visited set — >5 hops OR a cycle (possible when consolidation runs merge A→B then later B→A) returns null and the caller reactivates the current row instead of looping.
- Legacy `listLearningEntries` stays exported; injection + `/learning view` move to `listActiveLearnings`.

### C5 — Writer output (prompt ↔ parser)
`LEARNING_WRITER_OUTPUT_SCHEMA.action` enum becomes `["store","skip","reinforce"]`; add `target?: string` (alias of existing entry). `parseWriterAgentDecision` accepts `{action:"reinforce", target:"<alias>"}` → resolve among the `existing` entries passed to the writer → `reinforceLearning`; unresolvable/consolidated-meanwhile target → skip with log (degrades, never corrupts). `renderExistingLearnings` renders `- [l:<alias>] <content>`. Rationale kept despite upsert-reinforce overlap: hash catches only EXACT normalized dupes; the writer catches semantic dupes with different wording (the observed near-dupe class).

### C6 — rate_learning tool
`src/tools/rate-learning.ts`, class `RateLearningTool` mirroring `LearnTool` (`static createIf(session)`: `learning.enabled` && `(session.taskDepth ?? 0) === 0`, else null). Registered in `tools/index.ts` factory map as `rate_learning` + barrel export + top-level force-include gating alongside `learn`. approval `"read"` (local db write only, non-destructive), loadMode `"essential"`.
arktype schema:
```ts
const rateLearningSchema = type({
  ratings: type({ id: type("string").describe("learning alias, e.g. l:abc123def456 or its 6-16 hex-char prefix"),
                  verdict: "'useful' | 'not_useful'",
                  "reason?": "string" }).array().atLeastLength(1).atMostLength(20),
});
```
execute: strip optional `l:` prefix, validate 6–16 hex chars, resolve via `findActiveByAliasPrefix` (repoKey via `resolveRepoKey(session cwd)`), apply `recordLearningFeedback`; per-item result line (`ok` / `unknown id` / `ambiguous` / `stale`); never throws on bad ids. Tool description `src/prompts/tools/rate-learning.md`: call when a listed learning materially helped or misled/was obsolete; fire-and-forget; ids come from the Live Learning Guidance section; batch related ratings; an id may have been consolidated away — `unknown id` is normal, not an error to retry.

### C7 — Consolidator
`src/learnings/consolidate.ts`:
```ts
export interface ConsolidationRunOptions { session: AgentSession; settings: Settings; modelRegistry: ModelRegistry; agentDir: string; force?: boolean; }
export interface ConsolidationRunReport { target: string; outcome: "applied" | "skipped_not_dirty" | "skipped_running" | "skipped_retry_backoff" | "skipped_below_threshold" | "failed"; opsApplied?: number; opsSkippedStale?: number; }
export async function maybeRunLearningConsolidation(options: ConsolidationRunOptions): Promise<ConsolidationRunReport[]>;
```
Flow per target (`global`, then `repo:<repoKey>`): active count + last-success age → `skipped_below_threshold` unless `count >= learning.consolidation.minEntries` AND (last success older than `intervalDays` OR `count >= 2*maxEntriesPerScope`); `force` bypasses count/staleness, never the lease; a forced run on an empty snapshot skips the subagent and succeeds with 0 ops. Watermark dirtiness is enforced inside the claim SQL. Claim → (repo targets) healSiblingLegacyCwds under the lease, ≤16 probes → snapshot entries `(alias, content, scope, strength, usefulCount, notUsefulCount, ageDays, updatedAt)` → subagent (same `taskExecutor.runSubprocess` pattern as the writer; models `learning.consolidation.models` fallback `DEFAULT_WRITER_MODELS`; `AbortSignal.timeout(learning.consolidation.timeoutMs)`; structured output below) → apply ops via guarded storage primitives, one transaction per op, stale/unknown-alias ops skipped and counted → `markConsolidationSucceeded({claim})` / `markConsolidationFailed`. JSON dumps under `<agentDir>/learning-audit/consolidation/<runId>/`; every log line prefixed `live-learning:`. Known accepted loss: ratings landing between snapshot and merge vanish into summed snapshot counts (counters are relative; no corruption).
Consolidator output schema (subagent structured output):
```json
{ "ops": [
  { "op": "merge",   "ids": ["<alias>", "..."], "content": "general principle (may keep one short concrete example clause)" },
  { "op": "rewrite", "id": "<alias>", "content": "generalized wording" },
  { "op": "rescope", "id": "<alias>", "scope": "global" },
  { "op": "archive", "id": "<alias>", "reason": "one-off task instruction | stale | superseded" },
  { "op": "keep",    "id": "<alias>" }
] }
```
merge: `insertConsolidatedEntry` (strength=MIN(10,sum), counts summed capped at 999, created_at=min, last_reinforced_at=max, confidence=max) then `markMergedInto` each source (guarded). Prompt `src/prompts/learnings/consolidate.md`: preserve user intent; generalize principles; archive one-off task commands; merge semantic duplicates; fix scope (project/product facts → repo, cross-project workflow → global); target ≤ maxEntriesPerScope active per target; never invent content; when unsure, keep.
Trigger: `startLearningStartupTask` fires `void maybeRunLearningConsolidation({...}).catch(...)` after subscribing (main session, learning.enabled, `learning.consolidation.enabled`). Injection does NOT wait for it; alias churn on the first turn is tolerated by the tool contract.

### C8 — Injection
`buildLearningDeveloperInstructions` (already async; call sites sdk.ts:2831, command-controller.ts:671, builtin-registry.ts:2285 all await — verified): `resolveRepoKey` → `sweepTombstoneTouches` → `healLegacyRepoRows` → `listActiveLearnings` (sweep + current-cwd heal memoized once per process per repoKey — later builds skip straight to the SELECT; sibling-worktree healing happens inside the consolidator's background run); bullets rendered `- [l:<alias>] <content>`. `injection.md` adds one line: entries are ranked; call `rate_learning` with an entry's id when that learning materially helped or misled.

### C9 — Settings (settings-schema.ts, near existing learning.*)
`learning.halfLifeDays` (number, 45) · `learning.consolidation.enabled` (boolean, true, ui tab interaction/group Agent) · `learning.consolidation.intervalDays` (number, 7) · `learning.consolidation.minEntries` (number, 15) · `learning.consolidation.timeoutMs` (number, 240000) · `learning.consolidation.models` (array, EMPTY_STRING_ARRAY, ui like writer chain).

### C10 — Prompt upgrades (root-cause fix for over-specific entries)
- `classify.md`: add durability gate — store ONLY if the guideline plausibly applies to future sessions/tasks; confidence MUST reflect durability, not sentiment strength. New skip examples: one-off imperative about the current artifact ("Làm hẳn một modal mới", "delete that image", "edit X and push it"), requests to perform work now, task-scoped styling/content decisions.
- `write.md` + `agent-writer-system.md`: replace the no-abstraction rules with: extract the GENERAL principle the user is teaching; keep at most one short concrete example clause when it clarifies; strip incidental task specifics (file names, one-off values) unless the specific IS the preference (URLs, tool names, product names the user wants remembered); still never invent facts or flip intent; if an existing `[l:alias]` entry already covers it → `{"action":"reinforce","target":"<alias>"}`.

## Packages

### P1 storage core (wave 1, heavy_task, self_review)
Owns: `src/learnings/storage.ts`, `src/learnings/repo-key.ts` (new), `packages/coding-agent/test/learnings-storage.test.ts` (new).
Forbidden: index.ts, consolidate.ts, tools/**, prompts/**.
Implements C1–C4. CRITICAL tier tests: migration idempotence (open twice; legacy-shaped fixture gains columns/defaults); upsert dedupes two repoKey-equal writes; **upsert onto merged tombstone reinforces the survivor, never reactivates the loser; onto archived row reactivates it clean (merged_into NULL)**; **sweep redirects old-binary-touched tombstones and is idempotent**; heal rekeys current-cwd rows, merges stats on conflict, and rekeys existing sibling-worktree cwds whose resolveKey matches while skipping foreign nested repos; COALESCE read sees only this keyspace; alias resolution none/one/ambiguous; feedback math incl. floor 0 / cap 10 and **no feedback row when the guarded UPDATE misses**; reinforce; optimistic-guard skip on stale updated_at; insertConsolidatedEntry conflict→reinforce; job lifecycle: **fresh job_key claims successfully (seed)**; two concurrent claims → exactly one wins; expired lease reclaimable; ownership_token mismatch cannot complete; not-dirty skipped; retry_remaining decrements on fail; **success stores claim.inputWatermark (never a recomputed post-apply value)**; **same-second race: two writes sharing nowSec with the claim → job stays dirty after success (watermark = nowSec-1 rule)**; sweep marker guard: concurrent bump between select and marker → row re-queued, not marked handled; resolveActiveSurvivor cycle (A→B, B→A) → null → reactivation, no infinite loop; reactivated archived row keeps not_useful_count so the C3 hide threshold persists.

### P2 consolidator (wave 2, heavy_task, self_review; R on P1)
Owns: `src/learnings/consolidate.ts` (fills parent stub), `src/prompts/learnings/consolidate.md`, `test/learnings-consolidation.test.ts` (new).
Implements C7. Tests spy `taskExecutor.runSubprocess` (namespace import + vi.spyOn, per AGENTS) with canned ops against a real temp db: merge marks sources merged + survivor carries summed stats; stale-guard op skipped and counted; failed subagent → markConsolidationFailed with retry backoff; below-threshold runs no subagent; force bypasses staleness but not an active lease; success stores claim.inputWatermark — a mutating run stays dirty, the subsequent all-keep run converges the job clean, and a concurrent post-snapshot user write keeps the job dirty for the next claim; forced run on an empty target skips the subagent and succeeds with 0 ops; sibling-cwd healing executes inside the claimed run (spy resolveKey), never in the injection build.

### P3 rating tool (wave 2, task; R on P1)
Owns: `src/tools/rate-learning.ts` (new), `src/prompts/tools/rate-learning.md` (new), `src/tools/index.ts` (factory map + barrel export + top-level force-include gating alongside `learn`), `test/tools/rate-learning.test.ts` (new).
Implements C6. Tests: createIf gating (learning.enabled, taskDepth), verdict math via real temp db, unknown/ambiguous/stale reporting, `l:`-prefix parsing.

### P4 runtime + prompts (wave 2, task, self_review; R on P1, C on P2 stub)
Owns: `src/learnings/index.ts`, `src/prompts/learnings/{classify,write,agent-writer-system,injection}.md`, updates to `test/learnings-runtime.test.ts`.
Implements C5, C8, C10; wires the consolidation trigger (spied in tests); resolveRepoKey + sweep + current-cwd heal in build (sibling healing belongs to P2's consolidator); passes repoKey through upsert; `loadLearningConfig` gains halfLifeDays + consolidation keys; writer input renders aliases via `renderExistingLearnings`.
Tests: reinforce path end-to-end (writer returns reinforce → strength bump, no new row; unknown target → skip); injection renders aliases, score order, hidden entries excluded; repo section uses repoKey keyspace; config defaults; build call sites keep working (existing tests).

### P5 slash commands (wave 2, task; R on P1/P2)
Owns: `src/slash-commands/builtin-registry.ts` (learning command block), `src/modes/controllers/command-controller.ts` (learning block), `test/slash-commands/learning.test.ts` updates.
Adds: `/learning consolidate` (force run; reports per-target outcome + ops applied/skipped), `/learning drop <alias>` (archiveLearning unguarded; reports unknown/ambiguous), `view` shows alias + score + strength/votes per entry.

### P6 settings + changelog (wave 1, quick_task)
Owns: `src/config/settings-schema.ts` (C9), `packages/coding-agent/CHANGELOG.md` (Unreleased: Added rate_learning tool + background consolidation + prompt quality overhaul; Changed injection ranking + repo-scope keying by repo identity).
Forbidden: everything else. Acceptance: `bun check` clean on the package.

### Gates (final)
One agent: `bun check`, then `bun test packages/coding-agent/test/learnings-runtime.test.ts packages/coding-agent/test/learnings-storage.test.ts packages/coding-agent/test/learnings-consolidation.test.ts packages/coding-agent/test/tools/rate-learning.test.ts packages/coding-agent/test/slash-commands/learning.test.ts` — report verbatim outputs.

## Sequencing
Parent prefix (before workflow): `src/learnings/consolidate.ts` stub exporting the C7 signature (no-op returning []) so P4 compiles independently of P2 timing.
Wave 1: P1, P6 (parallel). Wave 2 (after wave-1 barrier): P2, P3, P4, P5 (parallel). Gates last. ONE workflow run.

## Non-goals
- No bulk rewrite of historical rows beyond heal/sweep + consolidator ops.
- No change to memories/autolearn subsystems, audit DB table shape, or classifier transport.
- No removal of legacy `listLearningEntries`.
- Rows under never-revisited dead worktrees stay dormant (documented limitation).
