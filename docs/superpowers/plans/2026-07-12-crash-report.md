# Crash Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Checkbox steps track progress.

**Goal:** Persist JS fatal + soft crashes under `getLogsDir()`, show unread reports on next interactive launch and via `/crash`, scan native crash logs with the same seen-marker.

**Architecture:** New `packages/utils/src/crash-report.ts` (sync per-event JSONL writers, soft dedupe, seen-marker). Wire into `postmortem` fatal handlers (write **before** cleanup/exit). Coding-agent surfaces unread artifacts at interactive startup + `/crash`; soft call sites use `reportSoftCrash`.

**Tech Stack:** Bun, TypeScript, node:fs sync on fatal path, existing ErrorBanner / builtin slash registry.

**Spec:** `docs/superpowers/specs/2026-07-12-crash-report-design.md`

## Global Constraints

- Fatal path: `node:fs` **sync only**; catch-all; reentrancy guard; order write → stderr → cleanup → exit.
- Per-event files under `getLogsDir()`: `crash-{kind}-{pid}-{ms}.jsonl`. No monolithic append.
- First-run `crash-seen.json` init to now (no historical spam).
- Soft: process-local dedupe by `label\0message`; max 20 distinct keys; whitelist only.
- No `console.*` in coding-agent; no commit unless user asks.
- Tests: behavior only, no source-grep; isolate dirs via temp + `__resetDirsFromEnvForTests` / `PI_CONFIG_DIR` pattern.

## File map

| File | Role |
|---|---|
| `packages/utils/src/crash-report.ts` | Core API |
| `packages/utils/src/dirs.ts` | `getCrashReportsDir`, repoint `getCrashLogPath` |
| `packages/utils/src/postmortem.ts` | Fatal write + stderr path line |
| `packages/utils/src/index.ts` | Export crash-report |
| `packages/utils/test/crash-report.test.ts` | Unit tests |
| `packages/utils/test/postmortem-crash-report.test.ts` | Subprocess fatal fixture |
| `packages/utils/CHANGELOG.md` | Unreleased |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | `/crash` |
| `packages/coding-agent/src/modes/interactive-mode.ts` | Startup unread banner |
| soft sites (tool-execution / main / extension load) | `reportSoftCrash` |
| `packages/coding-agent/CHANGELOG.md` | Unreleased |

## Locked API (`packages/utils/src/crash-report.ts`)

```ts
export type CrashKind = "uncaught_exception" | "unhandled_rejection" | "soft";

export interface CrashRecord {
  ts: string;
  tsMs: number;
  version: string;
  pid: number;
  kind: CrashKind;
  label: string;
  name: string;
  message: string;
  stack: string;
  cwd: string;
  sessionFile?: string;
  context?: Record<string, string | number | boolean | null>;
  count: number;
}

export interface CrashArtifact {
  path: string;
  source: "js" | "native";
  tsMs: number;
  kind: string;
  summary: string;
}

export function getCrashReportsDir(): string; // = getLogsDir()
export function getCrashLogPath(): string; // newest crash-*.jsonl or join(dir,"crash-latest.jsonl")
export function writeCrashReportSync(input: {
  kind: CrashKind;
  label: string;
  error: unknown;
  sessionFile?: string;
  context?: Record<string, string | number | boolean | null>;
}): string | null;
export function reportSoftCrash(input: {
  label: string;
  error: unknown;
  sessionFile?: string;
  context?: Record<string, string | number | boolean | null>;
}): { path: string | null; deduped: boolean };
export function ensureCrashSeenMarker(): { seenUntilMs: number };
export function listUnreadCrashArtifacts(): CrashArtifact[];
export function markCrashArtifactsSeen(upToMs?: number): void;
export function formatCrashReportPathLine(path: string): string; // "Crash report: <path>"
export function __resetCrashReportStateForTests(): void; // clear soft dedupe + reentrancy
```

Filename: `crash-${kind}-${pid}-${tsMs}.jsonl`
Marker: `crash-seen.json` → `{ seenUntilMs: number }`
Native scan: `native-*.log` under same dir; parse ts from name when possible else mtime.

---

### Task 1: Utils crash-report core + dirs + postmortem

**Files:** create `crash-report.ts`; modify `dirs.ts`, `postmortem.ts`, `index.ts`; tests; utils CHANGELOG.

- [ ] **Step 1:** RED tests in `packages/utils/test/crash-report.test.ts` covering write/read JSON, soft dedupe one file, first-run marker hides old files, mark-seen clears unread, redaction strips `sk-` tokens, write never throws on bad path (inject via isolated logs dir).
- [ ] **Step 2:** Implement `crash-report.ts` + dirs helpers; export from index; wire postmortem fatal handlers to call `writeCrashReportSync` first then append `Crash report: path` to stderr when path non-null.
- [ ] **Step 3:** Subprocess test: probe throws unhandled rejection → exit 1 + file under temp logs + stderr contains path line.
- [ ] **Step 4:** `bun --cwd packages/utils test test/crash-report.test.ts test/postmortem-crash-report.test.ts` green; `bun --cwd packages/utils run check:types` green.

### Task 2: Coding-agent surface (`/crash` + startup banner)

**Files:** `builtin-registry.ts`, `interactive-mode.ts`, coding-agent CHANGELOG.

- [ ] After TUI welcome/changelog: `listUnreadCrashArtifacts()`; if any, `showPinnedError` with latest summary + path + `/crash` hint.
- [ ] Register `/crash` (allowArgs): no args → dump latest/unread summary via `runtime.output`; `dismiss` → `markCrashArtifactsSeen` + `clearPinnedError`.
- [ ] Dismiss on next user send: clear pinned crash banner only if it was crash-originated (track flag) OR rely on ErrorBanner already clearing on next message — prefer explicit dismiss + next-send clear via existing `clearPinnedError` if wired; if ErrorBanner auto-clears on next message, document that.

### Task 3: Soft-fail whitelist call sites

**Files:** tool renderer path (`tool-execution.ts` or transcript builder), session/main init catch, extension load hard-fail.

- [ ] Wrap unexpected throws with `reportSoftCrash({ label, error, context })`; if path, surface via `showPinnedError` / `showError` including path when UI exists; pre-UI: stderr via path line.
- [ ] Render loop: one soft report per key (dedupe in utils).

### Task 4: Integration verify

- [ ] Focused utils tests green.
- [ ] Manual/subprocess: force soft + fatal fixtures.
- [ ] `bun check` scoped or package typecheck.

---

## Wave plan

| Pkg | Owns | Needs | C/R | Tier | Wave | Acceptance |
|---|---|---|---|---|---|---|
| P1 UtilsCrash | utils crash-report + dirs + postmortem + tests + changelog | — | — | heavy_task | 1 | utils crash tests green |
| P2 AgentSurface | builtin `/crash` + interactive banner + changelog | P1 API | R | task | 2 | typecheck coding-agent; manual logic via unit if any |
| P3 SoftSites | soft call sites | P1 API | R | task | 2 | call sites compile; soft dedupe covered in utils |

Wave 1 = P1. Wave 2 = P2+P3 parallel after P1 lands.
