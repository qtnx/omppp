# Idle Low-Memory Mode — Implementation Plan

> **For agentic workers:** Each task is a self-contained package executed by one owner (production code + tests in the same package). Steps use checkbox (`- [ ]`) syntax.

**Goal:** When an interactive `ompx` TUI session sits idle (no turn, no streaming, no active subagent/tool work) past a configurable threshold (default 10 min), automatically enter a low-memory mode: park all live subagents, put MCP servers to sleep, terminate lazily-restartable background workers/kernels, drop process caches, and force GC — cutting the multi-GB idle RSS observed on long-lived sessions (7.8G RSS / 11.5G peak on a 2.5-day idle session) without losing the session.

**Architecture:** A new `IdleMemoryTrim` coordinator mirrors the proven idle-compaction lifecycle: armed on `agent_end` (activity end), cancelled on `agent_start`/dispose/compaction, guarded at fire time. The trim itself only calls subsystem APIs that are lazy-restartable — everything it stops is rebuilt automatically on next use, so waking is instant from the user's perspective. Session message state is explicitly NOT touched (that is the landed session-memory-retention work's domain).

**Tech stack:** Bun + TypeScript. No new dependencies. Mirrors `event-controller.ts` idle-compaction wiring and `settings-schema.ts` group conventions.

## Global Constraints

