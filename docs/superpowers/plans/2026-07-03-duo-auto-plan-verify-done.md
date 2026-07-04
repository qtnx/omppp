# Duo Auto-Plan + Verify-Done Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new duo takeover behaviors. **R7 — auto plan-takeover on user-message receipt:** when an incoming user message is plan-shaped (imperative build language + scope markers, EN+VI), the Fable planner takes the main stream THIS turn (synchronous pre-model switch on the non-streaming prompt path) and enters the existing duo planning phase to write a COMPLETE locked plan. **R8 — verify-takeover before done (active gate):** when the duo executor claims done after mutations, the done gate no longer merely consults the advisor — with `duo.takeover.verifyDone: "always"` (new default) it directly fires a `verify` planner takeover that independently re-runs the decisive checks before the stop is accepted, working even when the advisor is dead (fixes the current fail-open hole at agent-session.ts:2976-2979).

**Architecture:** All policy stays in `DuoController` (packages/coding-agent/src/duo/controller.ts) driven by the pure `DuoStateMachine` (src/duo/state.ts). The new user-message detector `detectPlanningNeeded` is a pure export of the existing leaf `src/duo/takeover-signals.ts` (precedent: `detectCompletionClaim`). `AgentSession` only wires seams: a new pre-model hook `#maybeDuoPlanTakeover` in `prompt()` (precedent: `#maybeAutoEnterOrchestratorMode` @7690), and a reshaped `#checkAdvisorDoneGate` whose decision logic is extracted into exported pure helpers (precedent: `shouldRunDuoDoneGate` @1312). Prompts stay in `.md` under `src/duo/prompts/`.

**Tech Stack:** Bun + TypeScript (ES `#private`, no `any`, top-level imports), `bun:test` with `spyOn` only (NEVER `mock.module`), mustache prompts via `@oh-my-pi/pi-utils` `prompt.render`, prompts imported `with { type: "text" }`, `logger` not `console`.

## Global Constraints

- Repo root: `~/.herdr/worktrees/omppp/orchestrator`; all paths relative to it. Branch `orchestrator`.
- **DO NOT COMMIT.** The orchestrator integrates; end every task after its focused tests pass.
- **Foreign WIP — DO NOT TOUCH:** `packages/coding-agent/src/tools/irc.ts`, `src/irc/bus.ts`, `src/cli/gallery-fixtures/agentic.ts`, `src/modes/interactive-mode.ts`, `src/prompts/agents/*.md`.
- Rules: ES `#private` fields, no `any` (use `unknown` + narrow casts), top-level imports only, prompts in `.md` `with { type: "text" }`, `logger` not `console.log`, Bun APIs preferred, `spyOn` never `mock.module`.
- **Disk/quota ~99%: ALL new tests are FakeHost/pure-unit level.** No real `AgentSession` construction, no `TempDir`, no file writes in new tests. The one existing real-session suite (`test/agent-session-done-gate.test.ts`) is NOT extended; running it is optional (see Verification).
- Per-task verification = focused `bun test <file>` runs. Bun transpiles without typechecking, so duo-module tasks stay runnable before session wiring lands. `bun --cwd=packages/coding-agent run check:types` is only expected green after Task 8 (the `DuoControllerHost` interface grows in Task 6; `#buildDuoHost` catches up in Task 8).
- All line numbers verified against the current tree on 2026-07-03; prefer the named symbol if a line drifted.

## Requirement → Task Map

| Locked design item | Tasks |
|---|---|
| R7.1 `detectPlanningNeeded` detector | 1 |
| R7.2 `duo.takeover.signals.planningNeeded` setting | 2 |
| R7.3 session hook `#maybeDuoPlanTakeover` | 7 |
| R7.4 `DuoController.requestPlanTakeover` | 5 |
| R8.5 `duo.takeover.verifyDone` setting | 2 |
| R8.6 done-gate reshape (active verify) | 8 |
| R8.7 verify counter semantics (state.ts) | 3 |
| R8.8 verified-claim flag (no string parsing) | 6 (controller) + 8 (session) |
| R8.9 verify prompt wording | 4 |
| Verification & QA | 9 |

> **SUPERSEDED (2026-07-03):** the R8 verify-done TAKEOVER described below was replaced by advisor careful done-review + a required qa subagent (no planner takeover).

## Reality-Check Flags (locked design vs. code — read before implementing)

