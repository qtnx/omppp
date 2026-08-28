# Time Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/time-budget <duration>` so the main coding-agent session manages an active-work deadline, receives honest five-minute pacing reminders, shows elapsed/remaining time in the status line, and records outcomes in `ompx stats`.

**Architecture:** A session-scoped `TimeBudgetController` owns parsing, active-time accounting, checkpoint scheduling, persistence, and resume. `AgentSession` supplies lifecycle and message-delivery adapters; prompts remain static Markdown/Handlebars templates appended at the context tail so five-minute updates preserve the existing prompt-cache prefix. The stats package parses the controller's custom session entries into idempotent per-run rows and exposes aggregate cards in the existing dashboard.

**Tech Stack:** TypeScript, Bun, Handlebars through `@oh-my-pi/pi-utils` prompt utilities, JSONL session entries, Bun SQLite, React stats dashboard.

**Spec:** Approved requirements in the 2026-08-28 conversation; copied verbatim as executable constraints below.

## Global Constraints

- Command forms: `/time-budget <duration>`, `/time-budget` for status, `/time-budget off`, `/time-budget +<duration>` for extension.
- Durations accept minutes, hours, and compounds such as `10m`, `2h`, `1h30m`; minimum activation budget is `10m`.
- Overtime is soft: never abort the turn solely because time expired; keep counting and record overtime.
- The clock counts only active main-agent processing time. It pauses while the main session is idle, closed, or offline.
- Only the main session owns the time budget. It must manage subagent deadlines and critical-path work through its reminders; no budget controller is inherited by subagent sessions.
- Append reminders at the context tail. Never rewrite the base system prompt or an earlier user message; preserve prefix-cache stability.
- Append one activation reminder immediately, one checkpoint reminder per five active minutes, and one overtime reminder when the budget is first crossed. A long event-loop stall may collapse missed checkpoints into one current-state reminder; never replay a burst of stale reminders.
- Every reminder must enforce honest completion: no fabricated output, no skipped required verification presented as passing, no fake “done”. Near deadline, cut ceremony and optional scope—not correctness, requested behavior, or RISK gates.
- Persist entries with the locked wire contract below. Malformed persisted data is ignored during restore/stats sync rather than crashing the session.
- Show elapsed and remaining time while within budget, and elapsed plus overtime after expiration.
- `ompx stats` exposes total time-budget runs, within-budget vs overtime counts, and average overtime.
- No new dependencies. No generated file is edited by hand. No commit unless explicitly requested.

### Locked session-entry contract

```ts
export const TIME_BUDGET_CUSTOM_TYPE = "time_budget";

export type TimeBudgetEvent = "activate" | "extend" | "checkpoint" | "overtime" | "deactivate";

export interface TimeBudgetEntryData {
	event: TimeBudgetEvent;
	/** Total budget after this event. */
	budgetMs: number;
	/** Accumulated active main-session work at this event. */
	activeMs: number;
	/** Wall-clock epoch milliseconds when the entry was appended. */
	at: number;
}
```

A run begins at `activate`. `extend` preserves `activeMs` and increases `budgetMs`. `checkpoint` persists progress without ending the run. `overtime` is emitted once when `activeMs >= budgetMs`. `deactivate` closes the run. A session may contain multiple runs; an unclosed final run remains resumable.

---

## File Map

### Create

- `packages/coding-agent/src/session/time-budget.ts` — parser, controller, snapshot formatting, restore, active-time scheduler.
- `packages/coding-agent/src/prompts/system/time-budget-activation.md` — static activation policy.
- `packages/coding-agent/src/prompts/system/time-budget-checkpoint.md` — Handlebars checkpoint/overtime policy.
- `packages/coding-agent/test/time-budget.test.ts` — controller and parser behavior.
- `packages/stats/test/time-budget-stats.test.ts` — malformed input, multiple runs, incremental sync, idempotency, aggregates.

### Modify

