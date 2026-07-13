# Crash Report Design

Date: 2026-07-12
Branch: `feat/crash-report`
Status: approved design (v2 after super_review)

## Problem

OMPx dies (or soft-fails hard) without leaving a durable, user-visible diagnosis.

Today:

- JS fatal path (`packages/utils/src/postmortem.ts`) dumps to stderr + `logger.error`, runs cleanup, `process.exit(1)`. No durable crash artifact.
- `getCrashLogPath()` exists (`~/.omp/agent/omp-crash.log`) but is unused and **diverges** from native crash location under `getLogsDir()`.
- Native already writes `native-{panic|alloc}-{pid}-{ms}.log` under `getLogsDir()` via `crates/pi-natives/src/crash_handler.rs`.
- TUI has `ErrorBanner` for turn/provider errors, not process crashes or render throws.
- Manual `createReportBundle` exists; it is not auto-invoked on crash.

User need (scope C): when the app crashes or soft-fails with a stack, the user must see **what failed and where the report lives**, so they can fix or file a bug.

## Goals

1. Persist every fatal JS crash and every whitelisted soft-fail as a local report file.
2. Surface unread reports on the next interactive launch (and via `/crash`).
3. Include native panic/alloc logs in the same unread scan (no Rust rewrite).
4. Never spam: multi-session safe, soft-fail deduped/rate-limited, first upgrade does not dump history.

## Non-goals

- Remote telemetry / Sentry.
- Auto full debug tar.gz on every crash.
- Logging ordinary validation/`showError` messages (missing flags, unknown subcommands, etc.).
- Changing native panic format or hook install.

## Approach

**Crash file + next-launch banner** (approach 1), revised after adversarial review:

- Per-event files under **`getLogsDir()`** (unified with native).
- Sync write first on fatal path; JSONL one-record files.
- Unified seen-marker for JS + native.
- Soft-fail API with whitelist + process-local dedupe/rate-limit.
- Interactive banner + `/crash`; print/RPC stderr-only.

Rejected:

- Auto tar.gz on crash (I/O race with exit).
- Single append file (multi-session interleave).
- Full crash-center UI (overkill).

## Architecture

```text
                 fatal JS
postmortem ----> writeCrashReportSync ----> ~/.omp/logs/crash-*.jsonl
   |                    |
   v                    v
 stderr dump        cleanup -> exit(1)

soft boundary ----> reportSoftCrash ----> same dir (+ UI if available)

native panic  ----> (existing) native-*.log under same logs dir

interactive startup ----> listUnreadCrashArtifacts ----> banner
                              ^
                       crash-seen.json (seenUntilMs)

/crash [dismiss] ----> show last / advance marker
```

### Package ownership

| Package | Responsibility |
|---|---|
| `packages/utils` | Crash report core: write/read/list/mark-seen, path helpers, postmortem wiring, soft API, redaction |
| `packages/coding-agent` | Soft call sites (TUI/render/init/extension), interactive banner, `/crash` command, changelog entry |
| `crates/pi-natives` | Unchanged; only scanned as artifacts |

## Storage

### Directory

All crash artifacts live under **`getLogsDir()`** (today: `~/.omp/logs/` or XDG state equivalent).

### File names

| Kind | Pattern | Writer |
|---|---|---|
| JS fatal / soft | `crash-{kind}-{pid}-{ms}.jsonl` | `writeCrashReportSync` |
| Native (existing) | `native-{panic\|alloc}-{pid}-{ms}.log` | Rust crash_handler |
| Seen marker | `crash-seen.json` | utils |

`kind` in JS filenames: `uncaught_exception` | `unhandled_rejection` | `soft` (and optionally `native_notice` if we ever synthesize a JS wrapper — not required; native files are scanned as-is).

### `getCrashLogPath()`

**Deprecate the old agent-subdir semantics.** Implementation becomes:

```ts
/** Directory containing crash + native crash artifacts (alias of getLogsDir). */
export function getCrashReportsDir(): string {
	return getLogsDir();
}

/**
 * Best-effort path of the newest JS crash-*.jsonl under getLogsDir(), or
 * path.join(getLogsDir(), "crash-latest.jsonl") when none exist yet.
 * Not a single append target — writers always create per-event files.
 */
export function getCrashLogPath(): string { /* newest crash-*.jsonl or sentinel */ }
```

No code writes a monolithic append-only `omp-crash.log`. Existing zero callers of the old path are unaffected.

### Record format (one JSON object, one line)

```json
{
  "ts": "2026-07-12T15:58:00.000Z",
  "tsMs": 1720799880000,
  "version": "1.x.y",
  "pid": 12345,
  "kind": "unhandled_rejection",
  "label": "Unhandled Rejection",
  "name": "TypeError",
  "message": "…redacted…",
  "stack": "…",
  "cwd": "/path/to/project",
  "sessionFile": "/path/to/session.jsonl",
  "context": { "boundary": "tool-renderer", "toolName": "bash" },
  "count": 1
}
```

- `count` is always `1` on disk for v1. Soft dedupe keeps later hits **in-memory only** (no second file, no rewrite). Optional final rewrite on process idle is **out of scope**.

### Redaction

Before write, apply:

- Token-like patterns in `message` (and optionally first line of stack): `sk-…`, `Bearer …`, long base64-ish secrets, common `api[_-]?key` assignments.
- Cap `message` and `stack` length (e.g. 8 KiB / 64 KiB) to bound disk.
- Never put env, full request/response bodies, or prompts into `context`.