1. **Design item 8 internal tension, resolved with a mutation window (deliberate refinement).** The locked text says the verified-claim flag is "consumed ONCE by the next `#checkAdvisorDoneGate`" AND that "if Fable's handback brief demands fixes … the NEXT done-claim runs the gate again." A bare boolean cannot satisfy both: after a fixes-demanding handback the executor mutates for several turns, and the first later done-claim would consume the stale flag and skip the gate. Resolution (no `duo_handoff` string parsing, per the lock): the flag records the transcript length at handback (`{ messageCount }`); the gate consumes it once and honors it ONLY when no new mutations landed after the handback (`hasMutationsSince(messages, messageCount)` — new pure helper, Task 1). Verified-and-immediately-reclaimed → skip; fixes-ran-then-reclaimed → gate fires again (bounded by `#verifyDoneRounds`).
2. **`verify` must also bypass the `maxConsecutive` cap, not just stop incrementing.** `DuoStateMachine.onTakeoverRequested` (state.ts:136-152) checks `consecutiveTakeovers >= maxConsecutive` FIRST for all purposes; if verify only stopped incrementing but stayed capped, recover history (cap default 2, settings-schema.ts:601-610) would silently disable the verify-done gate. Task 3 exempts verify from both the check and the increment. The existing test `state.test.ts` "rejects takeover requests after maxConsecutive is reached" (~:174-186) asserts the OLD behavior (recover→verify→verify → rejected) and is deliberately rewritten — this is the locked behavior change, not a regression.
3. **`#enterManualPlanning` does NOT switch the model** (controller.ts:310-334) — its only caller `notifyManualModelChange` (:255-308, call @~274) runs after the user already switched. `requestPlanTakeover` (Task 5) must additionally `await #applySwitch(planner, plannerThinking)`; with `isStreaming() === false` at message receipt this resolves synchronously via `#applySwitchNow` → `host.setModelTemporary` (controller.ts:575-608), so Fable holds the stream THIS turn.
4. **The injected plan brief lands this turn via direct transcript append, not `#pendingNextTurnMessages`.** `injectBrief` → `void this.sendCustomMessage(..., { deliverAs: "nextTurn" })` (agent-session.ts:2196-2201); NOT streaming → the message is appended straight to `agent.state.messages` (sendCustomMessage :8501-8524), before `#promptAgentWithIdleRetry` (@8064) runs. `#pendingNextTurnMessages` (@7966-7970) is the streaming-case parking lot. Either way the brief precedes the model call; `injectBrief` is fire-and-forget (`void`), but the awaits between the hook (@7690) and the model call (@8064) let the single pre-append `await` settle — same mechanics `duoReplan` (@15750) relies on today. No new code needed; do not "fix" this.
5. **`manual-plan-brief.md` first sentence says "The user manually placed you…"** — false for the automatic entry that reuses it. One-line neutral reword in Task 4 (kept minimal; existing session-wiring assertions only check COMPLETE / local://PLAN.md / duo_handoff / no-mustache and stay green).
6. **No double-gate:** `#evaluateDuoTakeoverSignals` (agent-session.ts:2333-2349) suppresses `doneClaimWithoutEvidence` while `doneGateCanRun`. With `verifyDone: "always"` the gate can now run even when the advisor is dead, so `doneGateCanRun` must be extended (Task 8) or the turn-end signal and the done gate would both fire verify takeovers.
7. **Residual, out of scope (do NOT change):** (a) verify handback still arms `cooldownRemaining = cooldownTurns` (state.ts:94-107), briefly gating recover takeovers after a verify — pre-existing, untouched; (b) the signal-driven verify branch (`notifyAutoSignals` @405-412) stays uncapped by `#verifyDoneRounds`; its natural bound is that Fable's own bash verification becomes evidence that clears `detectDoneClaimWithoutEvidence`; (c) `duo.takeover.enabled` remains vestigial.
8. **`#advisorAutoResumeSuppressed` (decision):** the guard (@2913) continues to block the WHOLE gate including the new active verify — a user interrupt means the user holds control; auto-takeover against that is hostile. Cleared on the next user-initiated prompt (@7699-7701).

## File Structure

- **Modify** `packages/coding-agent/src/duo/takeover-signals.ts` — add `detectPlanningNeeded` + `PlanningNeededDetection`; add `hasMutationsSince`; `hasMutationsSinceLastUserPrompt` delegates to it.
- **Modify** `packages/coding-agent/src/duo/__tests__/takeover-signals.test.ts` — detector + window-helper tests.
- **Modify** `packages/coding-agent/src/config/settings-schema.ts` — `duo.takeover.verifyDone` (insert after :610), `duo.takeover.signals.planningNeeded` (insert after the loopThreshold block, before `shellPath` @666).
- **Modify** `packages/coding-agent/src/config/model-resolver.ts` — `DuoTakeoverSignalSettings` (:1307-1312) + `DuoResolvedConfig` (:1314-1325) + `resolveDuoConfig` return (:1398-1418).
- **Modify** `packages/coding-agent/src/duo/state.ts` — `onTakeoverRequested` (:136-152) verify exemption.
- **Modify** `packages/coding-agent/src/duo/__tests__/state.test.ts` — rewrite cap test (~:174-186), add verify-uncounted tests.
- **Modify** `packages/coding-agent/src/duo/controller.ts` — host interface (:24-48) + `#enterManualPlanning` notice param (:310-334) + new `requestPlanTakeover` + `handoffToExecutor` verify detection (:462-513).
- **Modify** `packages/coding-agent/src/duo/__tests__/controller.test.ts` — duoConfig fixture (:76-92), FakeHost (:53-153), new describes.
- **Modify** `packages/coding-agent/src/duo/__tests__/session-wiring.test.ts` — duoConfig fixture (~:59) + FakeHost (~:72-144) stub only.
- **Modify** `packages/coding-agent/src/duo/prompts/takeover-brief.md`, `takeover-overlay.md`, `manual-plan-brief.md`.
- **Create** `packages/coding-agent/src/duo/__tests__/duo-prompts.test.ts` — semantic prompt assertions (new file; avoids collisions with session-wiring.test.ts).
- **Modify** `packages/coding-agent/src/session/agent-session.ts` — import (@195-201), fields (near :1503/:1520), `#buildDuoHost` (:2175-2243), `#evaluateDuoTakeoverSignals` (:2333-2349), `#checkAdvisorDoneGate` (:2901-3018), pure helpers (:1312-1341 area), `prompt()` hook (@7689-7691), new `#maybeDuoPlanTakeover` (near `#maybeAutoEnterOrchestratorMode` @7578), resets (@7859-7869, @8891-8892, @10380-10381).
- **Create** `packages/coding-agent/src/duo/__tests__/verify-done-gate.test.ts` — pure-helper tests.

---

### Task 1: `detectPlanningNeeded` detector + `hasMutationsSince` window helper (Group A)

**Files:**
- Modify: `packages/coding-agent/src/duo/takeover-signals.ts` (append detector after `detectPlanningShapedWork` ~:180; insert `hasMutationsSince` next to `hasMutationsSinceLastUserPrompt` ~:57)
- Modify: `packages/coding-agent/src/duo/__tests__/takeover-signals.test.ts` (append describes)

**Interfaces (Produces — Tasks 7/8 consume these exact names):**
```ts
export interface PlanningNeededDetection { needed: boolean; evidence: string[]; }
export function detectPlanningNeeded(text: string): PlanningNeededDetection;
export function hasMutationsSince(messages: readonly AgentMessage[], start: number): boolean;
```

- [ ] **Step 1: Write the failing tests** (append to takeover-signals.test.ts; reuse the existing `userMsg`/`toolResult` builders @12-27):

```ts
describe("detectPlanningNeeded", () => {
	// EN positive
	it("fires on an imperative with an itemized scope list", () => {
		const r = detectPlanningNeeded(
			"Implement rate limiting on the API gateway:\n1. token bucket per key\n2. config flag\n3. tests",
		);
		expect(r.needed).toBe(true);
		expect(r.evidence.length).toBeGreaterThanOrEqual(2);
	});
	it("fires on an imperative with multiple clauses", () => {
		expect(
			detectPlanningNeeded(
				"Build a new onboarding flow with email verification. Then add analytics events for each step and integrate the welcome screen.",
			).needed,
		).toBe(true);
	});
	it("fires on an imperative with multiple file mentions", () => {
		expect(
			detectPlanningNeeded("Refactor the payment module to support stripe.ts and paypal.ts providers").needed,
		).toBe(true);
	});
	// VI positive
	it("fires on Vietnamese imperatives with stacked build verbs", () => {
		expect(
			detectPlanningNeeded(
				"Làm tính năng đăng nhập bằng Google: thêm nút login, tạo API callback, viết test cho flow mới",
			).needed,
		).toBe(true);
	});
	it("fires on Vietnamese redesign requests with scope", () => {
		expect(
			detectPlanningNeeded("Thiết kế lại trang dashboard, thêm biểu đồ doanh thu và tích hợp bộ lọc theo ngày").needed,
		).toBe(true);
	});
	// Negatives — MUST never fire
	it("never fires on pure questions, even ones containing build verbs", () => {
		expect(detectPlanningNeeded("why does the build fail?").needed).toBe(false);
		expect(detectPlanningNeeded("Tại sao server bị lỗi 500?").needed).toBe(false);
		expect(detectPlanningNeeded("how does the duo controller work?").needed).toBe(false);
		expect(
			detectPlanningNeeded("What would happen if we migrated to Postgres? Would the ORM need changes?").needed,
		).toBe(false);
	});
	it("never fires on acks and continuations", () => {
		for (const t of ["ok", "continue", "làm tiếp", "làm tiếp đi", "tiếp đi", "status", "proceed", "vâng"]) {
			expect(detectPlanningNeeded(t).needed).toBe(false);
		}
	});
	it("never fires on trivial fixes, slash commands, or empty text", () => {
		expect(detectPlanningNeeded("fix typo in README").needed).toBe(false);
		expect(detectPlanningNeeded("sửa lỗi chính tả trong trang chủ").needed).toBe(false);
		expect(detectPlanningNeeded("/duo exec").needed).toBe(false);
		expect(detectPlanningNeeded("").needed).toBe(false);
		expect(detectPlanningNeeded("   ").needed).toBe(false);
	});
	it("never fires on a bare imperative without scope markers", () => {
		expect(detectPlanningNeeded("add a comment").needed).toBe(false);
	});
});

describe("hasMutationsSince", () => {
	it("detects mutations at or after the start index only", () => {
		const messages = [userMsg("go"), toolResult("edit"), toolResult("bash")];
		expect(hasMutationsSince(messages, 0)).toBe(true);
		expect(hasMutationsSince(messages, 2)).toBe(true); // bash counts as mutating
		expect(hasMutationsSince(messages, 3)).toBe(false);
	});
	it("ignores error tool results and clamps negative starts", () => {
		expect(hasMutationsSince([toolResult("edit", true)], -5)).toBe(false);
	});
});
```
Add `detectPlanningNeeded, hasMutationsSince` to the test file's import from `"../takeover-signals"` (:3-10).

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/takeover-signals.test.ts`. Expected: FAIL (exports missing).

- [ ] **Step 3: Implement `hasMutationsSince`** and make `hasMutationsSinceLastUserPrompt` (:57-66) delegate:

```ts
/** Whether any successful mutating toolResult exists at or after `start` (clamped to 0). */
export function hasMutationsSince(messages: readonly AgentMessage[], start: number): boolean {
	for (let i = Math.max(0, start); i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "toolResult") continue;
		if (message.isError) continue;
		if (DONE_GATE_MUTATION_TOOLS.has(message.toolName)) return true;
	}
	return false;
}