- `packages/coding-agent/src/session/agent-session.ts` — instantiate/dispose controller, adapt run-state and hidden reminder delivery, expose command/status methods, restore on session adoption.
- `packages/coding-agent/src/slash-commands/builtin-modes.ts` — register `/time-budget` for TUI/ACP/RPC through the shared handler.
- `packages/coding-agent/src/modes/components/status-line/segments.ts` — render active budget alongside the existing mode segment.
- `packages/stats/src/types.ts` — parser/runtime record types.
- `packages/stats/src/parser.ts` — validate and emit time-budget custom entries.
- `packages/stats/src/db.ts` — schema and migration for per-run rows.
- `packages/stats/src/aggregator.ts` — idempotent synchronization and aggregate query.
- `packages/stats/src/shared-types.ts` — dashboard payload contract.
- `packages/stats/src/server.ts` — include time-budget aggregates in `getDashboardStats` response path.
- `packages/stats/src/client/**` — one compact dashboard section/card group following the newest existing metric section.
- `packages/stats/src/embedded-client.generated.txt` — regenerate only with `bun --cwd packages/stats run gen:stats`.
- `packages/coding-agent/CHANGELOG.md` and `packages/stats/CHANGELOG.md` — user-facing Unreleased entries after behavior passes.

---

### Task 1: Time Budget Runtime

**Files:**
- Create: `packages/coding-agent/src/session/time-budget.ts`
- Create: `packages/coding-agent/test/time-budget.test.ts`

**Interfaces:**

```ts
export const MIN_TIME_BUDGET_MS = 10 * 60_000;
export const TIME_BUDGET_CHECKPOINT_MS = 5 * 60_000;
export const TIME_BUDGET_CUSTOM_TYPE = "time_budget";

export type ParsedTimeBudgetCommand =
	| { action: "status" }
	| { action: "off" }
	| { action: "activate"; durationMs: number }
	| { action: "extend"; durationMs: number };

export interface TimeBudgetSnapshot {
	active: boolean;
	running: boolean;
	budgetMs: number;
	activeMs: number;
	remainingMs: number;
	overtimeMs: number;
	overtimeLogged: boolean;
}

export interface TimeBudgetControllerOptions {
	now?: () => number;
	appendEntry: (data: TimeBudgetEntryData) => void;
	sendReminder: (kind: "activation" | "checkpoint" | "overtime", snapshot: TimeBudgetSnapshot) => Promise<void>;
}

export class TimeBudgetController {
	constructor(options: TimeBudgetControllerOptions);
	restore(entries: readonly unknown[]): void;
	activate(durationMs: number): Promise<TimeBudgetSnapshot>;
	extend(durationMs: number): Promise<TimeBudgetSnapshot>;
	deactivate(): TimeBudgetSnapshot | null;
	setRunState(state: "running" | "idle"): void;
	snapshot(): TimeBudgetSnapshot | null;
	dispose(): void;
}

export function parseTimeBudgetCommand(args: string): ParsedTimeBudgetCommand | string;
export function formatTimeBudgetSnapshot(snapshot: TimeBudgetSnapshot): string;
```

- [ ] **Step 1: Write parser tests.** Cover empty/status, `10m`, `2h`, `1h30m`, `+15m`, `off`, unitless/negative/unknown input, and activation below 10m. Extension may be below 10m because it augments an already valid run.

```ts
test("parses compound durations and extensions", () => {
	expect(parseTimeBudgetCommand("1h30m")).toEqual({ action: "activate", durationMs: 5_400_000 });
	expect(parseTimeBudgetCommand("+5m")).toEqual({ action: "extend", durationMs: 300_000 });
});
```

- [ ] **Step 2: Run `bun test packages/coding-agent/test/time-budget.test.ts` and confirm RED** because the module does not exist.

- [ ] **Step 3: Implement a full-string duration parser.** Consume one or more `<positive number><m|h>` components, reject trailing or duplicated garbage, sum safely, and reject non-finite/overflow values. Return usage text as a string error, matching `parseLoopLimitArgs` conventions without importing loop semantics.

