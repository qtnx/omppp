# Duo Auto Model Switch (Fable ⇄ Opus) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatic main-model switching between an Anthropic planner model (Fable) and executor model (Opus) with the planner demoted to a monitoring advisor during execution, hard done-claim gating, and advisor-driven takeover/handback.

**Architecture:** A pure state machine (`src/duo/state.ts`) drives a `DuoController` owned by `AgentSession` (mirroring the existing `AdvisorRuntime` ownership pattern). Phase transitions reuse existing machinery: `setModelTemporary`/`setThinkingLevel` for switches (plan mode's `#applyPlanModeModel` is the prior art), the advisor runtime for monitoring (extended with pause/resume), the advisor done-gate for completion hardening (extended with an `escalate_verify` verdict), and session JSONL custom entries for persistence.

**Tech Stack:** TypeScript (Bun), arktype tool schemas, bun:test, Handlebars `.md` prompts.

## Global Constraints

- Package: `packages/coding-agent` only. All paths below are relative to `packages/coding-agent/`.
- Prompts live in static `.md` files imported `with { type: "text" }`, rendered via `prompt.render` (Handlebars). Never string-built prompts.
- Catalog helpers imported from `@oh-my-pi/pi-catalog/<module>` — never `packages/catalog/src/...` deep paths.
- ES `#private` fields; no `private`/`protected`/`public` keywords except constructor parameter properties. No `any`. No `ReturnType<>`. No inline `import()`.
- No `console.*`; use `logger` from `@oh-my-pi/pi-utils`.
- `Promise.withResolvers()` over `new Promise((res, rej) => …)`.
- Tests: `bun test`, contract-level, full-suite-safe, no `mock.module()`, no source-grep assertions, one test per invariant/transition.
- Typecheck with `bun check` (never tsc). Changelog entries go under `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md`.
- Implementation subagents do NOT run project-wide gates; the orchestrator runs `bun check` + targeted tests per wave.

## Verified Integration Points (evidence from this repo, read 2026-07-02)

1. **Model switching**: `AgentSession.setModel(model, role, {selector?, thinkingLevel?, persist?})` (`src/session/agent-session.ts:8500`) and `setModelTemporary(model, thinkingLevel?, {ephemeral?})` (`:8536`). Both call `#setModelWithProviderSessionReset` (`:10960`) which only closes provider transport sessions + re-syncs append-only context — it does **not** touch advisor state, so duo switches keep the advisor session intact.
2. **Thinking**: `setThinkingLevel(level: ConfiguredThinkingLevel, persist = false)` (`:8767`) supports the `AUTO_THINKING` sentinel; `#reapplyThinkingLevel` (`:8810`) runs after every model change and preserves auto.
3. **Phase-driven switching prior art**: plan mode switches the main model via `#applyPlanModeModel()` (`src/modes/interactive-mode.ts:2314`): resolves role model, stores `#planModePreviousModelState = {model, thinkingLevel}`, defers with `#pendingModelSwitch` when `session.isStreaming`, flushed by `flushPendingModelSwitch()` (`:2344`). Duo mirrors this deferral pattern inside its controller (turn-boundary rule).
4. **Advisor lifecycle**: enabled flag + build in `#buildAdvisorRuntime` (`src/session/agent-session.ts:2149`); advisor agent tools array is `[adviseTool, doneVerdictTool, ...advisorReadOnlyTools]` (`:2327`) — `request_takeover` is appended there when duo is active. Model selection via `resolveAdvisorRoleSelection(settings, available, registry)` (`src/config/model-resolver.ts:1282`) — duo pins the advisor model by bypassing this with the planner model. Reset triggers are ONLY `/new`, branch, session switch, resume, compaction (`#resetAdvisorSessionState` `:2125`) — not model switches.
5. **Done-gate**: `#checkAdvisorDoneGate(finalMessage)` (`:2493`) gates final stops behind `settings.get("advisor.doneGate")`, consults the advisor with `doneReviewMd`, receives verdicts through `DoneVerdictTool` (`src/advisor/done-verdict-tool.ts`, verdict union `'approve' | 'reject'`, callback `onVerdict: (verdict: DoneVerdict) => boolean`), max 2 rejections per prompt, rejection injects a `<system-reminder>` developer message + `#scheduleAgentContinue`.
6. **Orchestrator mode**: `session.setOrchestratorModeState({enabled: true} | undefined)` (called by `OrchestratorModeTool`, `src/tools/orchestrator-mode.ts:55,66`); enter is blocked while plan/goal mode is active. Duo re-evaluates activation inside the session-side setter.
7. **Advice injection**: advisor notes ride the yield queue as `customType: "advisor"` messages (`:2404-2418`); direct injection uses `sendCustomMessage` (`:7979`) with `deliverAs: "steer" | "nextTurn"`.
8. **Status line**: `modelSegment` (`src/modes/components/status-line/segments.ts:145-196`) already appends a `++` badge when `ctx.session.isAdvisorActive()`; duo extends this segment via a `getDuoStatus()` session API.
9. **Settings pattern**: advisor block `src/config/settings-schema.ts:391-481` (boolean/enum/number entries with `ui: {tab: "model", group, label, description, condition}`).
10. **Persistence**: session JSONL entries replay on resume; model/thinking changes persist via `sessionManager.appendModelChange` (`:8514`) / `appendThinkingLevelChange` (`:8797`); custom messages via `appendCustomMessageEntry`. Duo snapshots persist as a non-display custom message `customType: "duo_state"` and are re-read on resume by scanning session entries (Task 9 verifies the exact replay hook alongside `#reconcileModeFromSession`, `src/modes/interactive-mode.ts:2416`).
11. **Identity**: `parseAnthropicModel` / `isFableOrMythos` from `@oh-my-pi/pi-catalog` classify `claude-(opus|sonnet|fable|mythos)-…` ids; `kind === "opus"` and `isFableOrMythos(id)` are the detection predicates.

**NEW behavior introduced by this plan** (not existing wiring): `AdvisorRuntime.pause()/resume()`, `escalate_verify` verdict, `request_takeover` + `duo_handoff` tools, duo advisor model pinning, `duo_state` persistence, all of `src/duo/`.

## Locked Shared Contracts

Every task below consumes these exact names. Deviating requires updating every consumer in the same change.

```ts
// src/duo/state.ts
export type DuoPhase = "inactive" | "planning" | "executing" | "takeover" | "suspended" | "degraded";
export type DuoMode = "auto" | "on" | "off";
export type TakeoverPurpose = "recover" | "verify";
export type DuoSuspendReason = "manual-model" | "set-model-failed" | "unresolvable";

export interface DuoStateSnapshot {
	phase: DuoPhase;
	plannerId?: string;            // "provider/id"
	executorId?: string;
	takeoverPurpose?: TakeoverPurpose;
	takeoverCount: number;         // total takeovers this session
	consecutiveTakeovers: number;  // takeovers without an intervening full cooldown window on the executor
	cooldownRemaining: number;     // executor turns until next recover takeover allowed
	suspendReason?: DuoSuspendReason;
	preDuoThinking?: string;       // ConfiguredThinkingLevel to restore on deactivation
}

export interface DuoActivationInput {
	mode: DuoMode;
	orchestratorEnabled: boolean;
	mainModelKind: "opus" | "fable" | "other";
	plannerResolvable: boolean;
	executorResolvable: boolean;
	planApproved: boolean;
}

export type TakeoverDecision = "accepted" | "cooldown-advice" | "rejected";

export class DuoStateMachine {
	constructor(config: { cooldownTurns: number; maxConsecutive: number }, restored?: DuoStateSnapshot);
	get snapshot(): DuoStateSnapshot;         // deep-copied
	get phase(): DuoPhase;
	evaluateActivation(input: DuoActivationInput): DuoPhase; // inactive→planning/executing, active→inactive when condition lost
	onPlanApproved(): boolean;                 // planning→executing; true when transitioned
	onHandoffToExecutor(): boolean;            // planning|takeover→executing; starts cooldown; does NOT reset consecutiveTakeovers
	onTakeoverRequested(purpose: TakeoverPurpose): TakeoverDecision; // executing→takeover ("verify" bypasses cooldown; maxConsecutive → rejected)
	onExecutorTurnEnd(): void;                 // decrements cooldownRemaining while executing; resets consecutiveTakeovers to 0 when cooldown reaches 0
	onManualModelChange(): void;               // any active → suspended("manual-model")
	onSetModelFailed(): void;                  // any active → suspended("set-model-failed")
	onAdvisorDropped(): void;                  // executing → degraded
	onResume(input: DuoActivationInput): DuoPhase; // suspended → recomputed phase
	onDuoOff(): void;                          // any → inactive
}
```

```ts
// src/duo/controller.ts
export interface DuoControllerHost {
	currentModel(): Model | undefined;
	availableModels(): Model[];
	isStreaming(): boolean;
	setModelTemporary(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void>;
	setThinkingLevel(level: ConfiguredThinkingLevel): void;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	ensureAdvisorStarted(pinned: Model): boolean;   // start advisor with pinned model; false when impossible
	stopDuoAdvisor(): void;                          // stop only if duo-owned
	pauseAdvisor(): void;
	resumeAdvisor(catchupBrief?: string): void;
	injectBrief(text: string, deliverAs: "steer" | "nextTurn"): void;
	emitNotice(level: "info" | "warning", text: string): void;
	persistSnapshot(snapshot: DuoStateSnapshot): void;
	orchestratorEnabled(): boolean;
	planApproved(): boolean;
}

export interface DuoStatus {
	phase: DuoPhase;
	planner?: string;   // "provider/id"
	executor?: string;
	takeoverPurpose?: TakeoverPurpose;
	takeoverCount: number;
	advisorPaused: boolean;
}

export class DuoController {
	constructor(host: DuoControllerHost, config: DuoResolvedConfig, restored?: DuoStateSnapshot);
	get status(): DuoStatus;
	reevaluate(): Promise<void>;                        // activation matrix; called on orchestrator/model/settings/resume changes
	notifyPlanApproved(): Promise<void>;
	notifyTurnEnd(): Promise<void>;                     // applies queued switches (turn-boundary rule) + cooldown ticks
	notifyManualModelChange(): void;
	notifyAdvisorDropped(): void;
	requestTakeover(purpose: TakeoverPurpose, reason: string, directive: string): TakeoverDecision;
	handoffToExecutor(resolution: string): Promise<boolean>;
	forceExec(): Promise<boolean>;                      // /duo exec
	deactivate(): Promise<void>;                        // /duo off
	dispose(): void;
}
```

```ts
// src/config/model-resolver.ts (addition)
export interface DuoResolvedConfig {
	planner: Model;
	plannerThinking: ConfiguredThinkingLevel;  // default AUTO_THINKING
	executor: Model;
	executorThinking: ConfiguredThinkingLevel; // default ThinkingLevel.Max
	cooldownTurns: number;
	maxConsecutive: number;
	doneGate: "strict" | "inherit";
}
export function resolveDuoConfig(
	settings: Settings,
	available: Model[],
	registry: ModelRegistry,
): DuoResolvedConfig | undefined;  // undefined when planner or executor unresolvable
```

```ts
// src/duo/takeover-tool.ts — advisor-agent tool, name "request_takeover"
// schema: { purpose: "'recover' | 'verify'", reason: "string", directive: "string" }
// constructor(onTakeover: (purpose: TakeoverPurpose, reason: string, directive: string) => TakeoverDecision)

// src/duo/handoff-tool.ts — main-session tool, name "duo_handoff"
// schema: { to: "'executor'", resolution: "string" }
// constructor(getController: () => DuoController | undefined) — ToolError when duo not in planning/takeover
```

```ts
// src/advisor/done-verdict-tool.ts — verdict union extended
export interface DoneVerdict {
	verdict: "approve" | "reject" | "escalate_verify";
	missing?: string[];
	note?: string;
}
```

```ts
// AgentSession public additions (Task 9 produces; Tasks 11–12 consume)
getDuoStatus(): DuoStatus | undefined;       // undefined when duo not constructed
setDuoEnabled(on: boolean): Promise<void>;   // /duo on|off
duoForceExec(): Promise<boolean>;            // /duo exec
```

Settings keys (Task 3): `duo.mode` (enum auto|on|off, default auto), `duo.plannerModel` (string, default ""), `duo.executorModel` (string, default ""), `duo.plannerThinking` (string, default "auto"), `duo.executorThinking` (string, default "max"), `duo.doneGate` (enum strict|inherit, default strict), `duo.takeover.enabled` (boolean, default true), `duo.takeover.cooldownTurns` (number, default 4), `duo.takeover.maxConsecutive` (number, default 2).

## Locked Behavioral Decisions (from design spec — implementers must not re-litigate)

- **Activation matrix**: duo activates when `duo.mode !== "off"` AND (`mode === "on"` OR orchestrator mode enabled OR main model kind is fable/mythos) AND both planner+executor resolvable. Initial phase: `planning` when main is planner-kind and no plan approved; else `executing`.
- **Turn-boundary rule**: model/thinking switches never fire mid-stream; when `host.isStreaming()`, the controller queues the switch and `notifyTurnEnd()` applies it.
- **Takeover semantics**: advisor stays alive but **paused** (queue keeps coalescing deltas, zero inference) during takeover; resume drains one coalesced catch-up. Never reset.
- **Hysteresis**: `recover` takeovers blocked for `cooldownTurns` executor turns after a handback (blocked request → returned as `cooldown-advice`, surfaced as a high-severity advisory instead); `maxConsecutive` consecutive takeovers without successful handback → further requests `rejected` + notice (manual `/duo exec` required).
- **Done-claim hardening**: with `duo.doneGate === "strict"` and phase `executing`, the done gate runs even when `advisor.doneGate` is false. `escalate_verify` verdict → takeover `purpose: "verify"` (cooldown-exempt, counts toward maxConsecutive): planner verifies itself, then `duo_handoff` back.
- **User sovereignty**: manual `/model` while duo active → `suspended` + notice; duo never switches back automatically until `/duo on` re-arms.
- **Deactivation**: keep current main model (no yank), stop duo-owned advisor (leave user-enabled advisor running), restore `preDuoThinking`.
- **Degraded**: advisor runtime drop (existing consecutive-failure path) → solo executor + notice; takeover impossible.
- **Failure**: `setModelTemporary` throw → `suspended("set-model-failed")` + warning notice; never crash the session.

---

### Task 1: Duo state machine (`src/duo/state.ts`)

**Files:**
- Create: `src/duo/state.ts`
- Test: `src/duo/__tests__/state.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; no imports beyond types it defines).
- Produces: everything in the `src/duo/state.ts` contract block above, exported.

- [ ] **Step 1: Write failing tests** covering, one test per invariant: activation matrix rows (off→never; on→always-when-resolvable; auto+orchestrator; auto+fable-main; unresolvable→inactive), planning→executing on plan approval, executing→takeover recover (accepted), recover during cooldown → `"cooldown-advice"`, verify bypasses cooldown, maxConsecutive → `"rejected"`, cooldown decrement on executor turn end, manual model change → suspended, resume recomputes phase, advisor dropped → degraded, off → inactive, snapshot round-trip through constructor `restored` param.
- [ ] **Step 2: Run** `bun test packages/coding-agent/src/duo/__tests__/state.test.ts` — expect failures (module missing).
- [ ] **Step 3: Implement** `DuoStateMachine` exactly per contract; transitions are synchronous pure functions over internal state; `snapshot` returns a structured clone.
- [ ] **Step 4: Run the same test command** — expect PASS.

### Task 2: AdvisorRuntime pause/resume (`src/advisor/runtime.ts`)

**Files:**
- Modify: `src/advisor/runtime.ts` (class `AdvisorRuntime`, fields around `:102-128`, drain gate)
- Test: `src/advisor/__tests__/advisor.test.ts` (append cases)

**Interfaces:**
- Produces: `pause(): void`, `resume(): void`, `get paused(): boolean` on `AdvisorRuntime`.

- [ ] **Step 1: Failing tests**: while paused, `onTurnEnd` queues deltas but no agent prompt fires; `consult()` while paused resolves `null` immediately (done-gate suspension); `resume()` drains the coalesced backlog with a single prompt; `pause()` is idempotent; `dispose()` while paused still resolves pending consults null.
- [ ] **Step 2: Implement**: `#paused` field; `#drain()` returns early while `#paused`; `consult()` short-circuits `null` when paused; `resume()` clears flag + `void this.#drain()`.
- [ ] **Step 3: Run** `bun test packages/coding-agent/src/advisor/__tests__/advisor.test.ts` — PASS.

### Task 3: Settings schema keys (`src/config/settings-schema.ts`)

**Files:**
- Modify: `src/config/settings-schema.ts` (insert a `Duo` group after the advisor block ending `:481`)

Add the nine `duo.*` keys from Locked Shared Contracts with `ui: {tab: "model", group: "Duo", …}`, mirroring the advisor block's shape (enum entries use `values: [...] as const`). `duo.plannerModel`/`duo.executorModel` descriptions state "model pattern; empty auto-detects newest Fable/Opus-family model". No UI `condition` for `duo.mode`; remaining keys use a `duoEnabled`-style condition only if an equivalent mechanism already exists for advisor (`condition: "advisorEnabled"` precedent) — otherwise omit conditions.

### Task 4: DoneVerdict escalate_verify (`src/advisor/done-verdict-tool.ts`)

**Files:**
- Modify: `src/advisor/done-verdict-tool.ts`

Extend the arktype union to `"'approve' | 'reject' | 'escalate_verify'"`, the `DoneVerdict` interface per contract, and the tool `description` to state: escalate_verify = "the completion claim cannot be trusted without independent verification; the planner model will take over the main stream to verify". Existing callers compile unchanged (they switch on `"approve"` and treat everything else as reject until Task 9 adds the explicit branch).

### Task 5: Duo model resolution (`src/config/model-resolver.ts`)

**Files:**
- Modify: `src/config/model-resolver.ts` (add `resolveDuoConfig` near `resolveAdvisorRoleSelection` `:1282`)
- Test: `src/config/__tests__/duo-resolve.test.ts` (create; follow existing model-resolver test file conventions if present, else standalone)

**Interfaces:**
- Consumes: `parseModelPattern` (`:832`), catalog identity helpers via `@oh-my-pi/pi-catalog` (`parseAnthropicModel`, `isFableOrMythos`), `AUTO_THINKING`/`ThinkingLevel` from `../thinking`.
- Produces: `resolveDuoConfig` + `DuoResolvedConfig` per contract.

Resolution order per side: explicit `duo.plannerModel`/`duo.executorModel` pattern (honoring `:thinking` suffix via existing pattern parsing) → else newest available model whose parsed kind matches (fable/mythos for planner, opus for executor; "newest" = highest version by the catalog identity ordering already used for role fallbacks — reuse the existing comparator; if none exists, sort by parsed version fields). Thinking defaults per contract when no suffix. Tests: explicit pattern wins; suffix thinking wins; auto-detect picks fable-5 over fable-4; returns `undefined` when either side missing.

### Task 6: Duo tools + prompts

**Files:**
- Create: `src/duo/takeover-tool.ts`, `src/duo/handoff-tool.ts`
- Create: `src/prompts/tools/duo-request-takeover.md`, `src/prompts/tools/duo-handoff.md` (tool descriptions; `OrchestratorModeTool`'s import pattern `src/tools/orchestrator-mode.ts:4,35` is the template)
- Create: `src/duo/prompts/advisor-instructions.md`, `src/duo/prompts/planner-notice.md`, `src/duo/prompts/takeover-brief.md`, `src/duo/prompts/handback-brief.md`

**Interfaces:**
- Consumes: `TakeoverPurpose`, `TakeoverDecision` from `./state`; `AgentTool` types from `@oh-my-pi/pi-agent-core`; arktype `type`.
- Produces: `RequestTakeoverTool` (constructor callback per contract; result text varies by decision: accepted → "Takeover scheduled…", cooldown-advice → "Cooldown active — converted to high-severity advisory", rejected → "Takeover limit reached…"), `DuoHandoffTool` (throws `ToolError` unless controller phase is `planning`/`takeover`; success text "Handoff to executor scheduled").

Prompt content requirements: `advisor-instructions.md` = monitoring duties, drift/failure signals, escalation ladder (advise → request_takeover recover), done-claim hardening policy verbatim ("a done-claim without fresh decisive evidence — test output, command output, observed behavior — is rejected; repeated weak claims or high-risk changes escalate to `escalate_verify`; never trust unverified completion claims"), cooldown awareness (`{{cooldownRemaining}}`, `{{consecutiveTakeovers}}` Handlebars slots). `planner-notice.md` = Fable-as-main planning duties + "call `duo_handoff` when the plan is locked". `takeover-brief.md` = Handlebars `{{purpose}}/{{reason}}/{{directive}}` injected to the main stream at takeover. `handback-brief.md` = `{{resolution}}` for both the executor steer and the advisor catch-up delta.

### Task 7 (Wave 2): DuoController (`src/duo/controller.ts`) + barrel

**Files:**
- Create: `src/duo/controller.ts`, `src/duo/index.ts` (star re-exports of `./state`, `./controller`, `./handoff-tool`, `./takeover-tool`)
- Test: `src/duo/__tests__/controller.test.ts` (fake `DuoControllerHost` object; no module mocking)

**Interfaces:**
- Consumes: Tasks 1, 5, 6 exports.
- Produces: `DuoController`, `DuoControllerHost`, `DuoStatus` per contract.

Behavior to implement and test (one test per bullet): `reevaluate()` activates per matrix and applies the initial phase's model/thinking through the host (deferred when `isStreaming()`); planning→executing applies executor + `ensureAdvisorStarted(planner)` + planner-notice/handback injection; `requestTakeover` accepted → queues switch to planner, `pauseAdvisor()`, injects takeover brief (`nextTurn` when streaming, `steer` when idle); cooldown-advice decision performs no switch; `handoffToExecutor` → executor + `resumeAdvisor(handbackBrief)` + cooldown restart; `notifyManualModelChange` → suspend, no further host switches until `reevaluate` after `/duo on`; `notifyTurnEnd` applies exactly one queued switch and ticks cooldown; host `setModelTemporary` rejection → suspended + `emitNotice("warning", …)`; every transition calls `persistSnapshot`.

### Task 8 (Wave 3): AgentSession wiring (`src/session/agent-session.ts`)

**Files:**
- Modify: `src/session/agent-session.ts`

**Interfaces:**
- Consumes: `DuoController`, `resolveDuoConfig`, `RequestTakeoverTool`, `AdvisorRuntime.pause/resume`, `DoneVerdict.escalate_verify`.
- Produces: `getDuoStatus()`, `setDuoEnabled()`, `duoForceExec()` public API; duo advisor pinning; `duo_state` persistence.

Sub-steps (verify each anchor before editing; line refs are from 2026-07-02 reads):
- [ ] `#duoController?: DuoController` field + `#buildDuoController()` invoked from the same init site as `#advisorEnabled` (`:2077`); host implemented with session methods (`setModelTemporary`, `setThinkingLevel`, `emitNotice`, `sendCustomMessage` for `injectBrief`, `appendCustomMessageEntry` for `persistSnapshot` with `customType: "duo_state"`, `display: false`).
- [ ] Advisor pinning: when duo is executing/takeover phase, `#buildAdvisorRuntime` uses the duo planner model instead of `resolveAdvisorRoleSelection` (`:2155-2163`), and appends `new RequestTakeoverTool(cb)` to the tools array (`:2327`) with `cb = (p, r, d) => this.#duoController?.requestTakeover(p, r, d) ?? "rejected"`.
- [ ] Done-gate: `#checkAdvisorDoneGate` (`:2493`) gate condition becomes `advisor.doneGate || duo strict-executing`; add explicit `verdict.verdict === "escalate_verify"` branch → `this.#duoController?.requestTakeover("verify", note, missing-join)` + return `true` (defer stop) when accepted, else fall through to reject handling.
- [ ] Turn hook: call `#duoController?.notifyTurnEnd()` from the same post-turn site that drives `advisorRuntime.onTurnEnd` (`:1952`).
- [ ] Plan approval: duo transition fires where the approved-plan reference becomes set and plan mode state clears (`setPlanModeState(undefined)` path; cross-check `#clearTransientModeState` `src/modes/interactive-mode.ts:2357` so cancellation does NOT fire it — gate on `getPlanReferencePath()` non-empty).
- [ ] Orchestrator: `setOrchestratorModeState` → `#duoController?.reevaluate()` after state commit.
- [ ] Manual model change: `/model`-driven `setModel`/`setModelTemporary` invocations NOT originating from duo call `notifyManualModelChange()` (duo host calls a `#duoInternalSwitch` guard flag around its own `setModelTemporary` so it can distinguish).
- [ ] Compaction/reset: inside `#resetAdvisorSessionState` (`:2125`), after re-prime, feed the advisor the duo brief when duo is executing (re-prime path already reseeds; append advisor-instructions delta).
- [ ] Resume: after session load, read the last `duo_state` custom entry (if any) and construct the controller with `restored`; `reevaluate()` once mode reconciliation is done.
- [ ] `dispose()`: `#duoController?.dispose()`.

### Task 9 (Wave 3): `/duo` slash command (`src/slash-commands/builtin-registry.ts`)

**Files:**
- Modify: `src/slash-commands/builtin-registry.ts` (new entry adjacent to `/advisor` `:741-843`, which is the structural template: subcommands `on|off|status|exec`, `handle` + `handleTui`, `getTuiAutocompleteDescription` from `getDuoStatus()`)

Status output format: `Duo: <phase> — planner <provider/id>, executor <provider/id>, takeovers <n><, advisor paused?>`; `on|off` → `setDuoEnabled`, `exec` → `duoForceExec()` ("Handed off to executor." / "Duo is not in a hand-off-able phase.").

### Task 10 (Wave 3): Status-line indicator (`src/modes/components/status-line/segments.ts`)

**Files:**
- Modify: `src/modes/components/status-line/segments.ts` (`modelSegment` `:145-196`)

After the existing `++` advisor badge: read `ctx.session.getDuoStatus()`; when phase `executing` append `theme.fg("accent", "⇄")`; `planning` append `theme.fg("accent", "◆plan")`; `takeover` append `theme.fg("warning", purpose === "verify" ? "⚑verify" : "⚑takeover")`. All strings pass through existing width-safe rendering (no tabs, short literals; no user content).

### Task 11 (Verification wave — orchestrator-run): gates, changelog, QA

- [ ] `bun check` (repo root) — zero new errors.
- [ ] `bun test packages/coding-agent/src/duo packages/coding-agent/src/advisor` — green.
- [ ] Changelog: `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]` → `### Added` → `- Duo auto model switch: automatic Fable⇄Opus planner/executor switching in orchestrator mode with Fable advisor monitoring, strict done-claim gating (escalate-to-verify takeover), cooldown-hysteresis takeover/handback, and duo state persistence across resume.`
- [ ] QA handoff: run state-machine + controller + advisor suites from a clean shell; exercise `/duo status` in a scratch session when a TTY harness is available; otherwise unit evidence + `bun check` constitute the gate.

## Self-Review Notes

- Type names cross-checked across tasks (DuoPhase/DuoStatus/DuoControllerHost/TakeoverPurpose/TakeoverDecision/DuoResolvedConfig consistent).
- No placeholder steps; every code contract is spelled out in Locked Shared Contracts.
- Spec coverage: activation (edge 1) → Tasks 1/5/8; advisor auto-start (edge 2) → Tasks 7/8; thinking mapping (edge 3) → Tasks 5/7; takeover pause semantics (edge 4) → Tasks 2/7; persistence (edge 5) → Tasks 1 (snapshot), 8 (entry + resume); done-claim hardening (user addendum) → Tasks 4/6/8.