export function hasMutationsSinceLastUserPrompt(messages: readonly AgentMessage[]): boolean {
	return hasMutationsSince(messages, lastUserPromptIndex(messages));
}
```

- [ ] **Step 4: Implement `detectPlanningNeeded`** (append after `detectPlanningShapedWork`). The TESTS are the contract — tune patterns until Step 1's cases pass; the sketch below is the intended shape:

```ts
/** Detection result for {@link detectPlanningNeeded}. */
export interface PlanningNeededDetection {
	needed: boolean;
	evidence: string[];
}

/** Imperative build verbs (EN + VI). VI tokens use explicit separators — \b is unreliable around accented chars. */
const PLANNING_IMPERATIVE_PATTERN =
	/\b(?:implement|build|add|create|refactor|redesign|migrate|integrate|rewrite|support)\b|(?:^|[\s,;:.!])(?:làm|thêm|xây(?:\s+dựng)?|tạo|viết|thiết\s+kế|tích\s+hợp)(?=$|[\s,;:.!])|tính\s+năng/iu;
const PLANNING_IMPERATIVE_PATTERN_G = new RegExp(PLANNING_IMPERATIVE_PATTERN.source, "giu");

/** Whole-message acknowledgements / continuations (never plan-shaped). */
const ACK_CONTINUATION_PATTERN =
	/^(?:ok(?:ay)?|yes|yep|no|nope|thanks?|thank\s+you|continue|proceed|resume|status|go(?:\s+on)?|(?:làm\s+)?tiếp(?:\s+tục)?(?:\s+đi)?|tiếp\s+đi|ừ|dạ|vâng|được)[\s.!]*$/iu;

/** Trivial one-off fixes (never plan-shaped). */
const TRIVIAL_FIX_PATTERN =
	/\b(?:fix|correct)(?:\s+\S+){0,3}\s+typos?\b|\bfix\s+typos?\b|\bone[- ]liner\b|\bquick\s+fix\b|sửa\s+(?:lỗi\s+)?chính\s+tả/iu;

const LIST_MARKER_PATTERN = /^\s*(?:\d+[.)]|[-*+•])\s+\S/m;
const INLINE_ENUM_PATTERN = /(?:^|\s)\d+[.)]\s/g;
const FILE_MENTION_PATTERN = /\b[\w./-]+\.[a-z]{1,4}\b/gi;

/**
 * Whether an incoming USER message is plan-shaped: imperative build language
 * (EN+VI) combined with at least one scope marker. Pure; drives the automatic
 * duo planning takeover at message receipt (R7).
 */
export function detectPlanningNeeded(text: string): PlanningNeededDetection {
	const none: PlanningNeededDetection = { needed: false, evidence: [] };
	const trimmed = text.trim();
	if (!trimmed) return none;
	if (trimmed.startsWith("/")) return none;
	if (ACK_CONTINUATION_PATTERN.test(trimmed)) return none;
	if (TRIVIAL_FIX_PATTERN.test(trimmed)) return none;

	// Imperatives only count in non-question sentences, so "…if we migrated?" never fires.
	const sentences = trimmed.split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim().length > 0);
	const declarative = sentences.filter(s => !s.trimEnd().endsWith("?"));
	if (declarative.length === 0) return none; // pure question(s)
	const declarativeText = declarative.join("\n");
	if (!PLANNING_IMPERATIVE_PATTERN.test(declarativeText)) return none;

	const evidence: string[] = ["imperative build verb"];
	if (LIST_MARKER_PATTERN.test(trimmed) || (trimmed.match(INLINE_ENUM_PATTERN)?.length ?? 0) >= 2) {
		evidence.push("itemized scope list");
	}
	if (declarative.length >= 2) evidence.push("multiple task clauses");
	if ((declarativeText.match(PLANNING_IMPERATIVE_PATTERN_G)?.length ?? 0) >= 2) evidence.push("multiple build verbs");
	if ((trimmed.match(FILE_MENTION_PATTERN)?.length ?? 0) >= 2) evidence.push("multiple file/feature mentions");
	if (trimmed.length > 200) evidence.push("long imperative request");
	if (evidence.length < 2) return none; // imperative alone is not enough
	return { needed: true, evidence };
}
```
Note: `PLANNING_IMPERATIVE_PATTERN_G` is module-level; reset `lastIndex` is unnecessary with `String.match(g)`.

- [ ] **Step 5: Verify** — `bun test packages/coding-agent/src/duo/__tests__/takeover-signals.test.ts`. Expected: PASS (existing describes untouched). Do NOT commit.

---

### Task 2: Settings `duo.takeover.verifyDone` + `duo.takeover.signals.planningNeeded` + resolver + fixtures (Group A)

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts` (two inserts: after :610, and after the `duo.takeover.signals.loopThreshold` block — before `shellPath` @666)
- Modify: `packages/coding-agent/src/config/model-resolver.ts:1307-1325` and the `resolveDuoConfig` return (:1398-1418)
- Modify: `packages/coding-agent/src/duo/__tests__/controller.test.ts:76-92` (`duoConfig()` fixture)
- Modify: `packages/coding-agent/src/duo/__tests__/session-wiring.test.ts` (`duoConfig()` fixture, ~:59-70)

**Interfaces (Produces):**
```ts
export interface DuoTakeoverSignalSettings {
	enabled: boolean;
	sentiment: boolean;
	failureThreshold: number;
	loopThreshold: number;
	planningNeeded: boolean; // NEW
}
// DuoResolvedConfig gains: verifyDone: "always" | "escalate" | "off";
```

- [ ] **Step 1: Add `duo.takeover.verifyDone`** after the `duo.takeover.maxConsecutive` block (settings-schema.ts:610), before `duo.manualSwitchIntent` (:611):

```ts
	"duo.takeover.verifyDone": {
		type: "enum",
		values: ["always", "escalate", "off"] as const,
		default: "always",
		ui: {
			tab: "model",
			group: "Duo",
			label: "Duo Verify-Done Takeover",
			description:
				"How a duo executor done claim is verified before the stop is accepted. always = the planner takes the main stream and independently re-runs the decisive checks (works even when the advisor is down); escalate = the advisor done-review decides and may escalate to a verify takeover; off = advisor done-review only, never a takeover.",
		},
	},
```