Document in file header comment / user banner: reports are **local-only** and may contain absolute paths under `$HOME`.

## Fatal path (postmortem)

On `uncaughtException` / `unhandledRejection` (after existing expected-cleanup / EPIPE / interceptor filters):

1. **Reentrancy guard** (`alreadyReportingFatal`): if already true, skip write and go to exit.
2. **`writeCrashReportSync(...)`** using `node:fs` **sync** APIs only (`mkdirSync`, `writeFileSync`). Catch **everything** including EACCES; never throw.
3. Existing `formatFatalError` → stderr.
4. Existing `logger.error`.
5. `runCleanup(...)`.
6. `process.exit(1)`.

Order is mandatory: **file before async cleanup**. Do not use `Bun.write` on the fatal path.

## Soft-fail API

```ts
reportSoftCrash(input: {
  label: string;
  error: unknown;
  context?: Record<string, string | number | boolean | null>;
}): { path: string | null; deduped: boolean }
```

### Whitelist (only these call sites in v1)

| Boundary | Package location (approx) |
|---|---|
| TUI / transcript render throw | coding-agent modes / tui render paths |
| Tool renderer unexpected throw | coding-agent tool renderers |
| Session / main init failure before UI | coding-agent `main` / session bootstrap |
| Extension load hard-fail | coding-agent extension load |

Not in whitelist: user validation errors, provider content-policy messages, MCP connect failures that already have clear UI text without stack.

### Dedupe / rate limit (process-local)

- Key: `label + "\0" + message` (message after redaction, truncated).
- First hit: write file, return path.
- Later hits: increment in-memory count; **no** new file; return `{ path: firstPath, deduped: true }`.
- Optional hard cap: max N distinct soft keys per process (e.g. 20); further keys only `logger.error`.

### Pre-UI init failure

Write file + stderr (and logger). No banner (UI not up). Interactive resume of a later session still shows unread via marker.

## Seen marker

File: `path.join(getLogsDir(), "crash-seen.json")`

```json
{ "seenUntilMs": 1720799880000 }
```

### Rules

- **First read when missing:** create with `seenUntilMs = Date.now()` so upgrade/first-run does **not** surface historical `native-*.log` / old crashes.
- **Unread artifact:** JS file `tsMs` (from filename or record) **or** native file mtime/name timestamp **> seenUntilMs**.
- **Dismiss / mark seen:** set `seenUntilMs = max(seenUntilMs, max(unread timestamps), Date.now())`.
- One marker covers **both** JS and native.

### Concurrent sessions

Per-event files avoid append interleave. Marker races: last writer wins; worst case a crash is shown twice — acceptable.

## Surface

### Interactive startup

After TUI is up (near changelog block):

- If any unread artifact: show **pinned** banner (ErrorBanner-style, scroll-safe):
  - Title: last crash kind/label
  - 1–3 lines of message
  - Path to file
  - Hint: `/crash` · dismiss on next send or `/crash dismiss`
- Do not block input.

### `/crash`

| Invocation | Behavior |
|---|---|
| `/crash` | Show latest report summary + path (and note if more unread) |
| `/crash dismiss` | Advance seen marker; clear banner |

Implementation: built-in slash command handler in interactive command controller (same pattern as other built-ins), not a markdown custom command.

### Print / RPC / non-interactive

- On fatal: existing stderr dump **plus** one line: `Crash report: <path>` when write succeeded.
- No startup banner.
- No persistent “unread” nagging in print mode.

## Observability

- Fatal: `logger.error("process_crash", { kind, path, name, message })` once at write site (postmortem already logs; keep single structured line if easy).
- Soft: `logger.error("soft_crash", { label, path, deduped })` once per first occurrence.
- No ERROR spam on deduped soft hits (DEBUG optional).

## Testing / acceptance

| # | Case | Expect |
|---|---|---|
| 1 | Unit write/read/list | Per-event file under logs dir; valid JSON |
| 2 | Unit mark-seen / first-run | Missing marker → init now; historical not unread |
| 3 | Unit soft dedupe | Same key twice → one file |
| 4 | Unhandled rejection fixture | exit 1, file exists, stderr has stack + path line |
| 5 | Soft render throw loop | Process lives; ≤1 file for that key; UI shows path if interactive |
| 6 | Pre-UI init fail | File + stderr; no throw from writer |
| 7 | Native fixture log newer than marker | Startup banner shows native path |
| 8 | Dismiss | Marker advanced; restart → no banner |
| 9 | Print mode fatal | Exactly one crash-report path line (plus stack dump) |
| 10 | Write failure (read-only dir) | Process still exits 1; no secondary throw |

## Rollout

1. Ship utils core + postmortem wiring (behavior change: durable files).
2. Wire soft call sites + banner + `/crash`.
3. Changelog under coding-agent (and utils if exported API is user-relevant).

## Risks

| Risk | Mitigation |
|---|---|
| Paths/PII in reports | Local-only; redact tokens; document |
| Soft render loop spam | Dedupe + cap |
| Fatal write fails | Catch-all; still stderr |
| Marker races | Accept rare double-show |
| Path rename from unused getCrashLogPath | No callers; tests pin new location |

## Open decisions locked by this spec

1. Storage: **`getLogsDir()` per-event files**, not agent `omp-crash.log` append.
2. Soft: whitelist + process dedupe; no auto tar.gz.
3. Seen: **timestamp marker**, first-run init to now.
4. Logger tail: **not** in v1.
5. Native: scan only, no Rust change.