- [ ] **Step 4: Write controller tests with a fake monotonic clock.** Prove:
  - idle time never changes `activeMs`;
  - running windows accumulate and fold at `idle`;
  - one reminder fires at each crossed five-minute active boundary;
  - crossing the deadline emits exactly one `overtime` event/reminder;
  - a delayed callback collapses missed buckets instead of emitting a burst;
  - extend preserves elapsed time and changes remaining time;
  - deactivate closes the run;
  - restore takes the last open activation span and resumes from its latest valid `activeMs`, without charging offline time;
  - malformed custom entries are skipped.

- [ ] **Step 5: Implement the controller.** Maintain `#activeMs`, `#activeStartedAt`, `#nextCheckpointMs`, one timeout for the next checkpoint/deadline, and `#overtimeLogged`. On every transition to idle, append a checkpoint silently so a crash/restart loses at most the currently running process window; do not inject a pacing reminder at every short turn.

- [ ] **Step 6: Run `bun test packages/coding-agent/test/time-budget.test.ts` and confirm all controller/parser cases pass.**

---

### Task 2: Prompt Policy and AgentSession Integration

**Files:**
- Create: `packages/coding-agent/src/prompts/system/time-budget-activation.md`
- Create: `packages/coding-agent/src/prompts/system/time-budget-checkpoint.md`
- Modify: `packages/coding-agent/src/session/agent-session.ts`
- Modify: `packages/coding-agent/test/time-budget.test.ts`

**Interfaces:**

```ts
// AgentSession public surface
getTimeBudgetSnapshot(): TimeBudgetSnapshot | null;
handleTimeBudgetCommand(args: string): Promise<string>;
```

`handleTimeBudgetCommand` returns operator-facing text for the slash-command output sink. It owns state changes and rejects extension when no budget is active.

- [ ] **Step 1: Write integration tests around an AgentSession-compatible harness.** Assert activation appends one hidden custom message and one `time_budget` custom entry; run-state changes advance only active time; `off` appends `deactivate`; restore resumes latest open run.

- [ ] **Step 2: Write `time-budget-activation.md`.** It must tell the main agent:
  - finish the current user task within the active-work budget when realistically possible;
  - immediately identify the critical path and remaining externally observable deliverables;
  - use direct execution for one slice and parallel subagents only for genuinely independent ready slices;
  - bound each subagent `max_runtime_seconds` by remaining budget, monitor blockers, and cancel nonessential work;
  - use the cheapest named-failure gate, preserve RISK-list gates, and never trade correctness for a cosmetic deadline;
  - never fabricate commands, outputs, tests, or completion; overtime/incomplete work must be reported honestly.

- [ ] **Step 3: Write `time-budget-checkpoint.md` as a Handlebars template** with `elapsed`, `remaining`, `overtime`, `percentUsed`, and `phase` (`steady`, `accelerate`, `wrap-up`, `overtime`). It must force a fresh critical-path rebalance at every checkpoint and state exactly what to stop, parallelize, finish, and verify. The overtime branch tells the agent to finish the current executable slice, stop new optional work, and report reality—not to abandon the requested task or pretend it passed.

- [ ] **Step 4: Import both prompts statically** using `with { type: "text" }`; render dynamic values through the existing `@oh-my-pi/pi-utils` Handlebars prompt helper. Do not build prompt prose in TypeScript.