- [ ] **Step 2: Add `duo.takeover.signals.planningNeeded`** after the `duo.takeover.signals.loopThreshold` block (before `shellPath` @666):

```ts
	"duo.takeover.signals.planningNeeded": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Duo",
			label: "Duo Planning-Needed Signal",
			description:
				"Automatically enter the duo planning phase (planner takeover) when an incoming user message is plan-shaped: imperative build language plus scope markers such as lists, multiple clauses, or multiple file mentions.",
		},
	},
```

- [ ] **Step 3: Extend the resolver types** (model-resolver.ts): add `planningNeeded: boolean;` to `DuoTakeoverSignalSettings` (:1307-1312); add `verifyDone: "always" | "escalate" | "off";` to `DuoResolvedConfig` after `doneGate` (:1322).

- [ ] **Step 4: Populate in `resolveDuoConfig`** — after `doneGate: settings.get("duo.doneGate"),` (:1410) add `verifyDone: settings.get("duo.takeover.verifyDone"),`; inside the `signals` object (:1412-1417) add `planningNeeded: settings.get("duo.takeover.signals.planningNeeded"),`.

- [ ] **Step 5: Update both `duoConfig()` fixtures** so the suites keep compiling — controller.test.ts (:76-92) and session-wiring.test.ts (~:59): add `verifyDone: "always",` after `doneGate`, and `planningNeeded: true,` inside `signals: { … }`.

- [ ] **Step 6: Verify** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts packages/coding-agent/src/duo/__tests__/session-wiring.test.ts`. Expected: PASS (behavior unchanged; fixtures compile). Do NOT commit.

---

### Task 3: State machine — verify takeovers exempt from the consecutive cap (Group A)

**Files:**
- Modify: `packages/coding-agent/src/duo/state.ts:136-152` (`onTakeoverRequested`)
- Modify: `packages/coding-agent/src/duo/__tests__/state.test.ts` (rewrite "rejects takeover requests after maxConsecutive is reached" ~:174-186; add new tests; fixture `config = { cooldownTurns: 3, maxConsecutive: 2 }` @:5)

- [ ] **Step 1: Write the failing tests.** REWRITE the existing cap test (~:174-186) to prove the cap on recover only, and APPEND verify-exemption tests:

```ts
	it("rejects recover takeovers after maxConsecutive is reached", () => {
		const machine = new DuoStateMachine({ cooldownTurns: 3, maxConsecutive: 2 });
		machine.evaluateActivation(input({ mode: "on" }));
		expect(machine.onTakeoverRequested("recover")).toBe("accepted");
		expect(machine.onHandoffToExecutor()).toBe(true);
		expect(machine.onTakeoverRequested("recover", { bypassCooldown: true })).toBe("accepted");
		expect(machine.onHandoffToExecutor()).toBe(true);
		expect(machine.onTakeoverRequested("recover", { bypassCooldown: true })).toBe("rejected");
		expect(machine.snapshot).toMatchObject({ phase: "executing", takeoverCount: 2, consecutiveTakeovers: 2 });
	});

	it("verify takeovers neither count toward nor are blocked by the consecutive cap", () => {
		const machine = new DuoStateMachine({ cooldownTurns: 3, maxConsecutive: 2 });
		machine.evaluateActivation(input({ mode: "on" }));
		// Reach the cap with recover takeovers.
		machine.onTakeoverRequested("recover");
		machine.onHandoffToExecutor();
		machine.onTakeoverRequested("recover", { bypassCooldown: true });
		machine.onHandoffToExecutor();
		expect(machine.snapshot.consecutiveTakeovers).toBe(2);
		// Verify still goes through at the cap and does not increment it.
		expect(machine.onTakeoverRequested("verify")).toBe("accepted");
		expect(machine.onHandoffToExecutor()).toBe(true);
		expect(machine.onTakeoverRequested("verify")).toBe("accepted");
		expect(machine.snapshot).toMatchObject({ takeoverPurpose: "verify", consecutiveTakeovers: 2, takeoverCount: 4 });
	});
```
Check the neighboring test "allows verify takeovers to bypass cooldown" (~:154-163): it asserts `takeoverCount: 2` only — stays green unchanged.

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/state.test.ts`. Expected: FAIL (verify currently capped and counted).

- [ ] **Step 3: Implement** — replace `onTakeoverRequested` (state.ts:136-152):

```ts
	onTakeoverRequested(purpose: TakeoverPurpose, options?: TakeoverRequestOptions): TakeoverDecision {
		// `verify` is by-design recurrent (the verify-done gate fires it on every
		// unverified done claim); the consecutive cap only guards recover thrash.
		if (purpose !== "verify" && this.#state.consecutiveTakeovers >= this.#config.maxConsecutive) {
			return "rejected";
		}
		if (purpose === "recover" && this.#state.cooldownRemaining > 0 && !options?.bypassCooldown) {
			return "cooldown-advice";
		}
		if (this.#state.phase !== "executing") {
			return "rejected";
		}

		this.#state.phase = "takeover";
		this.#state.takeoverPurpose = purpose;
		this.#state.takeoverCount += 1;
		if (purpose !== "verify") {
			this.#state.consecutiveTakeovers += 1;
		}
		return "accepted";
	}
```
Leave `onExecutorEscalate` (:118-134) untouched — it is recover-purposed. Leave `onHandoffToExecutor` cooldown arming untouched (Reality-Check flag 7a).

- [ ] **Step 4: Verify** — `bun test packages/coding-agent/src/duo/__tests__/state.test.ts`. Expected: PASS. Do NOT commit.

---

### Task 4: Prompts — verify wording + neutral manual-plan intro + semantic tests (Group A)

**Files:**
- Modify: `packages/coding-agent/src/duo/prompts/takeover-brief.md`
- Modify: `packages/coding-agent/src/duo/prompts/takeover-overlay.md`
- Modify: `packages/coding-agent/src/duo/prompts/manual-plan-brief.md` (first sentence only)
- Create: `packages/coding-agent/src/duo/__tests__/duo-prompts.test.ts` (NEW file — keeps prompt tests out of session-wiring.test.ts, which Group B also edits)

- [ ] **Step 1: Write the failing tests** (new file):

```ts
import { describe, expect, test } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import manualPlanBrief from "../prompts/manual-plan-brief.md" with { type: "text" };
import takeoverBrief from "../prompts/takeover-brief.md" with { type: "text" };
import takeoverOverlay from "../prompts/takeover-overlay.md" with { type: "text" };

describe("duo takeover prompts", () => {
	test("takeover brief tells a verify takeover to re-run decisive checks and hand back evidence or gaps", () => {
		const rendered = prompt.render(takeoverBrief, {
			purpose: "verify",
			reason: "duo verify-done gate: independent verification before done",
			directive: "re-run the decisive checks",
		});
		expect(rendered).toContain("duo_handoff");
		expect(rendered).toContain("evidence");
		expect(rendered).toMatch(/re-run|decisive checks/);
		expect(rendered).toMatch(/missing/i);
		expect(rendered).not.toContain("{{");
	});
	test("takeover overlay describes verify as independent re-verification with evidence-or-gaps handback", () => {
		expect(takeoverOverlay).toContain("verify");
		expect(takeoverOverlay).toMatch(/fresh evidence/);
		expect(takeoverOverlay).toMatch(/missing/i);
	});
	test("manual plan brief is trigger-neutral (covers manual switch AND automatic plan takeover)", () => {
		expect(manualPlanBrief).not.toContain("manually placed");
		expect(manualPlanBrief).toContain("FULL-PLAN INTENT");
		expect(manualPlanBrief).toContain("COMPLETE");
	});
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/duo-prompts.test.ts`. Expected: FAIL.