- LOCKED trim scope (category toggles in parentheses; default all ON unless noted):
  1. Subagents — force-park every live adopted subagent via new `AgentLifecycleManager.parkAll()`.
  2. MCP (`memory.idleTrimMcp`) — new `MCPManager.sleepAll()`: detach `onClose`, close transports, KEEP `#serverConfigs` and the registered `#tools`. Wake is lazy through the existing per-tool-call reconnect path (`MCPTool.execute` retriable-error → `reconnectServer` → one retry; `tool-bridge.ts:349-401`). `disconnectAll()` is FORBIDDEN here — it clears `#serverConfigs` (teardown semantics, `manager.ts:780-809`).
  3. Workers/kernels — terminate lazily-respawning singletons: tiny title client (`tiny/title-client.ts` `terminate()`), STT (`stt/asr-client.ts`), TTS (`tts/tts-client.ts`), embed (`mnemopi/embed-client.ts`); dispose eval kernels: `disposeAllVmContexts()` (`eval/js/context-manager.ts:150-160`), `disposeAllKernelSessions()` (`eval/py/executor.ts:306-320`), `disposeAllJuliaKernelSessions()` (`eval/jl/executor.ts:331-355`).
  4. Caches — `clearCache()` from `capability/fs.ts:97-112`; `closeAllAutoresearchStorages()` (`autoresearch/storage.ts:552-601`).
  5. GC + measure — read `process.memoryUsage().rss` BEFORE the trim steps; AFTER all steps complete run `Bun.gc(true)`, then read rss again and emit ONE log line (`logger.info("idle memory trim", { rssBefore, rssAfter, parked, mcpSlept, workers, cachesCleared })`). LOCKED ORDER: steps → `Bun.gc(true)` → read rssAfter → log. RSS values are observability only — no gate may assert their direction (JSC does not reliably return pages to the OS; freed child processes reduce their own RSS, not the parent's).
- EXCLUDED (hard non-goals, state loss or self-managing): browser tabs (`tab-supervisor` — open pages are user state), persistent shells with background jobs (`exec/bash-executor.ts:70-111`), main-session messages/`agent.state.messages`, LSP (`lsp/client.ts:55` self-idle-shutdown), DAP (`dap/session.ts:1037` self-cleanup), daemon broker (`launch/broker.ts:972-988` self-shutdown), stats sync worker (no owned handle in-process; investigate-only, report verdict).
- INVARIANT: trim is cancellable mid-flight — `trimNow` rechecks `isActive()` AND a generation counter (incremented by `notifyActivityStart`/`dispose`) BETWEEN EVERY STEP; on change it stops immediately (steps already done stay done — they are all lazily reversible — but no further step runs). A turn that starts while trim is parking agent A must never see agent B parked or an MCP transport closed out from under it.
- INVARIANT: every trim step is best-effort and isolated — a throwing step is caught, logged, and never aborts the remaining steps or the session. Trim never STARTS while a turn/stream/compaction is active or any subagent ref is `running`.
- INVARIANT: wake requires ZERO explicit resume calls from callers — all trimmed subsystems restart lazily on their normal use paths. No new resume APIs on consumers. Evidence for each wake path: subagents — the EXISTING TTL-park path (`task.agentIdleTtlMs`, default 420s) already parks idle subagents in production today and they revive on message: `ensureLive` (`registry/agent-lifecycle.ts:154+`), IRC send to parked ref (`irc/bus.ts:132-136`), agent-hub focus/chat (`modes/components/agent-hub.ts:552`), follow-up turns (`task/executor.ts:2081-2091`); `parkAll()` only accelerates the identical transition. MCP — per-tool-call reconnect (`tool-bridge.ts:349-401`). Workers/kernels — lazy `#ensureWorker`/session-keyed respawn (`tiny/title-client.ts:~314-365`, `eval/js/context-manager.ts:246-305`, `eval/py/executor.ts:238-271,464-482`, `eval/jl/executor.ts:458-500`). Caches — `storageCache` get-or-create (`autoresearch/storage.ts:552-601`), fs cache refills on miss (`capability/fs.ts:97-112`).
- Settings LOCKED (new `memory` group, additive — no migration; `settings.get` resolves defaults, `settings.ts:543-560`):
  - `memory.idleTrimEnabled`: boolean, default `true`.
  - `memory.idleTrimSeconds`: number, default `600`, clamp 60..3600 at use site (mirrors idle-compaction clamp).
  - `memory.idleTrimMcp`: boolean, default `true` (opt-out for users with slow/flaky MCP reconnects).
- Status surface: while trimmed, show `setHookStatus("memory", …)` badge (`status-line/component.ts:545-551`); cleared on next activity.
- Repo rules: `bun check` (never tsc), no `console.*`, ES `#private`, no `mock.module()`, no inline imports, prompts never in code (N/A here), tests full-suite safe, no project-wide suites inside packages.
- Do NOT commit; the parent integrates.

## Contracts (locked prefix — all waves code against these)

```ts
// packages/coding-agent/src/registry/agent-lifecycle.ts — P1 adds:
/** Park every adopted agent that is currently live (status "idle"); skips parked/parking/running. */
parkAll(): Promise<void>;

// packages/coding-agent/src/mcp/manager.ts — P2 adds:
/**
 * Close all live transports WITHOUT clearing configs or registered tools:
 * servers sleep; the next tool call revives its server via the existing
 * reconnect-on-use path. No-op when already sleeping.
 */
sleepAll(): Promise<void>;
/** True while at least one server remains asleep from sleepAll (per-server entries clear as they reconnect; disconnectAll clears the set). */
get sleeping(): boolean;

// packages/coding-agent/src/memory/idle-trim.ts — P3 creates:
export interface IdleTrimDeps {
	readonly config: {                                  // P4 wires closures over Settings (fresh read per call)
		enabled(): boolean;                             // memory.idleTrimEnabled
		idleSeconds(): number;                          // memory.idleTrimSeconds, clamped 60..3600 by coordinator
		trimMcp(): boolean;                             // memory.idleTrimMcp
	};
	readonly lifecycle: { parkAll(): Promise<void> };    // structural — P3 never imports P1
	readonly mcp: { sleepAll(): Promise<void> } | null;  // structural — null in sessions without owned MCP
	readonly workers: { terminateAll(): Promise<void> }; // tiny/stt/tts/embed + eval kernels bundle (P3-internal)
	readonly caches: { clear(): void };                  // capability/fs + autoresearch bundle (P3-internal)
	readonly statusLine: { setHookStatus(key: string, text: string | undefined): void } | null;
	readonly isActive: () => boolean;                    // streaming || compacting || any subagent running || editor dirty
	readonly now?: () => number;                         // test seam
}
export class IdleMemoryTrim {
	constructor(deps: IdleTrimDeps);
	notifyActivityEnd(): void;   // (re)arms the timer per settings
	notifyActivityStart(): void; // cancels timer + clears badge
	trimNow(): Promise<void>;    // fire path, also directly callable (/memory trim command later)
	dispose(): void;
}

// packages/coding-agent/src/config/settings-schema.ts — P4 adds GroupTypeMap entry:
// memory: { idleTrimEnabled: boolean; idleTrimSeconds: number; idleTrimMcp: boolean }
```

---

### Task P1: `AgentLifecycleManager.parkAll()` (owner: task)

**Files:**
- Modify: `packages/coding-agent/src/registry/agent-lifecycle.ts` (class ~:41-200; `park(id)` at :126-147)
- Test: `packages/coding-agent/test/registry/agent-lifecycle.test.ts` (colocate with existing lifecycle tests; create if absent)

**Interfaces:**
- Produces: `parkAll(): Promise<void>` (LOCKED above). Consumes: existing `park(id)`, registry statuses.

**Design constraints:**
- Iterate adopted ids; skip refs already `parked`, `running`, or in `#parking`; skip `aborted`.
- Sequential `await park(id)` per agent (park disposes sessions; parallel disposal risks writer-lock contention on distinct session files is fine but keep it boring and ordered); a failing park is logged and does not stop the rest.
- Timer for each parked agent must be cleared exactly as `park` already does — reuse `park`, no duplicated teardown logic.

**Steps:**
- [ ] RED: test — adopt 3 agents (two live idle, one already parked, one running): `parkAll()` parks exactly the live idle ones; running/parked untouched; a session whose `dispose()` throws is logged and skipped while others still park. Run → fails.
- [ ] RED: wake — adopt a live agent with a real reviver closure, `parkAll()`, then `ensureLive(id)` → session live again (the same path IRC/hub use: `irc/bus.ts:132-136`). Run → fails.
- [ ] GREEN: implement `parkAll` via existing `park`. Run → pass.
- [ ] Run: `bun test packages/coding-agent/test/registry/agent-lifecycle.test.ts` → green; `bun check` clean.

**Acceptance:** new tests green incl. park→ensureLive wake; existing lifecycle tests not newly failing.

**Done report:** files, test output, deviations. STOP AND ESCALATE if `ensureLive` cannot revive a `parkAll`-parked agent in the test — the feature's wake invariant is broken; do not patch around it.

---

### Task P2: `MCPManager.sleepAll()` (owner: task)

**Files:**
- Modify: `packages/coding-agent/src/mcp/manager.ts` (near `disconnectAll` :780-809)
- Test: `packages/coding-agent/test/mcp/manager-sleep.test.ts` (new; mirror the fake-stdio-server harness of existing manager tests under `packages/coding-agent/test/mcp/`)

**Interfaces:**
- Produces: `sleepAll(): Promise<void>`, `get sleeping(): boolean` (LOCKED above).
- Consumes: `disconnectServer(connection)` (`mcp/client.ts:264`), existing reconnect machinery (`reconnectServer` :817, `#doReconnect` :934-1019).

**Design constraints:**
- For each live connection: set `transport.onClose = undefined` (prevent auto-reconnect storm), close it, delete from `#connections`. MUST NOT touch: `#serverConfigs`, `#tools`, `#sources`, `#subscribedResources`, `#reconnectHistory`, `#epoch` (epoch bump would invalidate future reconnects — do NOT bump).
- `#pendingConnections` in flight at sleep time: await `Promise.allSettled` on them first, then close whatever landed. Do not clear `#pendingReconnections` blindly — a reconnect in flight at sleep time is awaited then closed.
- `sleeping` semantics (LOCKED): maintain `#asleepNames = new Set<string>()` — added per server in `sleepAll`, removed per server on successful reconnect inside `#connectAndWireServer` (:948-1010), cleared in `disconnectAll`. `get sleeping()` → `#asleepNames.size > 0`.
- Idempotent: second `sleepAll()` with no live connections is a no-op.
- Wake correctness is the acceptance core: after `sleepAll()`, a call to a tool of a slept server MUST go through the existing `MCPTool.execute` retriable path and end with a successful result (harness: real fake stdio server, real tool call — assert the server process was spawned twice total).
- FALLBACK if escalation fires (deliberate close NOT classified retriable): add a `#asleepNames` check at `MCPTool.execute` entry (`tool-bridge.ts:349-401`) that proactively `reconnectServer(name)` before the call. This fallback is the pre-approved design — implement it only on evidence, not speculatively.
- OAuth/HTTP servers: assert `#resolveAuthConfig` re-resolves on reconnect (existing behavior :1220-1306); no interactive OAuth triggered by wake.

**Steps:**
- [ ] RED: test — connect fake stdio server, `sleepAll()`: transport closed, `getConnectionStatus(name) === "disconnected"`, `sleeping === true`, `#tools` still contains the server's tools (call `getTools()`), config preserved (`getServerConfig(name)` defined).
- [ ] RED: test — after sleep, execute one of the server's tools → result succeeds; spawn count 2 (initial + wake). Also assert no crash-storm entries were recorded for the deliberate close.
- [ ] RED: test — `sleepAll()` during a pending connection: settles, closes it, no unhandled rejection; second `sleepAll()` no-op.
- [ ] GREEN: implement `sleepAll` + `sleeping`. Run → pass.
- [ ] Run: `bun test packages/coding-agent/test/mcp/manager-sleep.test.ts` → green; `bun check` clean.

**Acceptance:** new tests green incl. wake-through-tool-call; existing `test/mcp/` suites not newly failing.

**Done report:** files, test output, spawn-count evidence, deviations. STOP AND ESCALATE if the per-tool-call retriable path does NOT reconnect a deliberately-closed transport (error classification) — report the classification gap instead of patching tool-bridge silently.

---

### Task P3: `IdleMemoryTrim` coordinator + worker/cache bundles (owner: heavy_task, self_review)

**Files:**
- Create: `packages/coding-agent/src/memory/idle-trim.ts` (coordinator per locked contract)
- Create: `packages/coding-agent/src/memory/trim-targets.ts` (`buildWorkerTrimTargets(): { terminateAll() }` wrapping tiny/stt/tts/embed terminate + eval kernel disposes; `buildCacheTrimTargets(): { clear() }` wrapping `clearCache` + `closeAllAutoresearchStorages`)
- Test: `packages/coding-agent/test/memory/idle-trim.test.ts` (new)

**Interfaces:**
- Consumes: `parkAll` (P1), `sleepAll`/`sleeping` (P2) — LOCKED signatures above; worker/cache terminate APIs (existing, cited in Global Constraints).
- Produces: `IdleMemoryTrim`, `IdleTrimDeps` (LOCKED above) for P4 wiring.

**Design constraints:**
- Timer lifecycle mirrors `#scheduleIdleCompaction` (`event-controller.ts:1589-1640`): cancel-on-rearm, `unref?.()`, clamp 60..3600s, guard recheck at fire time.
- Fire guards (ALL must hold, rechecked inside `trimNow` before acting): `enabled` setting, `!isActive()`, timer still the armed one.
- `trimNow` order: subagents → MCP → workers → caches → `Bun.gc(true)` → read rssAfter → ONE log line (`logger.info("idle memory trim", { rssBefore, rssAfter, parked, mcpSlept, workers, cachesCleared })`; rssBefore read at trim start). Each step `try/catch` + `logger.warn` on failure. BETWEEN STEPS: recheck `isActive()` and the generation counter; abort remaining steps on change.
- Badge: on any completed trim step, `statusLine.setHookStatus("memory", "low-mem")`; `notifyActivityStart` clears it via `setHookStatus("memory", undefined)`.
- Settings read fresh at arm AND fire time (user may toggle mid-idle). `memory.idleTrimMcp=false` skips only the MCP step.
- Stats sync worker: investigate-only — grep its spawn/ownership (`omp-stats/sync-worker`); if an in-process handle exists add it to worker targets, else report verdict "no handle, excluded".
- Tests use fake timers + fake deps (no real processes); one integration-ish test may call real `trimNow` with all-null deps.

**Steps:**
- [ ] RED: arm/fire — `notifyActivityEnd()` arms for configured seconds; firing calls every dep in order and sets badge; `notifyActivityStart()` before fire cancels everything (no dep called, badge cleared).
- [ ] RED: guards — fire is suppressed when `isActive()` true, when `idleTrimEnabled` false, when seconds changed between arm and fire (re-armed value wins); `idleTrimMcp=false` skips only `mcp.sleepAll()`.
- [ ] RED: isolation — `parkAll` rejects; workers/caches/mcp still called; error logged; badge still set (partial trim is still trimmed).
- [ ] RED: mid-trim cancellation — `notifyActivityStart()` arrives while a slow fake `parkAll` is awaited: MCP/workers/caches steps NEVER run; generation recheck stops the sequence.
- [ ] RED: idempotent re-arm — activityEnd while armed re-arms fresh window; dispose kills timer + clears badge.
- [ ] GREEN: implement. Run → pass.
- [ ] Run: `bun test packages/coding-agent/test/memory/idle-trim.test.ts` → green; `bun check` clean.

**Acceptance:** tests green; RSS log line shape asserted (`rssBefore`/`rssAfter` numeric keys present in a captured log call).

**Done report:** files, test output, stats-worker verdict, autoresearch lazy-reopen verification (one line: the `getOrCreate`-style path that reopens a closed storage, file:line), deviations.

---

### Task P4: Wiring — settings schema, event-controller hook, status badge, construction (owner: task; WAVE 2 — requires P2's `sleepAll` and P3's `idle-trim.ts` on disk for typecheck)

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts` (new `memory` group: schema entries + `TAB_GROUPS` + typed `MemorySettings` + `GroupTypeMap`, mirroring `compaction.*` at :2447-2498, :6020-6028, :6205-6207)
- Modify: `packages/coding-agent/src/modes/controllers/event-controller.ts` (construct/drive `IdleMemoryTrim` beside idle compaction: `notifyActivityStart` from `#handleAgentStart` :460-490, `notifyActivityEnd` from `#finishAgentEnd` :1193-1262, `dispose` from controller dispose :209-214)
- Modify: `packages/coding-agent/src/main.ts` (build trim deps bundle for the interactive session; pass `MCPManager` handle or null when MCP disabled)
- Test: `packages/coding-agent/test/memory/idle-trim-wiring.test.ts` (new — controller-level: agent_end arms, agent_start cancels; fake coordinator spy)

**Interfaces:**
- Consumes: `IdleMemoryTrim`, `IdleTrimDeps` (P3, LOCKED — note `config` closures, NOT a Settings field); `sleepAll` handle via the session's owned `MCPManager` (ownership contract: `agent-session.ts:1163-1167` — top-level TUI session owns the manager). Wires `config: { enabled: () => settings.get("memory.idleTrimEnabled"), idleSeconds: () => settings.get("memory.idleTrimSeconds"), trimMcp: () => settings.get("memory.idleTrimMcp") }`.
- Produces: user-visible surface — settings group "Memory" in Settings UI; status badge while trimmed.

**Design constraints:**
- ACP/SDK/print modes: NOT wired (TUI interactive only) — construct coordinator only in the interactive bootstrap path; document in code comment why.
- Status badge text: `"low-mem"` (dim). No spinner component — badge only.
- Do not change idle-compaction behavior; the two timers coexist independently.
- KNOWN LIMITATION (intended, v1): the timer arms only on the main session's `agent_end`. If a detached subagent outlives the main turn, the fire-time `isActive()` guard suppresses that trim and nothing re-arms until the next main activity end. State this in a code comment; do not add registry-event re-arming in v1.
- Editor-draft guard: `isActive` includes "editor has unsubmitted text" ONLY if the controller already exposes it cheaply (idle compaction reads empty-editor state :1589-1640 — reuse the same accessor); do not invent new editor plumbing.

**Steps:**
- [ ] RED: schema test (colocate with existing settings-schema tests) — `settings.get("memory.idleTrimEnabled")` defaults `true`, `memory.idleTrimSeconds` `600`, group typed map resolves via `getGroup("memory")`. Run → fails.
- [ ] RED: wiring test — with a spy coordinator injected, `agent_end` triggers `notifyActivityEnd`, `agent_start` triggers `notifyActivityStart`, controller dispose calls `dispose`. Run → fails.
- [ ] GREEN: schema + wiring + main.ts construction. Run → pass.
- [ ] Run: `bun test packages/coding-agent/test/memory/` + settings-schema tests → green; `bun check` clean.

**Acceptance:** new tests green; event-controller existing tests not newly failing.

**Done report:** files, test output, editor-guard decision (reused accessor or omitted + why), deviations.

---

## Integration & gates (parent)

1. `bun check` workspace clean.
2. Targeted suites: `bun test packages/coding-agent/test/memory/ packages/coding-agent/test/mcp/manager-sleep.test.ts packages/coding-agent/test/registry/` — all green.
3. **Entry-point probe (rung 3):** build `packages/coding-agent/dist/ompx` (`bun --cwd=packages/coding-agent run build`; rebuild natives first only if sentinel complains), launch under a pty (`script -qec` or node-pty harness) with `--session-dir` tmp + settings override `memory.idleTrimSeconds=60`, spawn one keep-alive subagent + one fake MCP server beforehand, then idle ~75s. PRIMARY assertions (log file `~/.omp/logs/omp.*.log`): the `idle memory trim` line exists with numeric `rssBefore`/`rssAfter` fields, `parked >= 1`, `mcpSlept` true; worker/kernel evidence (spawn counts / PIDs gone where observable). SECONDARY: status badge in the pty transcript — verify the harness renders the status line first; if it does not, the badge stands on P4's unit test alone (declare, don't fake). RSS DIRECTION IS NOT A GATE. Then send a prompt and assert the session answers (wake path works end-to-end).
4. Failure path on same rung: `memory.idleTrimEnabled=false` → after 75s NO trim log line.
5. Changelog: `packages/coding-agent/CHANGELOG.md` under `[Unreleased] > Added`.
6. All tests must pass locally before push; PR per repo convention (title `feat: idle low-memory mode`, body WHAT/WHY/VERIFIED/RISKS/OUT OF SCOPE).

## Out of scope (follow-ups, NOT this change)
- Suspend-to-exit (checkpoint + process termination + `--resume`).
- RSS-threshold gating (`only trim above X MB`) — RSS currently only logged.
- ACP/SDK/headless idle trim.
- Browser-tab release, persistent-shell cleanup, `/memory trim` manual command.