- [ ] **Step 5: Wire controller lifecycle in `AgentSession`.** Instantiate only for a main session (`taskDepth === 0` or the repository's authoritative equivalent), subscribe to `subscribeRunState`, restore from `sessionManager.getEntries()`, reset/restore after session adoption, and dispose timer/listeners in `dispose()`.

- [ ] **Step 6: Deliver reminders cache-safely.** Append hidden custom messages (`display: false`, agent/system attribution) at the tail. During a running turn use `deliverAs: "steer"`; while idle append for the next turn without triggering an empty provider turn. Never mutate the base system prompt or previous transcript entries.

- [ ] **Step 7: Persist every lifecycle event** through `sessionManager.appendCustomEntry(TIME_BUDGET_CUSTOM_TYPE, data)`. Use wall-clock `at` for ordering/analytics only; restore duration exclusively from persisted `activeMs`.

- [ ] **Step 8: Run the focused test again and confirm prompt delivery, persistence, pause, resume, and overtime cases pass.**

---

### Task 3: `/time-budget` Command and Status Line

**Files:**
- Modify: `packages/coding-agent/src/slash-commands/builtin-modes.ts`
- Modify: `packages/coding-agent/src/modes/components/status-line/segments.ts`
- Modify: focused slash/status tests under `packages/coding-agent/test/`

**Interfaces:**

```text
/time-budget 30m      -> activate; "Time budget active: 0m elapsed, 30m remaining."
/time-budget 1h30m    -> activate compound duration
/time-budget +15m     -> extend current budget
/time-budget          -> print current status
/time-budget off      -> deactivate and print final elapsed/overtime
```

- [ ] **Step 1: Add command-contract tests.** Prove the shared handler works through the generic `SlashCommandRuntime` (therefore TUI/ACP/RPC), invalid/below-min input returns usage without mutation, `+duration` fails when inactive, and no-arg status is read-only.

- [ ] **Step 2: Register the command beside other mode commands.** Use `allowArgs: true`, static inline hint `[duration | +duration | off]`, autocomplete status from `getTimeBudgetSnapshot()`, and a shared `handle` that calls `session.handleTimeBudgetCommand()` then writes the returned text through `runtime.output`.

- [ ] **Step 3: Extend the existing `mode` status segment.** Preserve plan/goal/orchestrator/vibe/loop precedence, then append an independently colored budget suffix when active:

```text
⏱ 12m/30m · 18m left
⏱ 37m/30m · +7m over
```

Use the existing duration and theme helpers. Normal state uses accent/custom-message color, under 20% remaining uses warning, overtime uses error. Do not add a second ticker; the existing status-line active meter/render cadence drives display updates.

- [ ] **Step 4: Add rendering tests** for active, warning, overtime, and coexistence with another mode. Assert semantic content, not raw ANSI bytes.

- [ ] **Step 5: Run focused slash/status tests and `bun --cwd packages/coding-agent run check`.** Expected: exit 0.

---

### Task 4: Stats Extraction and Idempotent Persistence

**Files:**
- Modify: `packages/stats/src/types.ts`
- Modify: `packages/stats/src/parser.ts`
- Modify: `packages/stats/src/db.ts`
- Modify: `packages/stats/src/aggregator.ts`
- Create: `packages/stats/test/time-budget-stats.test.ts`

**Interfaces:**

```ts
export interface TimeBudgetEntryStats extends TimeBudgetEntryData {
	sessionFile: string;
	entryId: string;
}

export interface TimeBudgetRunRecord {
	sessionFile: string;
	activationEntryId: string;
	activatedAt: number;
	budgetMs: number;
	activeMs: number;
	overtimeMs: number;
	completed: boolean;
	extensionCount: number;
}
```

- [ ] **Step 1: Create a session fixture with:** a valid activate/checkpoint/extend/overtime/deactivate run, a malformed `time_budget` entry, an unrelated custom entry, and a second valid open run.

- [ ] **Step 2: Add parser tests.** Validate type/event values, finite nonnegative `budgetMs`/`activeMs`/`at`, and emit only valid entries in JSONL order. Malformed data must not fail `parseSessionFile`.

- [ ] **Step 3: Extend `ParseSessionResult` with `timeBudgetEntries`.** Extract from `customType === "time_budget"` next to the existing custom-entry handlers; preserve incremental `fromOffset` behavior.

- [ ] **Step 4: Add SQLite schema/migration.** Store one row per activation span with a stable primary key `(session_file, activation_entry_id)` (or the exact equivalent supported by the existing schema helper), plus indexed activation time for dashboard queries.

- [ ] **Step 5: Fold ordered events into runs in the aggregator.** On activation, start a run. Checkpoint/extend/overtime update the open run. Deactivate updates and closes it. A later activation implicitly finalizes a malformed unclosed predecessor at its last state. Calculate `overtimeMs = Math.max(0, activeMs - budgetMs)` from final values, not from event names alone.

- [ ] **Step 6: Match existing incremental-sync idempotency.** Re-syncing unchanged content must not duplicate rows. Appending events must update the existing open row. A full session replacement/truncation must delete/rebuild that session's rows using the same reset path as other per-session metrics.

- [ ] **Step 7: Run `bun test packages/stats/test/time-budget-stats.test.ts`.** Confirm two run rows, correct final budget/active/overtime/completion/extension count, malformed entry ignored, and unchanged re-sync leaves row count unchanged.

---

### Task 5: `ompx stats` Dashboard

**Files:**
- Modify: `packages/stats/src/shared-types.ts`
- Modify: `packages/stats/src/aggregator.ts`
- Modify: `packages/stats/src/server.ts`
- Modify: the specific existing dashboard client component selected after reading `packages/stats/src/client/`
- Regenerate: `packages/stats/src/embedded-client.generated.txt`

**Interfaces:**

```ts
export interface TimeBudgetDashboardStats {
	totalRuns: number;
	withinBudgetRuns: number;
	overtimeRuns: number;
	openRuns: number;
	averageOvertimeMs: number;
}
```

A deactivated run with `overtimeMs === 0` is within budget. A deactivated run with `overtimeMs > 0` is overtime. Open runs are reported separately and excluded from within-budget/overtime completion counts and average overtime.

- [ ] **Step 1: Add aggregate-query tests** for zero rows, one within-budget completion, one overtime completion, and one open run. Average overtime uses only completed overtime runs; zero overtime runs yields `0`.

- [ ] **Step 2: Add `timeBudgets` to the existing dashboard response contract** and populate it in the same server aggregation pass as neighboring summary metrics.

- [ ] **Step 3: Render one compact Time Budget section** showing total runs, within budget, overtime, open, and average overtime. Use existing card/number/duration components and responsive layout; do not introduce a new visual system or dependency.

- [ ] **Step 4: Regenerate the embedded client** with `bun --cwd packages/stats run gen:stats`. Verify generated output changes only as a result of source-client changes.

- [ ] **Step 5: Run `bun test packages/stats/test/time-budget-stats.test.ts` and `bun --cwd packages/stats run check`.** Expected: exit 0.

---

### Task 6: End-to-End Verification and Cleanup

**Files:**
- Modify after runtime success: `packages/coding-agent/CHANGELOG.md`
- Modify after runtime success: `packages/stats/CHANGELOG.md`

- [ ] **Step 1: Run all focused tests created/modified.** Expected: all pass.

```bash
bun test packages/coding-agent/test/time-budget.test.ts packages/stats/test/time-budget-stats.test.ts
```

- [ ] **Step 2: Run package checks.** Expected: both exit 0.

```bash
bun --cwd packages/coding-agent run check
bun --cwd packages/stats run check
```

- [ ] **Step 3: Build the actual worktree CLI.** Run `bun --cwd packages/coding-agent run build`; use only `packages/coding-agent/dist/ompx` for subsequent runtime evidence.

- [ ] **Step 4: Exercise command behavior through the built CLI/TUI harness.** In a PTY session: activate `10m`, inspect status, run a short agent turn, inspect status again, extend `+5m`, deactivate, and confirm elapsed time did not advance while idle. Use a test-only injectable clock or focused controller harness to cross five-minute and overtime boundaries deterministically; do not wait in real time or weaken production intervals.

- [ ] **Step 5: Exercise stats ingestion through the actual CLI.** Point the stats sync at the runtime session (or the deterministic fixture through the package's existing sync harness), run `packages/coding-agent/dist/ompx stats`, and verify the Time Budget totals and overtime values match persisted entries. If browser automation is available, open the local dashboard route and confirm the section renders without console errors.

- [ ] **Step 6: Add concise Unreleased changelog entries.** Coding-agent: users can activate a pausable active-work budget with five-minute pacing and status display. Stats: dashboard reports time-budget outcomes and overtime.

- [ ] **Step 7: Read `skill://verify-before-done`, reconcile the done scorecard, and report only observed evidence.** Any unexercised runtime path is `NOT VERIFIED` with its exact prerequisite; never infer it from typecheck/tests.