- [ ] **Step 3: Edit `takeover-brief.md`** — replace the single verify sentence ("If purpose is `verify`, independently verify the completion claim by running the decisive checks yourself before anything else.") with:

```md
If purpose is `verify`, independently verify the completion claim before anything else: re-run the decisive checks yourself or through a `qa`/`task` subagent, and treat the executor's claims as unverified until you hold fresh evidence. Then call `duo_handoff`: if the claim holds, put the verification evidence in the resolution; if it does not, make the resolution a handback brief listing exactly what is missing or broken and the checks that prove it.
```
Keep the surrounding `<system-reminder>` wrapper, the `{{purpose}}/{{reason}}/{{directive}}` lines, and the final duo_handoff sentence.

- [ ] **Step 4: Edit `takeover-overlay.md`** — extend the verify clause in the middle paragraph to:

```md
`verify`: independently re-run the decisive checks (yourself or via a qa subagent) and verify the executor's completion claims with fresh evidence — hand back either the evidence or an exact list of what is missing.
```
Keep the `{{current}}/{{planner}}/{{executor}}` identity line untouched (session-wiring.test.ts asserts it verbatim).

- [ ] **Step 5: Edit `manual-plan-brief.md`** — replace ONLY the first sentence ("The user manually placed you — the Fable model — on the main stream while the executor was running.") with:

```md
You — the Fable model — now hold the main stream while the executor was running.
```
Everything else (FULL-PLAN INTENT, `{{planArtifact}}`, `{{executor}}`, duo_handoff contract) stays byte-identical. Existing session-wiring assertions (COMPLETE / local://PLAN.md / duo_handoff / no `{{`) stay green.

- [ ] **Step 6: Verify** — `bun test packages/coding-agent/src/duo/__tests__/duo-prompts.test.ts packages/coding-agent/src/duo/__tests__/session-wiring.test.ts`. Expected: PASS. Do NOT commit.

---

### Task 5: Controller — `requestPlanTakeover` (Group B, after Task 2's fixture lands)

**Files:**
- Modify: `packages/coding-agent/src/duo/controller.ts` — parameterize `#enterManualPlanning` (:310-334); add `requestPlanTakeover` (place right after `notifyPlanModeEntered`, ~:225)
- Modify: `packages/coding-agent/src/duo/__tests__/controller.test.ts` — append a describe

**Interfaces (Produces — Task 7 consumes):**
```ts
async requestPlanTakeover(reason: string): Promise<boolean>;
```

- [ ] **Step 1: Write the failing tests** (append to controller.test.ts; use the existing `fakeHost()`/`duoConfig()` helpers — `host.streaming` defaults to `false`, which IS the message-receipt condition):

```ts
describe("requestPlanTakeover", () => {
	test("enters planning, switches to the planner synchronously, injects the full-plan brief, pauses the advisor", async () => {
		const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");

		const engaged = await controller.requestPlanTakeover("imperative build verb; itemized scope list");

		expect(engaged).toBe(true);
		expect(controller.status.phase).toBe("planning");
		expect(host.switches.at(-1)?.model.id).toBe(planner.id); // sync switch: recorded already
		expect(host.briefs.at(-1)?.text).toContain("COMPLETE");
		expect(host.briefs.at(-1)?.text).toContain("duo_handoff");
		expect(host.pauses).toBeGreaterThanOrEqual(1);
		const notice = host.notices.at(-1);
		expect(notice?.text).toContain("planning takeover");
		expect(notice?.text).toContain("imperative build verb");
		expect(notice?.text).toContain("/duo exec");
	});

	test("no-ops when not executing or when the planner already holds the stream", async () => {
		const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		await controller.requestPlanTakeover("first");
		const switchesAfterFirst = host.switches.length;
		// Already planning → no-op (anti-flap).
		expect(await controller.requestPlanTakeover("second")).toBe(false);
		expect(host.switches.length).toBe(switchesAfterFirst);

		// Executing but planner already on the stream → no-op.
		const host2 = fakeHost({ model: planner, orchestrator: true, planModeOn: false });
		const controller2 = new DuoController(host2, duoConfig({ mode: "on" }));
		await controller2.reevaluate();
		if (controller2.status.phase === "executing") {
			expect(await controller2.requestPlanTakeover("noop")).toBe(false);
		}
	});

	test("a failing model switch suspends duo and reports false", async () => {
		const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.failSwitch = true;
		expect(await controller.requestPlanTakeover("reason")).toBe(false);
		expect(controller.status.phase).toBe("suspended");
	});
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`. Expected: FAIL (method missing).

- [ ] **Step 3: Parameterize `#enterManualPlanning`** (:310) — signature `#enterManualPlanning(notice?: string): boolean`; the `emitNotice` call (:326-329) becomes:

```ts
		this.#host.emitNotice(
			"info",
			notice ??
				"Duo planning: manual switch to the planner. Write and lock the complete plan, then call duo_handoff — the executor resumes only from your handoff.",
		);
```
The existing caller (`notifyManualModelChange` @~274) passes nothing — behavior unchanged.

- [ ] **Step 4: Add `requestPlanTakeover`** after `notifyPlanModeEntered` (~:225):

```ts
	/** R7: automatic planning takeover at user-message receipt. Reuses the
	 *  manual-planning entry (phase→planning, executor slot preserved, full-plan
	 *  brief, advisor pause) and additionally switches the main stream to the
	 *  planner — the manual path relies on the user having already switched.
	 *  Called while NOT streaming, so the switch applies synchronously and the
	 *  planner holds the stream for THIS turn. Not a takeover in machine terms:
	 *  counters and cooldown are untouched (onReplanRequested). */
	async requestPlanTakeover(reason: string): Promise<boolean> {
		if (this.#machine.phase !== "executing") return false;
		const current = this.#host.currentModel();
		if (current && modelsAreEqual(current, this.#config.planner)) return false;
		if (!this.#enterManualPlanning(`Duo: planning takeover — ${reason} (use /duo exec to skip)`)) return false;
		return await this.#applySwitch(this.#config.planner, this.#config.plannerThinking);
	}
```
Anti-flap is structural: the session hook runs once per `prompt()`, and `phase !== "executing"` rejects re-entry while planning/takeover. No extra session flag.

- [ ] **Step 5: Verify** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`. Expected: PASS. Do NOT commit.

---

### Task 6: Controller — verified-claim handback hook `markDoneClaimVerified` (Group B, same owner as Task 5)

**Files:**
- Modify: `packages/coding-agent/src/duo/controller.ts` — `DuoControllerHost` (:24-48), `handoffToExecutor` (:462-513)
- Modify: `packages/coding-agent/src/duo/__tests__/controller.test.ts` — FakeHost (:53-153) + tests
- Modify: `packages/coding-agent/src/duo/__tests__/session-wiring.test.ts` — FakeHost (~:72-144): add a no-op stub ONLY (compile fix; Group A/B coordination: this file's fixtures are owned by whichever of Task 2/6 lands second)

**Interfaces (Produces — Task 8 consumes):**
```ts
// DuoControllerHost gains:
/** A verify-purpose takeover handed back: the current done claim was independently reviewed. */
markDoneClaimVerified(): void;
```

- [ ] **Step 1: Write the failing tests** (append to controller.test.ts; extend the `FakeHost` interface with `doneClaimVerifiedMarks: number` and the fake with `markDoneClaimVerified() { this.doneClaimVerifiedMarks += 1; }`, initialized to 0):

```ts
describe("verify handback marks the done claim verified", () => {
	test("verify takeover → duo_handoff marks exactly once", async () => {
		const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.requestTakeover("verify", "gate", "re-run checks")).toBe("accepted");
		expect(await controller.handoffToExecutor("verified: focused suites green")).toBe("ok");
		expect(host.doneClaimVerifiedMarks).toBe(1);
	});
	test("recover takeover and planning handoffs never mark", async () => {
		const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.requestTakeover("recover", "stuck", "unblock");
		await controller.handoffToExecutor("unblocked");
		expect(host.doneClaimVerifiedMarks).toBe(0);
	});
	test("a failed executor switch does not mark", async () => {
		const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.requestTakeover("verify", "gate", "re-run checks");
		host.failSwitch = true;
		expect(await controller.handoffToExecutor("verified")).toBe("switch-failed");
		expect(host.doneClaimVerifiedMarks).toBe(0);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`. Expected: FAIL (interface/method missing → the fake won't compile until the interface gains the method; add interface first if Bun's transpile complains in the other order).

- [ ] **Step 3: Implement.** (a) Add `markDoneClaimVerified(): void;` to `DuoControllerHost` after `planModeActive()` (:47). (b) In `handoffToExecutor` (:462-513), capture the purpose BEFORE the machine transition clears it, and mark AFTER the successful switch:

```ts
		const previousPhase = this.#machine.phase;
		const verifiedDoneClaim = previousPhase === "takeover" && this.#machine.snapshot.takeoverPurpose === "verify";
		if (!this.#machine.onHandoffToExecutor()) {
			return "wrong-phase";
		}
		// … existing body unchanged (switch, plan mode, orchestrator, advisor resume, brief) …
		if (verifiedDoneClaim) this.#host.markDoneClaimVerified();
		this.#persistSnapshot();
		return "ok";
```
The early `#isExecutingLike()` branch (:463-481, summon restore) is untouched — a summon is never a verify. NO parsing of the `resolution` string anywhere (locked).
(c) Add the no-op stub `markDoneClaimVerified() {},` to session-wiring.test.ts's `fakeHost()` (~:85-144).

- [ ] **Step 4: Verify** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts packages/coding-agent/src/duo/__tests__/session-wiring.test.ts`. Expected: PASS. NOTE: `check:types` package-wide is now RED until Task 8 adds the method to `#buildDuoHost` — expected; focused tests still run (Bun transpiles per-file). Do NOT commit.

---

### Task 7: Session — `#maybeDuoPlanTakeover` hook at message receipt (Group C, after Tasks 1/2/5)

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts` — import (@195-201), new method (place directly after `#maybeAutoEnterOrchestratorMode`, :7578-…), call site (@7689-7691)

- [ ] **Step 1: Extend the import** from `"../duo/takeover-signals"` (:195-201) with `detectPlanningNeeded`.

- [ ] **Step 2: Add the hook method** after `#maybeAutoEnterOrchestratorMode`:

```ts
	/** R7: automatic duo planning takeover when an incoming user message is
	 *  plan-shaped. Message-receipt seam, non-streaming prompt path only —
	 *  steer()/followUp() (mid-stream) are explicit v1 non-goals: a switch
	 *  decided mid-stream would only queue for the NEXT turn. Runs BEFORE
	 *  #promptWithMessage so the planner model + full-plan brief are in place
	 *  for THIS turn's model call. */
	async #maybeDuoPlanTakeover(expandedText: string): Promise<void> {
		if (this.#agentKind !== "main") return;
		const controller = this.#duoController; // never #ensureDuoController: don't create one here
		if (!controller || controller.status.phase !== "executing") return;
		if (!this.settings.get("duo.takeover.signals.enabled")) return;
		if (!this.settings.get("duo.takeover.signals.planningNeeded")) return;
		const detection = detectPlanningNeeded(expandedText);
		if (!detection.needed) return;
		await controller.requestPlanTakeover(detection.evidence.join("; "));
	}
```

- [ ] **Step 3: Wire the call site** — extend the existing block @7689-7691 (this guard already excludes synthetic prompts and streaming; a real user message is guaranteed here — `message.role === "user"` is built at :7749 from `!options?.synthetic`):

```ts
		if (!options?.synthetic && !this.isStreaming) {
			await this.#maybeAutoEnterOrchestratorMode(expandedText);
			await this.#maybeDuoPlanTakeover(expandedText);
		}
```
Ordering note: orchestrator auto-enter runs first so `#enterManualPlanning`'s `#planningOverlayOnly = host.orchestratorEnabled()` (controller.ts:317) sees the fresh mode — planning then uses the overlay instead of plan mode, matching manual behavior.

- [ ] **Step 4: Verify (compile + behavior contract).** The hook is 8 lines of guard wiring mirroring `#evaluateDuoTakeoverSignals` (:2333-2341); its contract is covered by Task 1 (detector) + Task 5 (controller) tests. Run `bun test packages/coding-agent/src/duo/__tests__/` — all green. `bun --cwd=packages/coding-agent run check:types` still RED (host method — fixed next task). Do NOT commit.

---

### Task 8: Session — verify-done gate reshape + verified-claim flag + rounds cap (Group C, same owner as Task 7; after Tasks 1/2/3/6)

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts`:
  - import `hasMutationsSince` from `"../duo/takeover-signals"` (:195-201)
  - fields: `#verifyDoneRounds = 0;` next to `#advisorDoneGateRejections` (:1503); `#duoVerifyHandback: { messageCount: number } | undefined;` next to the duo fields (:1519-1523)
  - pure helper `resolveVerifyDoneAction` next to `shouldRunDuoDoneGate` (:1312-1318)
  - `#buildDuoHost` (:2175-2243): add `markDoneClaimVerified`
  - `#evaluateDuoTakeoverSignals` (:2343-2347): extend `doneGateCanRun`
  - `#checkAdvisorDoneGate` (:2901-3018): reshape
  - resets: @7859-7869 (next to `this.#advisorDoneGateRejections = 0;` @7864), @8891-8892, @10380-10381
- Create: `packages/coding-agent/src/duo/__tests__/verify-done-gate.test.ts`

**Interfaces (Produces):**
```ts
export type VerifyDoneGateAction = "takeover" | "cap-accept" | "none";
export function resolveVerifyDoneAction(
	duoStatus: DuoStatus | undefined,
	verifyDone: "always" | "escalate" | "off",
	verifyDoneRounds: number,
): VerifyDoneGateAction;
```

- [ ] **Step 1: Write the failing tests** (new file `src/duo/__tests__/verify-done-gate.test.ts` — pure unit, zero session construction, zero disk):

```ts
import { describe, expect, it } from "bun:test";
import { resolveVerifyDoneAction, shouldRunDuoDoneGate } from "../../session/agent-session";
import type { DuoStatus } from "../controller";

const executing: DuoStatus = { phase: "executing", takeoverCount: 0, advisorPaused: false };
const planning: DuoStatus = { phase: "planning", takeoverCount: 0, advisorPaused: false };

describe("resolveVerifyDoneAction", () => {
	it("fires the active takeover while duo executes with verifyDone=always under the cap", () => {
		expect(resolveVerifyDoneAction(executing, "always", 0)).toBe("takeover");
		expect(resolveVerifyDoneAction(executing, "always", 1)).toBe("takeover");
	});
	it("accepts done with a warning once the 2-round cap is reached", () => {
		expect(resolveVerifyDoneAction(executing, "always", 2)).toBe("cap-accept");
		expect(resolveVerifyDoneAction(executing, "always", 5)).toBe("cap-accept");
	});
	it("stays passive for escalate/off, non-executing phases, and duo-inactive", () => {
		expect(resolveVerifyDoneAction(executing, "escalate", 0)).toBe("none");
		expect(resolveVerifyDoneAction(executing, "off", 0)).toBe("none");
		expect(resolveVerifyDoneAction(planning, "always", 0)).toBe("none");
		expect(resolveVerifyDoneAction(undefined, "always", 0)).toBe("none");
	});
	it("composes with shouldRunDuoDoneGate: duo-inactive advisor gate is unaffected", () => {
		expect(shouldRunDuoDoneGate(true, undefined, "strict")).toBe(true);
		expect(resolveVerifyDoneAction(undefined, "always", 0)).toBe("none");
	});
});
```
(`hasMutationsSince` is covered in Task 1.)

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/verify-done-gate.test.ts`. Expected: FAIL (export missing).

- [ ] **Step 3: Add the pure helper** next to `shouldRunDuoDoneGate` (after :1318):

```ts
export type VerifyDoneGateAction = "takeover" | "cap-accept" | "none";

/** R8: whether the done gate actively fires a verify takeover, accepts at the
 *  round cap, or stays passive. Verify-at-done is by-design recurrent; the cap
 *  (2 rounds per prompt cycle) is the anti-loop bound replacing maxConsecutive. */
export function resolveVerifyDoneAction(
	duoStatus: DuoStatus | undefined,
	verifyDone: "always" | "escalate" | "off",
	verifyDoneRounds: number,
): VerifyDoneGateAction {
	if (duoStatus?.phase !== "executing" || verifyDone !== "always") return "none";
	return verifyDoneRounds >= 2 ? "cap-accept" : "takeover";
}
```

- [ ] **Step 4: Add the session fields** — `#verifyDoneRounds = 0;` with a doc comment next to `#advisorDoneGateRejections` (:1503); `#duoVerifyHandback: { messageCount: number } | undefined;` next to `#duoOwnsPlanMode` (:1523), documented: "Set when a verify takeover handed back: the current done claim was independently reviewed. Consumed once by the next done gate; invalidated by mutations after the handback."

- [ ] **Step 5: `#buildDuoHost`** — after `scheduleAdvisorRevive: () => this.#scheduleAdvisorRevive(),` (:~2242) add:

```ts
			markDoneClaimVerified: () => {
				this.#duoVerifyHandback = { messageCount: this.agent.state.messages.length };
			},
```
(This makes `check:types` green again after Task 6's interface growth.)

- [ ] **Step 6: Reshape `#checkAdvisorDoneGate`** (:2901-3018). Replace the entry guards (:2902-2914) and insert the active branch after the claim checks (:2920-2921); the consult body (:2923-2975), approve (:2980-2982), and reject (:2993-3017) paths stay byte-identical:

```ts
	async #checkAdvisorDoneGate(finalMessage: AssistantMessage): Promise<boolean> {
		if (this.#agentKind !== "main") return false;
		// A user interrupt keeps control: it blocks the active verify gate too.
		if (this.#advisorAutoResumeSuppressed) return false;

		const advisorAvailable = this.#advisorRuntime !== undefined && !this.#advisorRuntime.disposed;
		const duoStatus = this.#duoController?.status;
		const verifyDone = this.settings.get("duo.takeover.verifyDone");
		const action = resolveVerifyDoneAction(duoStatus, verifyDone, this.#verifyDoneRounds);
		const passiveCanRun =
			advisorAvailable &&
			this.#advisorDoneGateRejections < 2 &&
			shouldRunDuoDoneGate(this.settings.get("advisor.doneGate"), duoStatus, this.settings.get("duo.doneGate"));
		if (action === "none" && !passiveCanRun) return false;

		const finalText = finalMessage.content
			.filter((b): b is TextContent => b.type === "text")
			.map(b => b.text)
			.join("\n");
		if (!detectCompletionClaim(finalText)) return false;
		if (!hasMutationsSinceLastUserPrompt(this.agent.state.messages)) return false;

		// R8: a verify takeover already reviewed this done state. Consume once —
		// but only honor it when no mutations landed after the handback (fixes ran
		// → the fresh claim gets gated again, bounded by #verifyDoneRounds).
		const handback = this.#duoVerifyHandback;
		if (handback) {
			this.#duoVerifyHandback = undefined;
			if (!hasMutationsSince(this.agent.state.messages, handback.messageCount)) return false;
		}

		if (action === "cap-accept") {
			this.emitNotice("warning", "Duo verify-done cap reached (2 rounds) — accepting the completion claim.", "duo");
			return false;
		}
		if (action === "takeover") {
			const decision = this.#duoController?.requestTakeover(
				"verify",
				"duo verify-done gate: independent verification before done",
				"re-run the decisive checks",
			);
			if (decision === "accepted") {
				this.#verifyDoneRounds++;
				this.emitNotice("info", "Duo verify-done gate: planner takeover for independent verification.", "duo");
				return true;
			}
			// Machine rejected (phase flipped, duo suspended…): fall back to the
			// passive consult when it can run, else keep the fail-open shape.
			if (!passiveCanRun) {
				this.emitNotice("warning", "Duo verify-done takeover unavailable — proceeding without verdict", "duo");
				return false;
			}
		}

		// … existing passive consult body UNCHANGED from here (:2923 emitNotice onward) …
```
Two surgical edits inside the retained body: (a) the escalate branch (:2983-2990) becomes `if (verifyDone !== "off" && handleDuoEscalateVerifyVerdict(…)) { return true; }` — `"off"` = passive only, an `escalate_verify` verdict degrades to the reject path; (b) nothing else changes. Delivery/continuation mechanics need NO new code: `requestTakeover` (controller.ts:351-377) pauses the advisor, applies/queues the planner switch, and injects the takeover brief as `steer` when not streaming (:363-366) — the queued steer schedules its own continuation (`#queueUserMessage` → `#scheduleAgentContinue`, :8241-8320), exactly like today's `escalate_verify` path. Returning `true` defers the stop (agent_end handler @4202-4206).

- [ ] **Step 7: Extend `doneGateCanRun`** in `#evaluateDuoTakeoverSignals` (:2343-2347) so the turn-end signal and the reshaped gate never double-fire (phase==="executing" is already guaranteed @2335):

```ts
		const doneGateCanRun =
			(this.#advisorRuntime !== undefined && !this.#advisorRuntime.disposed && this.#advisorDoneGateRejections < 2) ||
			(this.settings.get("duo.takeover.verifyDone") === "always" && this.#verifyDoneRounds < 2);
```

- [ ] **Step 8: Resets.** Add `this.#verifyDoneRounds = 0;` and `this.#duoVerifyHandback = undefined;` immediately after `this.#advisorDoneGateRejections = 0;` at ALL THREE sites: `#promptWithMessage` (@7864 — the per-prompt-cycle reset the locked design names), new-transcript reset (@8892), and handoff reset (@10381).

- [ ] **Step 9: Verify** — `bun test packages/coding-agent/src/duo/__tests__/verify-done-gate.test.ts packages/coding-agent/src/duo/__tests__/` (all duo suites) and `bun --cwd=packages/coding-agent run check:types`. Expected: ALL PASS, types green (host method landed in Step 5). Do NOT commit.

---

### Task 9: Union verification + QA handoff (Group D)

- [ ] **Step 1: Type gate** — `bun --cwd=packages/coding-agent run check:types`. Expected: green.
- [ ] **Step 2: Focused union suites** —
```
bun test packages/coding-agent/src/duo/__tests__/takeover-signals.test.ts \
  packages/coding-agent/src/duo/__tests__/state.test.ts \
  packages/coding-agent/src/duo/__tests__/controller.test.ts \
  packages/coding-agent/src/duo/__tests__/session-wiring.test.ts \
  packages/coding-agent/src/duo/__tests__/duo-prompts.test.ts \
  packages/coding-agent/src/duo/__tests__/verify-done-gate.test.ts \
  packages/coding-agent/src/duo/__tests__/advisor-retry.test.ts
```
Expected: all pass.
- [ ] **Step 3 (optional, disk permitting):** `bun test packages/coding-agent/test/agent-session-done-gate.test.ts` — the real-session passive-gate suite. It runs duo-INACTIVE (duoStatus undefined → `resolveVerifyDoneAction` = "none" → passive path byte-identical), so it MUST stay green unmodified. It uses TempDir; skip if the ~99% disk quota blocks it and note the skip.
- [ ] **Step 4: NEVER run the package-wide test suite** — foreign WIP (irc, interactive-mode, gallery fixtures) is red independently of this work.
- [ ] **Step 5: QA handoff notes** (for the orchestrator's qa agent): behaviors to exercise in a live duo session — (1) send a plan-shaped message while duo executes → notice `Duo: planning takeover — … (use /duo exec to skip)`, Fable on the stream same turn, planning phase, full-plan brief visible; ack/question/typo messages → no takeover; (2) let the executor claim done after edits with `duo.takeover.verifyDone: always` and the advisor KILLED → verify takeover fires (no fail-open warning), Fable re-runs checks, `duo_handoff` with evidence → next done claim stops cleanly; handback demanding fixes → executor fixes → gate fires once more → after 2 rounds warning `Duo verify-done cap reached`; (3) `verifyDone: escalate` reproduces today's advisor-consult behavior; `off` never takes over.

---

## Parallel Execution Grouping

| Group | Tasks | Owner boundary | Depends on |
|---|---|---|---|
| **A (parallel ×4)** | 1 (takeover-signals.ts + its test), 2 (settings-schema.ts + model-resolver.ts + BOTH duoConfig fixtures), 3 (state.ts + state.test.ts), 4 (3 prompt .md + NEW duo-prompts.test.ts) | Fully disjoint files | — |
| **B (single owner)** | 5 then 6 | controller.ts + controller.test.ts (+ one stub in session-wiring.test.ts fakeHost) | 2 (fixture fields); coordinate with A2 on controller.test.ts (A2 edits :76-92 only, B appends describes) |
| **C (single owner)** | 7 then 8 | agent-session.ts + NEW verify-done-gate.test.ts | 1, 2, 3, 5, 6 |
| **D** | 9 | none (runs commands) | A+B+C |

## Edge Cases (encode in reviews; most are covered by the tasks' tests)

1. **Streaming prompts (steer/followUp @8220/@8232)** never reach the R7 hook — explicit v1 non-goal; the `!this.isStreaming` guard @7689 enforces it.
2. **Slash/synthetic/agent-attributed prompts:** synthetic excluded by the call-site guard; expanded slash output can reach the detector but bare `/cmd` returns `needed:false`; template-expanded text is evaluated post-expansion (correct — that IS what the turn will do).
3. **User already on Fable while executing** (summon intent): `requestPlanTakeover` current-model guard no-ops, mirroring `notifyAutoSignals` (:383-384).
4. **Switch failure at plan takeover:** `#applySwitchNow` catch suspends duo + warning notice (:586-608); `requestPlanTakeover` returns false; the user prompt still proceeds on the old model.
5. **Verify takeover rejected by the machine** (duo suspended mid-gate, phase flip): gate falls back to the passive consult when possible, else emits the fail-open warning — never hangs the stop.
6. **Advisor dead + `verifyDone: always`:** gate fires the takeover anyway — THE fail-open fix; the residual fail-open only remains when the machine ALSO rejects.
7. **Done claim in a pure Q&A turn:** `hasMutationsSinceLastUserPrompt` still gates entry — unchanged.
8. **Fixes after a verify handback:** `hasMutationsSince(handback.messageCount)` invalidates the verified flag (Reality-Check flag 1) — the fresh claim is gated again; round cap bounds the loop at 2.
9. **Duo inactive / non-duo advisor gate:** `duoStatus` undefined → action "none" → passive path byte-identical (locked by `verify-done-gate.test.ts` composition test + optional Step 3 suite).
10. **maxConsecutive reached via recover history:** verify is exempt (Task 3) — the verify-done gate cannot be starved by prior recovers.

## Verification (definition of done for the whole plan)

1. `bun --cwd=packages/coding-agent run check:types` green.
2. All 7 focused duo suites green (Task 9 Step 2 command).
3. `git status` shows changes ONLY in: `src/duo/takeover-signals.ts`, `src/duo/state.ts`, `src/duo/controller.ts`, `src/duo/prompts/{takeover-brief,takeover-overlay,manual-plan-brief}.md`, `src/config/settings-schema.ts`, `src/config/model-resolver.ts`, `src/session/agent-session.ts`, `src/duo/__tests__/{takeover-signals,state,controller,session-wiring}.test.ts`, plus new `src/duo/__tests__/{duo-prompts,verify-done-gate}.test.ts`. NOTHING under `src/irc/`, `src/tools/irc.ts`, `src/modes/`, `src/cli/gallery-fixtures/`, `src/prompts/agents/`.
4. No commit made.

## Critical Files (read before implementing)

- `packages/coding-agent/src/duo/controller.ts` — `#enterManualPlanning` :310-334, `requestTakeover` :351-377, `notifyAutoSignals` :379-419, `handoffToExecutor` :462-513, `#applySwitch`/`#applySwitchNow` :575-608, host :24-48.
- `packages/coding-agent/src/duo/state.ts` — `onReplanRequested` :110-116, `onTakeoverRequested` :136-152, `onHandoffToExecutor` :94-107, `onExecutorTurnEnd` :154-164.
- `packages/coding-agent/src/duo/takeover-signals.ts` — `detectCompletionClaim` :33-35, `hasMutationsSinceLastUserPrompt` :57-66, `lastUserPromptIndex` :69-76.
- `packages/coding-agent/src/session/agent-session.ts` — helpers :1312-1341, `#buildDuoHost` :2175-2243, `#evaluateDuoTakeoverSignals` :2333-2349, `#checkAdvisorDoneGate` :2901-3018, agent_end gates :3976-4206, `prompt()` :7657-7770, `#promptWithMessage` resets :7859-7869, `sendCustomMessage` :8462-8543.
- `packages/coding-agent/src/duo/__tests__/controller.test.ts` :1-153 (FakeHost + fixtures) and `session-wiring.test.ts` :1-144.
- Prior plan for house conventions: `docs/superpowers/plans/2026-07-03-duo-switch-takeover-redesign.md`.
