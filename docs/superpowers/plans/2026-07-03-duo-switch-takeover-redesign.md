# Duo Switch + Takeover Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the duo (Fable planner / Opus executor) switch + takeover mechanics so a manual switch to Fable during executing means "write a COMPLETE locked plan" (not a transient summon), plan→execute hands off reliably, takeover fires from automatic per-turn signals (not only model judgment), a degraded advisor recovers and un-blocks takeover, and the executor never plans.

**Architecture:** All behavior policy stays in `DuoController` (packages/coding-agent/src/duo/controller.ts) driven by the pure `DuoStateMachine` (src/duo/state.ts); a NEW pure leaf module `src/duo/takeover-signals.ts` holds per-turn signal detectors (no session imports — the done-claim helpers RELOCATE there from agent-session.ts to avoid an import cycle); `AgentSession` only wires host capabilities (plan-artifact stat, advisor revive scheduling, per-turn signal evaluation). Prompts stay in `.md` under `src/duo/prompts/`.

**Tech Stack:** Bun + TypeScript (ES `#private`, no `any`, top-level imports), `bun:test` with `spyOn` only (NEVER `mock.module`), arktype tool schemas, mustache prompts via `@oh-my-pi/pi-utils` `prompt.render`.

## Global Constraints

- Repo root: `~/.herdr/worktrees/omppp/orchestrator`; all paths below are relative to it. Branch `orchestrator`; duo epic shipped v1.5.0.
- **DO NOT COMMIT.** The orchestrator integrates; end every task after its focused tests pass. (This overrides the usual writing-plans commit steps.)
- **Foreign WIP — DO NOT TOUCH:** `packages/coding-agent/src/modes/interactive-mode.ts`, anything under `src/irc/`, IRC 'revived' work, agent prompt files outside `src/duo/prompts/`. Also DO NOT touch `src/orchestrator-mode/state.ts` (whitelist needs NO change — verified), `src/duo/takeover-tool.ts`, `src/duo/escalate-tool.ts`, `src/duo/handoff-tool.ts`.
- Rules: ES `#private` fields, no `any` (use `unknown` + narrow casts like the existing `(m as { isError?: boolean })` idiom), top-level imports only, prompts in `.md`, no `console.log`, Bun APIs preferred, `spyOn` not `mock.module`.
- Per-task verification = focused `bun test` file runs (Bun transpiles without typechecking, so controller tasks stay runnable before session wiring lands). The package-wide type gate `bun --cwd=packages/coding-agent run check:types` is only expected green after Task 9 (the `DuoControllerHost` interface grows in Task 5; `#buildDuoHost` catches up in Task 9).
- All line numbers below were verified against the current tree on 2026-07-03; prefer the named symbol if a line drifted.

## Requirement → Task Map

| Requirement | Tasks |
|---|---|
| R2/R5 manual Fable = full-plan intent (PRIMARY) | 1, 4, 5, 10 |
| R1 reliable plan→execute | 5 (dwell suppression), 6 (artifact nudge + pendingSwitch), 9 (artifact stat) |
| R3 automatic takeover signals | 1, 2, 3, 8, 9 |
| R4 advisor proactive + alive, degraded un-block | 2, 4, 7 |
| R6 Opus-never-plans guardrail | 3, 4, 8 |
| Settings & tests | 1 (settings), every task carries its TDD tests |
| Whitelist | 11 (assert NO change) |

## Reality-Check Flags (locked design vs. code — read before implementing)

1. **R4 claim "today degraded permanently blocks takeover" is only PARTLY true.** `DuoStateMachine.evaluateActivation` (state.ts:58-64) already flips `degraded → executing` when `canActivate`, and the runtime drop path (agent-session.ts:2818-2822 `notifyFailure` → `notifyAdvisorDropped` + `#scheduleAdvisorRevive`; `#attemptAdvisorRevive` at 2343-2361 calls `reevaluate()`) already re-promotes. The REAL holes: (a) the four **controller-side** `ensureAdvisorStarted` failure sites (controller.ts:121-129, 162-171, 181-189, 379-386) call `machine.onAdvisorDropped()` but never schedule a revive → permanently degraded in those cases; (b) `evaluateActivation`'s degraded branch drops to `inactive` when `canActivate` is false (rare: requires `duo.mode: auto` with orchestrator off and a non-Fable main model). Task 7 closes (a) with a `scheduleAdvisorRevive()` host hook and locks the recover→unblock behavior with tests; (b) is accepted (documented edge case, orchestrator is force-enabled during duo executing).
2. **Setting name normalization (deliberate deviation):** the locked design lists `duo.takeover.sentimentEnabled` next to `duo.takeover.signals.enabled`. This plan uses `duo.takeover.signals.sentiment` so all signal settings share one namespace. One-line rename if the literal key is required.
3. **`duo.takeover.enabled` is vestigial** (settings-schema.ts:581-590; grep shows it is never read). Left UNCHANGED — the new automation is gated by `duo.takeover.signals.enabled` only. Do not "fix" it in this plan.
4. **Orchestrator mode has no `write` tool** (ORCHESTRATOR_MODE_SAFE_TOOL_NAMES, orchestrator-mode/state.ts:7-22), so in overlay-only planning Fable locks `local://PLAN.md` by **delegating the write to a subagent** (`task` is whitelisted). The manual-plan brief says this explicitly, and R1 artifact detection is file-stat based (works no matter who wrote the file).

## File Structure

- **Create** `packages/coding-agent/src/duo/takeover-signals.ts` — pure per-turn signal detectors + relocated done-claim helpers (leaf: imports only `@oh-my-pi/pi-agent-core` types).
- **Create** `packages/coding-agent/src/duo/prompts/manual-plan-brief.md` — R2 full-plan brief (mustache vars `planArtifact`, `executor`).
- **Create** `packages/coding-agent/src/duo/__tests__/takeover-signals.test.ts`.
- **Modify** `packages/coding-agent/src/config/settings-schema.ts` (insert after `duo.takeover.maxConsecutive`, :601-611, before `shellPath` :612).
- **Modify** `packages/coding-agent/src/config/model-resolver.ts` (`DuoResolvedConfig` :1307-1317; `resolveDuoConfig` return :1391-1404).
- **Modify** `packages/coding-agent/src/duo/state.ts` (`onTakeoverRequested` :131-147).
- **Modify** `packages/coding-agent/src/duo/controller.ts` (host interface :21-41; `reevaluate` :106-175; `notifyPlanApproved` :177-195; `notifyTurnEnd` :211-224; `notifyManualModelChange` :235-284; `requestTakeover` :301-321; `handoffToExecutor` :345-393; `deactivate` :400-414; `#trackPlannerDwell` :484-501).
- **Modify** `packages/coding-agent/src/duo/prompts/executor-overlay.md`, `advisor-instructions.md`.
- **Modify** `packages/coding-agent/src/session/agent-session.ts` (helpers :1304-1339 & :1397-1432 move OUT; onTurnEnd wiring :2076-2094; `#buildDuoHost` :2239-2300; `#syncDuoPromptOverlay` :2305-2313; `duoReplan` :15770-15772).
- **Modify** `packages/coding-agent/src/slash-commands/builtin-registry.ts` (duo command :844-1005).
- **Modify tests** `src/duo/__tests__/state.test.ts`, `controller.test.ts`, `session-wiring.test.ts`, `test/agent-session-done-gate.test.ts` (import path only).

---

### Task 1: New duo settings + `DuoResolvedConfig` extension

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts:601-612` (insert after the `duo.takeover.maxConsecutive` entry, before `shellPath`)
- Modify: `packages/coding-agent/src/config/model-resolver.ts:1307-1317` (`DuoResolvedConfig`) and `:1391-1404` (`resolveDuoConfig` return)
- Modify: `packages/coding-agent/src/duo/__tests__/controller.test.ts:73-86` (`duoConfig()` fixture — keep compiling)

**Interfaces (Produces — later tasks rely on these exact names):**
```ts
export interface DuoTakeoverSignalSettings {
	enabled: boolean;
	sentiment: boolean;
	failureThreshold: number;
	loopThreshold: number;
}
// DuoResolvedConfig gains:
//   manualSwitchIntent: "plan" | "summon";
//   signals: DuoTakeoverSignalSettings;
```

- [ ] **Step 1: Add the five schema entries** after `duo.takeover.maxConsecutive` (settings-schema.ts:611), matching the existing `duo.*` style exactly:

```ts
	"duo.manualSwitchIntent": {
		type: "enum",
		values: ["plan", "summon"] as const,
		default: "plan",
		ui: {
			tab: "model",
			group: "Duo",
			label: "Duo Manual Switch Intent",
			description:
				"What a manual switch to the planner model during duo executing means. plan = enter the duo planning phase to write a complete locked plan (duo_handoff hands it to the executor); summon = transient advisory summon that returns to the executor quickly.",
		},
	},
	"duo.takeover.signals.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Duo",
			label: "Duo Takeover Signals",
			description:
				"Automatically request planner takeover from per-turn executor signals: tool-failure streaks, loops, and unverified done claims.",
		},
	},
	"duo.takeover.signals.sentiment": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Duo",
			label: "Duo Sentiment Signal",
			description:
				"Include negative user sentiment (scolding) in automatic takeover signals; combined with a failure streak or loop it bypasses the recover cooldown.",
		},
	},
	"duo.takeover.signals.failureThreshold": {
		type: "number",
		default: 3,
		ui: {
			tab: "model",
			group: "Duo",
			label: "Duo Failure Signal Threshold",
			description: "Consecutive failed tool results that trigger an automatic recover takeover request.",
		},
	},
	"duo.takeover.signals.loopThreshold": {
		type: "number",
		default: 3,
		ui: {
			tab: "model",
			group: "Duo",
			label: "Duo Loop Signal Threshold",
			description: "Identical tool calls (same name and arguments) since the last user prompt that count as a loop.",
		},
	},
```

- [ ] **Step 2: Extend `DuoResolvedConfig`** (model-resolver.ts:1307-1317). Add the exported `DuoTakeoverSignalSettings` interface directly above it, and the two fields:

```ts
export interface DuoTakeoverSignalSettings {
	enabled: boolean;
	sentiment: boolean;
	failureThreshold: number;
	loopThreshold: number;
}

export interface DuoResolvedConfig {
	mode: DuoMode;
	planner: Model;
	plannerThinking: ConfiguredThinkingLevel;
	executor: Model;
	executorThinking: ConfiguredThinkingLevel;
	cooldownTurns: number;
	maxConsecutive: number;
	doneGate: "strict" | "inherit";
	manualSwitchIntent: "plan" | "summon";
	signals: DuoTakeoverSignalSettings;
}
```

- [ ] **Step 3: Populate them in `resolveDuoConfig`** (return object at model-resolver.ts:1391-1404), after `doneGate`:

```ts
		manualSwitchIntent: settings.get("duo.manualSwitchIntent"),
		signals: {
			enabled: settings.get("duo.takeover.signals.enabled"),
			sentiment: settings.get("duo.takeover.signals.sentiment"),
			failureThreshold: settings.get("duo.takeover.signals.failureThreshold"),
			loopThreshold: settings.get("duo.takeover.signals.loopThreshold"),
		},
```

- [ ] **Step 4: Update the `duoConfig()` fixture** (controller.test.ts:73-86) so the suite keeps compiling:

```ts
function duoConfig(overrides: Partial<DuoResolvedConfig> = {}): DuoResolvedConfig {
	return {
		mode: "auto",
		planner,
		plannerThinking: AUTO_THINKING,
		executor,
		executorThinking: ThinkingLevel.Max,
		cooldownTurns: 2,
		maxConsecutive: 2,
		doneGate: "strict",
		manualSwitchIntent: "plan",
		signals: { enabled: true, sentiment: true, failureThreshold: 3, loopThreshold: 3 },
		...overrides,
	};
}
```

- [ ] **Step 5: Verify**

Run: `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`
Expected: PASS (behavior unchanged; fixture compiles). Do NOT commit.

---

### Task 2: State machine — cooldown bypass + degraded-recovery lock-in

**Files:**
- Modify: `packages/coding-agent/src/duo/state.ts:131-147` (`onTakeoverRequested`)
- Test: `packages/coding-agent/src/duo/__tests__/state.test.ts` (fixture `config = { cooldownTurns: 3, maxConsecutive: 2 }` at :5)

**Interfaces (Produces):**
```ts
export interface TakeoverRequestOptions {
	/** Strong automatic signal: skip the recover cooldown gate. Max consecutive still applies. */
	bypassCooldown?: boolean;
}
onTakeoverRequested(purpose: TakeoverPurpose, options?: TakeoverRequestOptions): TakeoverDecision;
```

- [ ] **Step 1: Write the failing tests** (append to state.test.ts):

```ts
describe("DuoStateMachine takeover signals", () => {
	it("bypassCooldown accepts recover during cooldown but still respects maxConsecutive", () => {
		const machine = new DuoStateMachine(config); // cooldownTurns 3, maxConsecutive 2
		machine.evaluateActivation(input({ mode: "on" }));
		expect(machine.onTakeoverRequested("recover")).toBe("accepted");
		expect(machine.onHandoffToExecutor()).toBe(true); // cooldown = 3
		expect(machine.onTakeoverRequested("recover")).toBe("cooldown-advice");
		expect(machine.onTakeoverRequested("recover", { bypassCooldown: true })).toBe("accepted");
		expect(machine.onHandoffToExecutor()).toBe(true);
		// consecutiveTakeovers is now 2 === maxConsecutive: even a strong signal is capped.
		expect(machine.onTakeoverRequested("recover", { bypassCooldown: true })).toBe("rejected");
	});

	it("degraded recovers to executing on reevaluation and unblocks takeover", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onAdvisorDropped();
		expect(machine.phase).toBe("degraded");
		expect(machine.onTakeoverRequested("recover")).toBe("rejected"); // blocked while degraded
		expect(machine.evaluateActivation(input({ mode: "on" }))).toBe("executing");
		expect(machine.onTakeoverRequested("recover")).toBe("accepted"); // R4: unblocked after recovery
	});
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/state.test.ts`. Expected: FAIL (options parameter does not exist → TS/behavior mismatch on the bypass case; the degraded test already passes — it LOCKS existing behavior for R4, keep it).

- [ ] **Step 3: Implement** — replace state.ts:131-147:

```ts
export interface TakeoverRequestOptions {
	/** Strong automatic signal: skip the recover cooldown gate. Max consecutive still applies. */
	bypassCooldown?: boolean;
}

	onTakeoverRequested(purpose: TakeoverPurpose, options?: TakeoverRequestOptions): TakeoverDecision {
		if (this.#state.consecutiveTakeovers >= this.#config.maxConsecutive) {
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
		this.#state.consecutiveTakeovers += 1;
		return purpose === "recover" || purpose === "verify" ? "accepted" : "accepted";
	}
```

(Keep the body identical to today except the `!options?.bypassCooldown` condition; the final line stays simply `return "accepted";` — shown expanded only to be explicit that nothing else changes.) Export `TakeoverRequestOptions` from `src/duo/index.ts` via the existing `export * from "./state"`.

- [ ] **Step 4: Verify** — `bun test packages/coding-agent/src/duo/__tests__/state.test.ts`. Expected: PASS. Do NOT commit.

---

### Task 3: `takeover-signals.ts` — pure detectors + done-claim helper relocation

**Files:**
- Create: `packages/coding-agent/src/duo/takeover-signals.ts`
- Modify: `packages/coding-agent/src/session/agent-session.ts` — DELETE `DONE_CLAIM_PATTERNS` + `detectCompletionClaim` (:1304-1339) and `DONE_GATE_MUTATION_TOOLS` + `hasMutationsSinceLastUserPrompt` (:1397-1432); add `import { detectCompletionClaim, hasMutationsSinceLastUserPrompt } from "../duo/takeover-signals";` to the top-level imports. Clean cutover: NO re-export shim from agent-session.
- Modify: `packages/coding-agent/test/agent-session-done-gate.test.ts:10-13` — import `detectCompletionClaim`/`hasMutationsSinceLastUserPrompt` from `"@oh-my-pi/pi-coding-agent/duo/takeover-signals"` (the `./*` export map covers it); `AgentSession` stays imported from the session path.
- Modify: `packages/coding-agent/src/duo/index.ts` — add `export * from "./takeover-signals";`
- Test: `packages/coding-agent/src/duo/__tests__/takeover-signals.test.ts` (new)

**Interfaces (Produces — Tasks 8/9 consume these exact names):**
```ts
export interface TakeoverSignalThresholds { failureThreshold: number; loopThreshold: number; sentimentEnabled: boolean; }
export interface TakeoverSignalReport {
	sentiment: boolean;
	consecutiveFailures: number;
	loop: boolean;
	doneClaimWithoutEvidence: boolean;
	planningShapedWork: boolean;
	strong: boolean;
	evidence: string[];
}
export function detectCompletionClaim(text: string): boolean;
export function hasMutationsSinceLastUserPrompt(messages: readonly AgentMessage[]): boolean;
export function detectNegativeSentiment(messages: readonly AgentMessage[]): boolean;
export function countTrailingToolFailures(messages: readonly AgentMessage[]): number;
export function detectToolLoop(messages: readonly AgentMessage[], threshold: number): boolean;
export function detectDoneClaimWithoutEvidence(messages: readonly AgentMessage[]): boolean;
export function detectPlanningShapedWork(messages: readonly AgentMessage[]): boolean;
export function evaluateTakeoverSignals(messages: readonly AgentMessage[], thresholds: TakeoverSignalThresholds): TakeoverSignalReport;
```

- [ ] **Step 1: Write the failing tests** — create `src/duo/__tests__/takeover-signals.test.ts` with message builders copied from the style of `test/agent-session-done-gate.test.ts:52-60`:

```ts
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	countTrailingToolFailures,
	detectDoneClaimWithoutEvidence,
	detectNegativeSentiment,
	detectPlanningShapedWork,
	detectToolLoop,
	evaluateTakeoverSignals,
} from "../takeover-signals";

const userMsg = (text: string): AgentMessage =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as unknown as AgentMessage;
const devMsg = (text: string): AgentMessage =>
	({ role: "user", attribution: "agent", content: [{ type: "text", text }], timestamp: 1 }) as unknown as AgentMessage;
const assistantMsg = (
	text: string,
	toolCalls: Array<{ name: string; args?: Record<string, unknown> }> = [],
): AgentMessage =>
	({
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCalls.map((c, i) => ({ type: "toolCall", id: `c${i}`, name: c.name, arguments: c.args ?? {} })),
		],
		timestamp: 2,
	}) as unknown as AgentMessage;
const toolResult = (toolName: string, isError = false): AgentMessage =>
	({ role: "toolResult", toolName, isError, content: [], timestamp: 3 }) as unknown as AgentMessage;

describe("detectNegativeSentiment", () => {
	it("matches English and Vietnamese scolding in the LAST genuine user message", () => {
		for (const t of ["wtf, it's still broken", "this still does not work", "you broke it again", "vẫn lỗi mà", "sao vẫn chưa được", "đã bảo là sai rồi"]) {
			expect(detectNegativeSentiment([userMsg(t)])).toBe(true);
		}
	});
	it("ignores earlier scolding once a calm prompt follows, and agent-attributed messages", () => {
		expect(detectNegativeSentiment([userMsg("still broken!"), userMsg("thanks, now add tests")])).toBe(false);
		expect(detectNegativeSentiment([userMsg("add tests"), devMsg("still broken")])).toBe(false);
	});
});

describe("countTrailingToolFailures", () => {
	it("counts the trailing failure run and stops at the last success or user boundary", () => {
		expect(countTrailingToolFailures([userMsg("go"), toolResult("bash", true), toolResult("bash", true), toolResult("edit", true)])).toBe(3);
		expect(countTrailingToolFailures([userMsg("go"), toolResult("bash", true), toolResult("bash"), toolResult("edit", true)])).toBe(1);
		expect(countTrailingToolFailures([toolResult("bash", true), userMsg("go")])).toBe(0);
	});
});

describe("detectToolLoop", () => {
	it("flags N identical tool calls since the last user prompt", () => {
		const call = { name: "bash", args: { command: "bun test x" } };
		const messages = [userMsg("fix"), assistantMsg("try", [call]), assistantMsg("try", [call]), assistantMsg("try", [call])];
		expect(detectToolLoop(messages, 3)).toBe(true);
		expect(detectToolLoop(messages, 4)).toBe(false);
	});
	it("different arguments are not a loop, and a user prompt resets the window", () => {
		expect(detectToolLoop([userMsg("fix"), assistantMsg("a", [{ name: "bash", args: { command: "a" } }]), assistantMsg("b", [{ name: "bash", args: { command: "b" } }])], 2)).toBe(false);
		expect(detectToolLoop([assistantMsg("x", [{ name: "bash", args: {} }]), userMsg("new ask"), assistantMsg("x", [{ name: "bash", args: {} }])], 2)).toBe(false);
	});
});

describe("detectDoneClaimWithoutEvidence", () => {
	it("fires on done-claim + mutation + no verification run", () => {
		expect(detectDoneClaimWithoutEvidence([userMsg("do it"), toolResult("edit"), assistantMsg("Done, everything works.")])).toBe(true);
	});
	it("a successful bash run counts as evidence; Q&A and error-only turns never fire", () => {
		expect(detectDoneClaimWithoutEvidence([userMsg("do it"), toolResult("edit"), toolResult("bash"), assistantMsg("Done.")])).toBe(false);
		expect(detectDoneClaimWithoutEvidence([userMsg("question?"), assistantMsg("Done reading, here's the answer.")])).toBe(false);
	});
});

describe("detectPlanningShapedWork", () => {
	it("flags plan-document writes and plan-structured essays", () => {
		expect(detectPlanningShapedWork([userMsg("go"), assistantMsg("writing", [{ name: "write", args: { path: "docs/plans/2026-x.md" } }])])).toBe(true);
		expect(detectPlanningShapedWork([userMsg("go"), assistantMsg("## Phase 1\ntext\n## Phase 2\ntext\n## Phase 3\ntext")])).toBe(true);
		expect(detectPlanningShapedWork([userMsg("go"), assistantMsg("edit", [{ name: "write", args: { path: "src/foo.ts" } }])])).toBe(false);
	});
});

describe("evaluateTakeoverSignals", () => {
	it("strong = sentiment AND (failure streak OR loop); sentiment toggle gates it", () => {
		const messages = [userMsg("vẫn lỗi, làm lại đi"), toolResult("bash", true), toolResult("bash", true), toolResult("bash", true), assistantMsg("trying")];
		const on = evaluateTakeoverSignals(messages, { failureThreshold: 3, loopThreshold: 3, sentimentEnabled: true });
		expect(on.strong).toBe(true);
		expect(on.consecutiveFailures).toBe(3);
		expect(on.evidence.length).toBeGreaterThan(0);
		const off = evaluateTakeoverSignals(messages, { failureThreshold: 3, loopThreshold: 3, sentimentEnabled: false });
		expect(off.sentiment).toBe(false);
		expect(off.strong).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/takeover-signals.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module** — create `src/duo/takeover-signals.ts`. Move `DONE_CLAIM_PATTERNS` (agent-session.ts:1314-1332, verbatim incl. the doc comment at :1304-1313), `detectCompletionClaim` (:1337-1339), `DONE_GATE_MUTATION_TOOLS` (:1397-1405), `hasMutationsSinceLastUserPrompt` (:1415-1432) here unchanged, then add:

```ts
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/* …moved DONE_CLAIM_PATTERNS / detectCompletionClaim / DONE_GATE_MUTATION_TOOLS / hasMutationsSinceLastUserPrompt… */

/** Index of the last genuine (non-agent-attributed) user prompt; 0 when none. */
function lastUserPromptIndex(messages: readonly AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user" && (m as { attribution?: string }).attribution !== "agent") return i;
	}
	return 0;
}

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") text += b.text + "\n";
	}
	return text;
}

/** Scolding / frustration in the LAST genuine user message (EN + VI). Exported for unit tests. */
export const NEGATIVE_SENTIMENT_PATTERNS: readonly RegExp[] = [
	/\b(?:wtf|wth|ffs)\b/i,
	/\bstill\s+(?:broken|failing|wrong|not\s+work)/i,
	/\b(?:doesn'?t|does\s+not|isn'?t|not)\s+work(?:s|ing)?\b/i,
	/\byou\s+(?:broke|keep|failed|lied|ignored)\b/i,
	/\b(?:useless|wrong\s+again|same\s+bug\s+again)\b/i,
	/vẫn\s+(?:sai|lỗi|hỏng|chưa)/i,
	/(?:đã|toi|tôi)\s+bảo/i,
	/sao\s+vẫn/i,
	/làm\s+lại(?:\s+đi)?/i,
	/không\s+(?:chạy|hoạt\s+động|được)\b/i,
	/(?:quá\s+tệ|tệ\s+quá)/i,
];

export function detectNegativeSentiment(messages: readonly AgentMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user" || (m as { attribution?: string }).attribution === "agent") continue;
		const text = textOf(m);
		return NEGATIVE_SENTIMENT_PATTERNS.some(re => re.test(text));
	}
	return false;
}

/** Trailing run of failed tool results (interleaved assistant messages ignored); resets at a success or the user boundary. */
export function countTrailingToolFailures(messages: readonly AgentMessage[]): number {
	let failures = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user" && (m as { attribution?: string }).attribution !== "agent") break;
		if (m.role !== "toolResult") continue;
		if ((m as { isError?: boolean }).isError) failures += 1;
		else break;
	}
	return failures;
}

/** True when the same tool call (name + arguments) repeats `threshold` times since the last user prompt. */
export function detectToolLoop(messages: readonly AgentMessage[], threshold: number): boolean {
	if (threshold <= 0) return false;
	const start = lastUserPromptIndex(messages);
	const counts = new Map<string, number>();
	for (let i = start; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const content = (m as { content?: readonly unknown[] }).content ?? [];
		for (const block of content) {
			const b = block as { type?: string; name?: string; arguments?: unknown };
			if (b.type !== "toolCall" || !b.name) continue;
			const signature = `${b.name}:${JSON.stringify(b.arguments ?? null)}`;
			const next = (counts.get(signature) ?? 0) + 1;
			if (next >= threshold) return true;
			counts.set(signature, next);
		}
	}
	return false;
}

/** Tool results that count as verification evidence for a completion claim. */
const VERIFICATION_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/** Final assistant text claims done, the window mutated the workspace, and no successful verification ran. */
export function detectDoneClaimWithoutEvidence(messages: readonly AgentMessage[]): boolean {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return false;
	const text = textOf(last);
	if (!text || !detectCompletionClaim(text)) return false;
	if (!hasMutationsSinceLastUserPrompt(messages)) return false;
	const start = lastUserPromptIndex(messages);
	for (let i = start; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "toolResult") continue;
		const tr = m as { isError?: boolean; toolName?: string };
		if (!tr.isError && tr.toolName && VERIFICATION_TOOLS.has(tr.toolName)) return false;
	}
	return true;
}

const PLAN_DOC_PATH_PATTERN = /(?:^|\/)plans?\/|(?:^|[\/._-])plan[^\/]*\.md$/i;
const PLAN_HEADING_PATTERN = /^#{1,3}\s+(?:implementation\s+plan|phase\b|task\s+\d|milestone\b)/gim;

/** Executor doing planner work: plan-document writes or a plan-structured essay (soft R6 signal). */
export function detectPlanningShapedWork(messages: readonly AgentMessage[]): boolean {
	const start = lastUserPromptIndex(messages);
	for (let i = start; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const content = (m as { content?: readonly unknown[] }).content ?? [];
		for (const block of content) {
			const b = block as { type?: string; name?: string; arguments?: Record<string, unknown> };
			if (b.type !== "toolCall") continue;
			if (b.name !== "write" && b.name !== "edit" && b.name !== "ast_edit") continue;
			const raw = b.arguments?.path ?? b.arguments?.file_path;
			if (typeof raw === "string" && PLAN_DOC_PATH_PATTERN.test(raw)) return true;
		}
	}
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return false;
	const matches = textOf(last).match(PLAN_HEADING_PATTERN);
	return (matches?.length ?? 0) >= 3;
}

export interface TakeoverSignalThresholds {
	failureThreshold: number;
	loopThreshold: number;
	sentimentEnabled: boolean;
}

export interface TakeoverSignalReport {
	sentiment: boolean;
	consecutiveFailures: number;
	loop: boolean;
	doneClaimWithoutEvidence: boolean;
	planningShapedWork: boolean;
	/** Scolding combined with a failure streak or loop: bypasses the recover cooldown. */
	strong: boolean;
	evidence: string[];
}

export function evaluateTakeoverSignals(
	messages: readonly AgentMessage[],
	thresholds: TakeoverSignalThresholds,
): TakeoverSignalReport {
	const sentiment = thresholds.sentimentEnabled && detectNegativeSentiment(messages);
	const consecutiveFailures = countTrailingToolFailures(messages);
	const loop = detectToolLoop(messages, thresholds.loopThreshold);
	const doneClaimWithoutEvidence = detectDoneClaimWithoutEvidence(messages);
	const planningShapedWork = detectPlanningShapedWork(messages);
	const failing = consecutiveFailures >= thresholds.failureThreshold;
	const evidence: string[] = [];
	if (sentiment) evidence.push("negative user sentiment in the last prompt");
	if (failing) evidence.push(`${consecutiveFailures} consecutive failed tool results`);
	if (loop) evidence.push(`the same tool call repeated ≥${thresholds.loopThreshold}× with no new approach`);
	if (doneClaimWithoutEvidence) evidence.push("completion claimed after mutations with no verification run");
	if (planningShapedWork) evidence.push("executor produced planning-shaped work");
	return {
		sentiment,
		consecutiveFailures,
		loop,
		doneClaimWithoutEvidence,
		planningShapedWork,
		strong: sentiment && (failing || loop),
		evidence,
	};
}
```

- [ ] **Step 4: Relocate callers.** In agent-session.ts delete the four moved declarations (:1304-1339, :1397-1432 — `shouldRunDuoDoneGate`, `handleDuoEscalateVerifyVerdict`, `shouldNotifyDuoPlanApproved`, `resolveDuoAdvisorStopAction` in between STAY), add the import, and confirm the two internal uses (:2940-2941) resolve. Add `export * from "./takeover-signals";` to `src/duo/index.ts`. Update `test/agent-session-done-gate.test.ts:10-13` imports.

- [ ] **Step 5: Verify** — `bun test packages/coding-agent/src/duo/__tests__/takeover-signals.test.ts packages/coding-agent/test/agent-session-done-gate.test.ts`. Expected: PASS. Do NOT commit.

---

### Task 4: Prompts — manual-plan brief, executor hardening, advisor ladder

**Files:**
- Create: `packages/coding-agent/src/duo/prompts/manual-plan-brief.md`
- Modify: `packages/coding-agent/src/duo/prompts/executor-overlay.md` (the sentence at line 6: "If a new request needs re-planning or architecture decisions rather than execution, say so; the user re-enters plan mode to hand the stream back to the planner.")
- Modify: `packages/coding-agent/src/duo/prompts/advisor-instructions.md` (Escalation ladder :101-113 and Cooldown state :115-120)
- Test: `packages/coding-agent/src/duo/__tests__/session-wiring.test.ts` (follow the existing prompt-import pattern at :183-194)

- [ ] **Step 1: Write the failing prompt tests** (append to session-wiring.test.ts; add top-level imports next to the existing prompt imports):

```ts
import manualPlanBriefPrompt from "../prompts/manual-plan-brief.md" with { type: "text" };
import duoExecutorOverlayRaw from "../prompts/executor-overlay.md" with { type: "text" };
import advisorInstructionsRaw from "../prompts/advisor-instructions.md" with { type: "text" };

test("manual plan brief demands a complete locked plan handed off via duo_handoff", () => {
	const rendered = prompt.render(manualPlanBriefPrompt, {
		planArtifact: "local://PLAN.md",
		executor: "anthropic/claude-opus-4-8",
	});
	expect(rendered).toContain("COMPLETE");
	expect(rendered).toContain("local://PLAN.md");
	expect(rendered).toContain("duo_handoff");
	expect(rendered).not.toContain("{{");
});

test("executor overlay routes planning needs to duo_escalate, never plan-mode round-trips", () => {
	expect(duoExecutorOverlayRaw).toContain("duo_escalate");
	expect(duoExecutorOverlayRaw).not.toContain("re-enters plan mode");
});

test("advisor instructions name the automatic takeover signals and the strong-signal bypass", () => {
	expect(advisorInstructionsRaw).toContain("automatic");
	expect(advisorInstructionsRaw).toContain("bypass");
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/session-wiring.test.ts`. Expected: FAIL (missing file / missing text).

- [ ] **Step 3: Create `manual-plan-brief.md`** (exact content):

```md
The user manually placed you — the Fable model — on the main stream while the executor was running. Treat this as FULL-PLAN INTENT: the user wants a COMPLETE plan, not a quick answer and not a transient consult.

You are now in the duo planning phase. Do not implement anything from here — planning ends through `duo_handoff`, nothing else.

Write the COMPLETE implementation plan now: scope, decisions, file-level changes, sequencing, acceptance checks, and verification. Lock it to `{{planArtifact}}` — in Safe orchestrator mode the write tool is unavailable on the main stream, so delegate the file write to a `task` subagent and verify it landed. Resolve every open question; the executor will not re-plan.

When — and only when — the plan is locked, call `duo_handoff` with the executor brief distilled from the plan. `duo_handoff` IS the plan approval: the executor ({{executor}}) resumes ONLY from your handoff. Do not drift back into execution without handing off.
```

- [ ] **Step 4: Harden `executor-overlay.md`** — replace the line-6 sentence with:

```md
Done claims require proof — fresh test output, command results, or observed behavior. You NEVER plan: if a request needs re-planning or architecture decisions rather than execution, call `duo_escalate` to hand the stream to the planner. Writing plan documents or long design essays yourself is a duo violation — an automatic reminder fires if you start one.
```

- [ ] **Step 5: Update `advisor-instructions.md`.** Append to the Escalation ladder section (after the takeover-dossier bullet at :112-113):

```md
- The harness ALSO watches every executor turn with automatic detectors — consecutive
  tool-failure streaks, repeated identical tool calls (loops), negative user sentiment,
  and completion claims without verification — and may fire `request_takeover` itself.
  Your advisories remain the primary, evidence-rich signal: cite concrete evidence so an
  automatic takeover inherits a usable directive.
```

And append to the Cooldown state section (:115-120):

```md
- A strong automatic signal (user scolding combined with a failure streak or loop) may
  bypass this cooldown; max consecutive takeovers still applies.
```

- [ ] **Step 6: Verify** — `bun test packages/coding-agent/src/duo/__tests__/session-wiring.test.ts` → PASS, then `bun --cwd=packages/coding-agent run format-prompts` (normalizes md). Do NOT commit.

---

### Task 5: Controller R2/R5 — manual-Fable = plan intent, overlay-only planning, `summonPlanner()`

**Files:**
- Modify: `packages/coding-agent/src/duo/controller.ts` — host interface (:21-41), imports (:7-12), fields (:69-80), `reevaluate` reconciliation (:146-150), `notifyPlanModeEntered` (:198-209), `notifyManualModelChange` (:235-284), `handoffToExecutor` (:345-393), `deactivate` (:400-414)
- Test: `packages/coding-agent/src/duo/__tests__/controller.test.ts` (FakeHost :38-71 and :87-168; the existing summon test asserting "Tip: use /duo plan" at :270-278)

**Interfaces:**
- Consumes: `DuoResolvedConfig.manualSwitchIntent` (Task 1), `manual-plan-brief.md` (Task 4).
- Produces (locked for Tasks 6-9): `DuoControllerHost` gains `planArtifactReady(): boolean` and `scheduleAdvisorRevive(): void` (BOTH declared here so the interface changes once; used in Tasks 6/7; implemented session-side in Task 9). Public method `summonPlanner(): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** (append to controller.test.ts; also extend `FakeHost`):

Extend the `FakeHost` interface (:38-58) with `planArtifactReadyFlag: boolean; revives: number;` and the factory (:87-168) with:

```ts
		planArtifactReadyFlag: false,
		revives: 0,
		planArtifactReady() {
			return this.planArtifactReadyFlag;
		},
		scheduleAdvisorRevive() {
			this.revives += 1;
		},
```

New tests:

```ts
	test("manual switch to the planner during executing enters planning with the full-plan brief (default intent)", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate(); // orchestrator on → executing, host.model = executor
		host.model = planner; // the user picked Fable in the model picker
		controller.notifyManualModelChange();
		expect(controller.status.phase).toBe("planning");
		expect(controller.status.executor).toBe("anthropic/claude-opus-4.8"); // slot NOT overwritten
		expect(host.pauses).toBeGreaterThanOrEqual(1); // advisor paused for planning
		expect(host.planModeEnables).not.toContain(true); // overlay-only: orchestrator stays on
		const brief = host.briefs.at(-1);
		expect(brief?.deliverAs).toBe("nextTurn");
		expect(brief?.text).toContain("COMPLETE");
		expect(brief?.text).toContain("duo_handoff");
		expect(host.briefs.some(b => b.text.includes("summons to reason"))).toBe(false);
	});

	test("duo_handoff from manual planning restores the executor and never engaged literal plan mode", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		expect(await controller.handoffToExecutor("plan locked at local://PLAN.md")).toBe("ok");
		expect(controller.status.phase).toBe("executing");
		expect(host.switches.at(-1)?.model).toBe(executor);
		await controller.reevaluate();
		expect(host.planModeEnables).not.toContain(true);
	});

	test("manual planning suppresses the planner dwell nag", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		for (let i = 0; i < 6; i++) await controller.notifyTurnEnd();
		expect(host.notices.some(n => n.text.includes("held the executing stream"))).toBe(false);
	});

	test("manualSwitchIntent summon preserves the executor-slot override and summon brief", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		expect(controller.status.phase).toBe("executing");
		expect(controller.status.executor).toBe("anthropic/claude-fable-5");
		expect(host.briefs.some(b => b.text.includes("summons to reason"))).toBe(true);
	});

	test("summonPlanner puts the planner on the stream transiently and duo_handoff restores the executor", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(await controller.summonPlanner()).toBe(true);
		expect(host.model).toBe(planner);
		expect(controller.status.phase).toBe("executing"); // NOT planning — transient
		expect(host.briefs.some(b => b.text.includes("summons to reason"))).toBe(true);
		expect(await controller.handoffToExecutor("back to work")).toBe("ok");
		expect(host.model).toBe(executor);
	});
```

Also UPDATE the existing manual-summon test (:260-280, the one asserting the "Tip: use /duo plan" notice) to construct its controller with `duoConfig({ manualSwitchIntent: "summon" })` — its behavior is now opt-in.

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`. Expected: FAIL (missing host members / phase stays executing).

- [ ] **Step 3: Implement.**

3a. Import the brief (top-level, next to plannerSummon at controller.ts:10):
```ts
import manualPlanBrief from "./prompts/manual-plan-brief.md" with { type: "text" };
```

3b. Extend `DuoControllerHost` (:21-41):
```ts
	/** True when the duo plan artifact (the session's plan reference file) exists and changed since the planning phase was entered. */
	planArtifactReady(): boolean;
	/** Schedule the advisor revive backoff after a controller-side advisor drop. */
	scheduleAdvisorRevive(): void;
```

3c. New fields next to `#plannerDwellTurns` (:80):
```ts
	#planningOverlayOnly = false;
	#planNudgeTurns = 0;
```

3d. Rewrite the executing branch of `notifyManualModelChange` (:249-268). Replace:
```ts
		if (this.#isExecutingLike()) {
			if (modelsAreEqual(model, this.#config.executor)) {
				return;
			}
			const switchedToPlannerSlot = modelsAreEqual(model, this.#config.planner);
			if (switchedToPlannerSlot && this.#config.manualSwitchIntent === "plan" && this.#enterManualPlanning()) {
				return;
			}
			this.#config = {
				...this.#config,
				executor: model,
				executorThinking: configuredThinking ?? this.#config.executorThinking,
			};
			this.#host.emitNotice(
				"info",
				`Duo executor set to ${this.#formatModel(model)} (manual switch).${switchedToPlannerSlot ? " Tip: use /duo plan to put the planner on the main stream for planning." : ""}`,
			);
			if (switchedToPlannerSlot) {
				this.#host.injectBrief(prompt.render(plannerSummon), "nextTurn");
				const thinking = parseConfiguredThinkingLevel(this.#config.plannerThinking);
				if (thinking !== undefined) this.#host.setThinkingLevel(thinking);
			}
		} else {
```
(The `else` planner-slot branch and the trailing `#syncAdvisorSelfPause/#refreshSnapshotMetadata/#persistSnapshot` at :281-283 stay untouched.)

3e. Add the private routing method (after `notifyManualModelChange`):
```ts
	/** Manual switch to the planner model during executing with `duo.manualSwitchIntent: "plan"`:
	 *  full-plan intent. Enter the planning phase — overlay-only when orchestrator mode is on,
	 *  so it composes with the Safe orchestrator toolset — keep the executor slot untouched,
	 *  and require duo_handoff (the plan approval) to resume the executor. */
	#enterManualPlanning(): boolean {
		if (!this.#machine.onReplanRequested()) return false; // degraded phase falls back to the summon path
		this.#refreshSnapshotMetadata();
		this.#host.pauseAdvisor();
		this.#advisorPaused = true;
		this.#plannerDwellTurns = 0;
		this.#planNudgeTurns = 0;
		this.#planningOverlayOnly = this.#host.orchestratorEnabled();
		if (!this.#planningOverlayOnly) this.#host.setPlanModeEnabled(true);
		const thinking = parseConfiguredThinkingLevel(this.#config.plannerThinking);
		if (thinking !== undefined) this.#host.setThinkingLevel(thinking);
		this.#host.injectBrief(
			prompt.render(manualPlanBrief, {
				planArtifact: "local://PLAN.md",
				executor: this.#formatModel(this.#config.executor),
			}),
			"nextTurn",
		);
		this.#host.emitNotice(
			"info",
			"Duo planning: manual switch to the planner. Write and lock the complete plan, then call duo_handoff — the executor resumes only from your handoff.",
		);
		this.#persistSnapshot();
		return true;
	}
```

3f. Overlay-only reconciliation — in `reevaluate` replace :146-150 with:
```ts
		if (this.#machine.phase === "planning") {
			if (!this.#planningOverlayOnly) this.#host.setPlanModeEnabled(true);
		} else if (this.#isExecutingLike()) {
			this.#host.setPlanModeEnabled(false);
			this.#planningOverlayOnly = false;
		}
```
Clear the flag on every planning exit/entry that owns literal plan mode: add `this.#planningOverlayOnly = false;` in `notifyPlanModeEntered` (after :204 `this.#plannerDwellTurns = 0;`), in `handoffToExecutor`'s non-executing path (next to `this.#plannerDwellTurns = 0;` at :389), and in `deactivate` (next to :407 `this.#plannerDwellTurns = 0;`).

3g. Extract the transient summon as a public method (for `/duo summon`, Task 10):
```ts
	/** Transient advisory summon (/duo summon): planner takes the stream inside the executing
	 *  phase with the settle-and-handback brief. The dwell nag stays armed on purpose. */
	async summonPlanner(): Promise<boolean> {
		if (!this.#isExecutingLike()) return false;
		this.#config = { ...this.#config, executor: this.#config.planner, executorThinking: this.#config.plannerThinking };
		if (!(await this.#applySwitch(this.#config.planner, this.#config.plannerThinking))) return false;
		this.#host.injectBrief(prompt.render(plannerSummon), "nextTurn");
		this.#host.emitNotice(
			"info",
			`Duo planner summoned to the main stream; duo_handoff restores ${this.#formatModel(this.#resolvedExecutor)}.`,
		);
		this.#syncAdvisorSelfPause();
		this.#refreshSnapshotMetadata();
		this.#persistSnapshot();
		return true;
	}
```
(Note: `#resolvedPlanner` currently carries a biome `noUnusedPrivateClassMembers` ignore comment at :74-75 — leave it; `handoffToExecutor` already restores `#resolvedExecutor` so the summon round-trips.)

- [ ] **Step 4: Verify** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`. Expected: PASS (including all pre-existing tests). Do NOT commit.

---

### Task 6: Controller R1 — plan-artifact-gated handoff nudge + pendingSwitch regression

**Files:**
- Modify: `packages/coding-agent/src/duo/controller.ts` — `notifyTurnEnd` (:211-224), new `#trackPlanningProgress()` next to `#trackPlannerDwell` (:484-501)
- Test: `packages/coding-agent/src/duo/__tests__/controller.test.ts`

**Interfaces:** Consumes `host.planArtifactReady()` (declared Task 5; FakeHost flag `planArtifactReadyFlag`).

- [ ] **Step 1: Write the failing tests:**

```ts
	test("planning nudges duo_handoff only once the plan artifact exists, escalating when ignored", async () => {
		const host = fakeHost({ model: planner, planModeOn: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate(); // planning
		await controller.notifyTurnEnd();
		await controller.notifyTurnEnd();
		expect(host.briefs.filter(b => b.text.includes("plan is locked"))).toHaveLength(0); // suppressed pre-artifact
		host.planArtifactReadyFlag = true;
		await controller.notifyTurnEnd(); // first nudge: brief only
		expect(host.briefs.at(-1)?.text).toContain("call duo_handoff NOW");
		const noticesBefore = host.notices.length;
		await controller.notifyTurnEnd(); // second nudge: warning notice + brief
		expect(host.notices.length).toBeGreaterThan(noticesBefore);
		expect(host.notices.at(-1)?.level).toBe("warning");
		expect(host.notices.at(-1)?.text).toContain("duo_handoff");
	});

	test("handoff during streaming queues the Fable→Opus switch and notifyTurnEnd applies it (no stall)", async () => {
		const host = fakeHost({ model: planner, planModeOn: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate(); // planning, planner on stream
		host.streaming = true;
		expect(await controller.handoffToExecutor("plan locked")).toBe("ok");
		expect(host.model).toBe(planner); // queued while streaming
		host.streaming = false;
		await controller.notifyTurnEnd();
		expect(host.model).toBe(executor); // pending switch applied at the turn boundary
		expect(controller.status.phase).toBe("executing");
	});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`. Expected: first test FAILS (no nudge exists); second may already PASS (it locks the existing flush path against regressions — keep it).

- [ ] **Step 3: Implement.** In `notifyTurnEnd` add `this.#trackPlanningProgress();` immediately after `this.#trackPlannerDwell();` (:223). Add:

```ts
	/** R1: while deliberately planning there is NO dwell-out nag. Once the plan artifact
	 *  exists, push a forceful plan-completion nudge every turn, escalating after the first. */
	#trackPlanningProgress(): void {
		if (this.#machine.phase !== "planning") {
			this.#planNudgeTurns = 0;
			return;
		}
		if (!this.#host.planArtifactReady()) {
			return; // suppressed until a plan artifact exists
		}
		this.#planNudgeTurns += 1;
		const brief = `The plan is locked (plan artifact detected). Call duo_handoff NOW with the executor brief distilled from the plan — the executor resumes ONLY from your handoff. Do not keep planning, and do not start implementing.`;
		this.#host.injectBrief(brief, "nextTurn");
		if (this.#planNudgeTurns >= 2) {
			this.#host.emitNotice(
				"warning",
				`Duo planning: the plan artifact has been locked for ${this.#planNudgeTurns} turns without a handoff — duo_handoff is required to resume the executor.`,
			);
		}
	}
```

- [ ] **Step 4: Verify** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`. Expected: PASS. Do NOT commit.

---

### Task 7: Controller R4 — schedule advisor revival at every controller-side drop

**Files:**
- Modify: `packages/coding-agent/src/duo/controller.ts` — the four `ensureAdvisorStarted` failure blocks: `reevaluate` activation (:121-129), `reevaluate` reconciliation (:162-171), `notifyPlanApproved` (:181-189), `handoffToExecutor` (:379-386)
- Test: `packages/coding-agent/src/duo/__tests__/controller.test.ts`

**Interfaces:** Consumes `host.scheduleAdvisorRevive()` (declared Task 5; FakeHost counter `revives`).

- [ ] **Step 1: Write the failing test:**

```ts
	test("controller-side advisor start failure schedules a revive; recovery unblocks takeover", async () => {
		const host = fakeHost({ model: executor });
		let advisorUp = false;
		host.ensureAdvisorStarted = (pinned: Model) => {
			host.ensured.push(pinned);
			return advisorUp;
		};
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate(); // activation executing → advisor start fails → degraded
		expect(controller.status.phase).toBe("degraded");
		expect(host.revives).toBeGreaterThanOrEqual(1); // the drop scheduled a revive (today: never)
		expect(controller.requestTakeover("recover", "stuck", "unstick")).toBe("rejected"); // degraded blocks
		advisorUp = true;
		await controller.reevaluate(); // the revive path calls reevaluate
		expect(controller.status.phase).toBe("executing"); // degraded → executing
		expect(controller.requestTakeover("recover", "stuck", "unstick")).toBe("accepted"); // UN-blocked
	});
```

- [ ] **Step 2: Run to verify failure** — expected FAIL on `host.revives` (0 today; the recovery assertions already hold — they lock the behavior).

- [ ] **Step 3: Implement** — in EACH of the four failure blocks, after the `emitNotice("warning", "Duo advisor could not be started…")` / `…dropped…` call, add one line:

```ts
						this.#host.scheduleAdvisorRevive();
```

(Exactly four insertions; no other logic changes. `notifyAdvisorDropped` (:286-299) does NOT need it — its caller agent-session.ts:2818-2822 already schedules the revive.)

- [ ] **Step 4: Verify** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`. Expected: PASS. Do NOT commit.

---

### Task 8: Controller R3+R6 — automatic signal policy

**Files:**
- Modify: `packages/coding-agent/src/duo/controller.ts` — `requestTakeover` (:301-321), new `notifyAutoSignals` + `#nudgeExecutorOffPlanning`, imports
- Test: `packages/coding-agent/src/duo/__tests__/controller.test.ts`

**Interfaces:**
- Consumes: `TakeoverSignalReport` (Task 3), `TakeoverRequestOptions` (Task 2), `config.signals` (Task 1).
- Produces (Task 9 consumes): `notifyAutoSignals(report: TakeoverSignalReport): void`; `requestTakeover(purpose, reason, directive, options?: TakeoverRequestOptions)`.

- [ ] **Step 1: Write the failing tests:**

```ts
import type { TakeoverSignalReport } from "../takeover-signals";

function signalReport(overrides: Partial<TakeoverSignalReport> = {}): TakeoverSignalReport {
	return {
		sentiment: false,
		consecutiveFailures: 0,
		loop: false,
		doneClaimWithoutEvidence: false,
		planningShapedWork: false,
		strong: false,
		evidence: [],
		...overrides,
	};
}

	test("strong auto signal takes over even during the recover cooldown", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.requestTakeover("recover", "seed", "d")).toBe("accepted");
		expect(await controller.handoffToExecutor("resolved")).toBe("ok"); // cooldown = 2 now
		controller.notifyAutoSignals(
			signalReport({ strong: true, sentiment: true, consecutiveFailures: 3, evidence: ["negative user sentiment", "3 consecutive failed tool results"] }),
		);
		expect(controller.status.phase).toBe("takeover");
		expect(controller.status.takeoverPurpose).toBe("recover");
	});

	test("loop signal alone respects the cooldown (advice, no takeover)", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.requestTakeover("recover", "seed", "d")).toBe("accepted");
		expect(await controller.handoffToExecutor("resolved")).toBe("ok");
		controller.notifyAutoSignals(signalReport({ loop: true, evidence: ["loop"] }));
		expect(controller.status.phase).toBe("executing"); // cooldown-advice path
	});

	test("unverified done-claim signal fires a verify takeover", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.notifyAutoSignals(signalReport({ doneClaimWithoutEvidence: true, evidence: ["done without verification"] }));
		expect(controller.status.phase).toBe("takeover");
		expect(controller.status.takeoverPurpose).toBe("verify");
	});

	test("auto signals are inert when disabled, when not executing, or when the planner holds the stream", async () => {
		const disabledHost = fakeHost();
		const disabled = new DuoController(disabledHost, duoConfig({ signals: { enabled: false, sentiment: true, failureThreshold: 3, loopThreshold: 3 } }));
		await disabled.reevaluate();
		disabled.notifyAutoSignals(signalReport({ strong: true }));
		expect(disabled.status.phase).toBe("executing");

		const summonHost = fakeHost();
		const summoned = new DuoController(summonHost, duoConfig());
		await summoned.reevaluate();
		await summoned.summonPlanner(); // Fable on the executing stream
		summoned.notifyAutoSignals(signalReport({ strong: true }));
		expect(summoned.status.phase).toBe("executing");
	});

	test("strong signal rejected at the consecutive cap surfaces the manual escape hatch", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig({ maxConsecutive: 0 }));
		await controller.reevaluate();
		controller.notifyAutoSignals(signalReport({ strong: true, evidence: ["x"] }));
		expect(controller.status.phase).toBe("executing");
		expect(host.notices.at(-1)?.level).toBe("warning");
		expect(host.notices.at(-1)?.text).toContain("/duo");
	});

	test("planning-shaped executor work draws one duo_escalate nudge per streak", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.notifyAutoSignals(signalReport({ planningShapedWork: true }));
		controller.notifyAutoSignals(signalReport({ planningShapedWork: true }));
		expect(host.briefs.filter(b => b.text.includes("duo_escalate"))).toHaveLength(1);
		controller.notifyAutoSignals(signalReport()); // streak broken → re-arm
		controller.notifyAutoSignals(signalReport({ planningShapedWork: true }));
		expect(host.briefs.filter(b => b.text.includes("duo_escalate"))).toHaveLength(2);
	});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts`. Expected: FAIL (`notifyAutoSignals` missing).

- [ ] **Step 3: Implement.**

3a. Thread options through `requestTakeover` (:301): change the signature to
```ts
	requestTakeover(
		purpose: TakeoverPurpose,
		reason: string,
		directive: string,
		options?: TakeoverRequestOptions,
	): TakeoverDecision {
		const decision = this.#machine.onTakeoverRequested(purpose, options);
```
(import `TakeoverRequestOptions` from `./state`; everything else in the method unchanged — existing callers in `takeover-tool.ts` and agent-session escalate-verify need no edits.)

3b. Add the policy (import `type { TakeoverSignalReport } from "./takeover-signals"` top-level; new field `#executorPlanningNudgeArmed = true;` next to `#planNudgeTurns`):

```ts
	/** R3: automatic per-turn takeover signals, evaluated by the session at executor turn end.
	 *  Strong (scolding + failure streak/loop) bypasses the recover cooldown; a loop or failure
	 *  streak alone respects it; an unverified done claim fires a verify takeover (verify
	 *  already skips cooldown). R6: planning-shaped executor work draws a soft nudge. */
	notifyAutoSignals(report: TakeoverSignalReport): void {
		if (!this.#config.signals.enabled) return;
		if (!report.planningShapedWork) this.#executorPlanningNudgeArmed = true;
		if (this.#machine.phase !== "executing") return;
		const current = this.#host.currentModel();
		if (current && modelsAreEqual(current, this.#config.planner)) return; // planner already holds the stream
		const evidence = report.evidence.join("; ") || "automatic executor-turn signal";
		if (report.strong) {
			const decision = this.requestTakeover(
				"recover",
				`Automatic signal: ${evidence}`,
				"Diagnose the failure streak, state the recovery direction, then duo_handoff with the corrected brief.",
				{ bypassCooldown: true },
			);
			if (decision === "rejected") {
				this.#host.emitNotice(
					"warning",
					"Strong duo takeover signal, but the consecutive-takeover cap is reached — use /duo plan or /duo exec to intervene manually.",
				);
			}
			return;
		}
		if (report.loop || report.consecutiveFailures >= this.#config.signals.failureThreshold) {
			this.requestTakeover(
				"recover",
				`Automatic signal: ${evidence}`,
				"Break the loop: state a new hypothesis and a concrete directive, then duo_handoff.",
			);
			return;
		}
		if (report.doneClaimWithoutEvidence) {
			this.requestTakeover(
				"verify",
				`Automatic signal: ${evidence}`,
				"Independently verify the completion claim with fresh evidence before accepting it.",
			);
			return;
		}
		if (report.planningShapedWork) this.#nudgeExecutorOffPlanning();
	}

	/** R6 soft guardrail: once per contiguous streak, remind the executor that planning belongs to the planner. */
	#nudgeExecutorOffPlanning(): void {
		if (!this.#executorPlanningNudgeArmed) return;
		this.#executorPlanningNudgeArmed = false;
		this.#host.injectBrief(
			"You are the duo EXECUTOR and this turn produced planning-shaped work (a plan document or long design). Architecture and planning belong to the planner: call duo_escalate with what needs planning instead of writing the plan yourself.",
			"nextTurn",
		);
	}
```

- [ ] **Step 4: Verify** — `bun test packages/coding-agent/src/duo/__tests__/controller.test.ts packages/coding-agent/src/duo/__tests__/state.test.ts`. Expected: PASS. Do NOT commit.

---

### Task 9: Session wiring — host capabilities + per-turn signal evaluation + `duoSummon`

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts` — `#buildDuoHost` (:2239-2300), `#syncDuoPromptOverlay` (:2305-2313), onTurnEnd wiring (:2076-2094, insertion before :2092), fields near `#duoPromptOverlayPhase` (:1587), `duoReplan` (:15770-15772), imports

**Interfaces:** Consumes `evaluateTakeoverSignals` (Task 3), `controller.notifyAutoSignals` + `summonPlanner` (Tasks 5/8), `#scheduleAdvisorRevive` (existing, :2318-2330). Produces: `duoSummon(): Promise<boolean>` (Task 10 consumes).

- [ ] **Step 1: Imports.** Add `evaluateTakeoverSignals` to the Task-3 import from `"../duo/takeover-signals"`; ensure `statSync` is in the `node:fs` import (add if absent). `resolveLocalUrlToPath` is already imported (used at :7432).

- [ ] **Step 2: Host members** — inside the `#buildDuoHost()` object literal (after `planModeActive` at :2299):

```ts
			planArtifactReady: () => this.#duoPlanArtifactReady(),
			scheduleAdvisorRevive: () => this.#scheduleAdvisorRevive(),
```

- [ ] **Step 3: Plan-artifact baseline.** Field next to `#duoPromptOverlayPhase` (:1587):

```ts
	#duoPlanBaseline: { path: string; mtimeMs: number } | undefined;
```

Capture it on the executing→planning overlay flip — replace `#syncDuoPromptOverlay` (:2305-2313) with:

```ts
	#syncDuoPromptOverlay(): void {
		const phase = this.#duoController?.status.phase;
		if (phase === this.#duoPromptOverlayPhase) return;
		if (phase === "planning") this.#captureDuoPlanBaseline();
		this.#duoPromptOverlayPhase = phase;
		this.agent.setSystemPrompt(this.#baseSystemPromptWithModeOverlay());
	}

	/** Baseline stat of the plan reference file at planning entry: the duo plan artifact is
	 *  "ready" once the file exists, is non-empty, and its mtime moved past this baseline —
	 *  regardless of whether the planner or a delegated subagent wrote it. */
	#captureDuoPlanBaseline(): void {
		const resolved = resolveLocalUrlToPath(this.#planReferencePath, this.#localProtocolOptions());
		if (!resolved) {
			this.#duoPlanBaseline = undefined;
			return;
		}
		const stat = statSync(resolved, { throwIfNoEntry: false });
		this.#duoPlanBaseline = { path: resolved, mtimeMs: stat?.mtimeMs ?? 0 };
	}

	#duoPlanArtifactReady(): boolean {
		const baseline = this.#duoPlanBaseline;
		if (!baseline) return false;
		const stat = statSync(baseline.path, { throwIfNoEntry: false });
		return stat !== undefined && stat.size > 0 && stat.mtimeMs > baseline.mtimeMs;
	}
```

- [ ] **Step 4: Per-turn signal evaluation.** In the `setOnTurnEnd` callback (:2076-2094), insert immediately BEFORE `void this.#duoController?.notifyTurnEnd();` (:2092):

```ts
			this.#evaluateDuoTakeoverSignals();
```

and add the private method:

```ts
	/** R3 wiring: evaluate automatic takeover signals on every primary executor turn.
	 *  The advisor done-gate remains the deep check for done claims — the signal only
	 *  carries the done-claim flag when that gate can no longer run. */
	#evaluateDuoTakeoverSignals(): void {
		const controller = this.#duoController;
		if (!controller || controller.status.phase !== "executing") return;
		if (this.#agentKind !== "main") return;
		if (!this.settings.get("duo.takeover.signals.enabled")) return;
		const report = evaluateTakeoverSignals(this.agent.state.messages, {
			failureThreshold: this.settings.get("duo.takeover.signals.failureThreshold"),
			loopThreshold: this.settings.get("duo.takeover.signals.loopThreshold"),
			sentimentEnabled: this.settings.get("duo.takeover.signals.sentiment"),
		});
		const doneGateCanRun =
			this.#advisorRuntime !== undefined && !this.#advisorRuntime.disposed && this.#advisorDoneGateRejections < 2;
		if (report.doneClaimWithoutEvidence && doneGateCanRun) {
			report.doneClaimWithoutEvidence = false;
		}
		controller.notifyAutoSignals(report);
	}
```

(Match the exact private names in place — `#advisorRuntime` and `#advisorDoneGateRejections` both exist; `#advisorDoneGateRejections` is reset at :8912.)

- [ ] **Step 5: `duoSummon`.** After `duoReplan` (:15770-15772):

```ts
	/** Transient advisory summon: the planner takes the main stream without entering planning. */
	async duoSummon(): Promise<boolean> {
		return (await this.#duoController?.summonPlanner()) ?? false;
	}
```

- [ ] **Step 6: Verify** — `bun --cwd=packages/coding-agent run check:types` (first task where the whole package must typecheck — the Task 5 host-interface growth is now satisfied), then `bun test packages/coding-agent/src/duo packages/coding-agent/test/agent-session-done-gate.test.ts`. Expected: PASS. Do NOT commit.

---

### Task 10: `/duo summon` slash command

**Files:**
- Modify: `packages/coding-agent/src/slash-commands/builtin-registry.ts:844-1005` (the `duo` command)

**Interfaces:** Consumes `session.duoSummon()` (Task 9).

- [ ] **Step 1: Add the subcommand** to the list (:848-854) and the hint (:847):

```ts
		acpInputHint: "[on|off|status|exec|plan|summon]",
			{ name: "summon", description: "Summon the planner to the main stream for a transient consult" },
```

- [ ] **Step 2: Handle it in BOTH runtimes.** In `handle` (after the `plan` branch ending :921):

```ts
			if (verb === "summon") {
				const summoned = await runtime.session.duoSummon();
				await runtime.output(
					summoned
						? "Planner summoned to the main stream; duo_handoff restores the executor."
						: "Duo is not executing — nothing to summon.",
				);
				return commandConsumed();
			}
```

In `handleTui` (after the `plan` branch ending :993):

```ts
			if (verb === "summon") {
				const summoned = await runtime.ctx.session.duoSummon();
				runtime.ctx.showStatus(
					summoned
						? "Planner summoned to the main stream; duo_handoff restores the executor."
						: "Duo is not executing — nothing to summon.",
				);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
```

Update both usage strings (:922 and :1002) to `"Usage: /duo [on|off|status|exec|plan|summon]"`.

- [ ] **Step 3: Verify** — `bun --cwd=packages/coding-agent run check:types`. Expected: PASS. Do NOT commit.

---

### Task 11: Integration gates, whitelist no-change assertion, manual smoke

**Files:** none created — verification only.

- [ ] **Step 1: Whitelist NO-change assertion.** Confirm `packages/coding-agent/src/orchestrator-mode/state.ts` has NO diff in this work: `ORCHESTRATOR_MODE_SAFE_TOOL_NAMES` (:7-22) already whitelists `duo_handoff`/`duo_escalate`/`consult`; `request_takeover` stays advisor-only (agent-session.ts:2635-2646, gated on `#duoController`); `duo_handoff` is `loadMode: "essential"` (handoff-tool.ts:20). This is a grounded no-op — if any task touched that file, revert it.

- [ ] **Step 2: Full gates:**

```bash
bun --cwd=packages/coding-agent run check:types
bun test packages/coding-agent/src/duo
bun test packages/coding-agent/test/agent-session-done-gate.test.ts packages/coding-agent/test/advisor-toggle.test.ts packages/coding-agent/test/advisor-watchdog.test.ts packages/coding-agent/test/advisor-provider-options-parity.test.ts packages/coding-agent/test/advisor/advisor-visibility.test.ts
bun --cwd=packages/coding-agent run format-prompts
bun --cwd=packages/coding-agent run lint
```
Expected: all PASS; lint clean on touched files.

- [ ] **Step 3: Manual smoke (TUI):** `/duo on` with a Fable+Opus pair → phase executing; open the model picker and select Fable → notice "Duo planning: manual switch to the planner…", NO "summons to reason" brief, `/duo status` shows `planning`; have a subagent write `local://PLAN.md` → next turn shows the "call duo_handoff NOW" nudge; `duo_handoff` → Opus back on the stream, phase executing. Then `/duo summon` → Fable on stream, phase stays executing, dwell nag appears after 3 turns. Finally set `duo.takeover.signals.enabled: false` and confirm no auto-takeover notices appear.

- [ ] **Step 4: QA handoff.** Dispatch the qa agent with: the commands from Step 2, the smoke script from Step 3, and the acceptance criteria from the Requirement → Task map. Completion claims require the collected qa verdict.

---

## Parallel Execution Groups (for the executor to fan out)

| Group | Tasks | Mode | File ownership (disjoint within group) |
|---|---|---|---|
| 1 | Task 1, Task 2, Task 3, Task 4 | PARALLEL (4 subagents) | T1: settings-schema.ts + model-resolver.ts + controller.test.ts fixture ONLY; T2: state.ts + state.test.ts; T3: takeover-signals.ts (new) + agent-session.ts helper block (:1304-1339, :1397-1432) + duo/index.ts + done-gate test imports + takeover-signals.test.ts (new); T4: duo/prompts/*.md + session-wiring.test.ts |
| 2 | Task 5 → 6 → 7 → 8 | SEQUENTIAL, single owner | controller.ts + controller.test.ts (T5's fixture edits must not collide with T1's — T1 only touches `duoConfig()`) |
| 3 | Task 9, Task 10 | PARALLEL (2 subagents) | T9: agent-session.ts; T10: builtin-registry.ts |
| 4 | Task 11 | SINGLE (integrator) | none (verification only) |

Sequencing rationale: Group 2 consumes the locked contracts of every Group-1 task (config fields, `TakeoverRequestOptions`, `TakeoverSignalReport`, manual-plan-brief.md); Group 3 consumes Group 2's controller surface (`summonPlanner`, `notifyAutoSignals`, host members). `check:types` is only meaningful after Group 3 (Task 5 grows `DuoControllerHost`; Task 9 implements it) — per-task verification inside Groups 1-2 is focused `bun test` runs, which Bun executes without typechecking.

## Edge Cases

- **Manual Fable switch while phase is `degraded`:** `onReplanRequested` requires `executing`, so `#enterManualPlanning()` returns false and the flow falls back to the summon/override path — intentional (no advisor to pause, duo already degraded).
- **Planner model === executor model:** `modelsAreEqual(model, executor)` returns early in `notifyManualModelChange`; no routing.
- **Overlay-only planning across restart:** `#planningOverlayOnly` is controller-local and NOT persisted in `DuoStateSnapshot`; after a restart in phase `planning`, `reevaluate`'s reconciliation engages literal plan mode. Accepted: plan mode's only enforcement is the working-tree write guard (plan-mode-guard.ts:136-158), which is compatible; orchestrator remains on (setPlanModeState never clears it).
- **Plan reference unresolvable (`resolveLocalUrlToPath` → undefined):** baseline is undefined → `planArtifactReady()` false forever → R1 nudges stay suppressed; planner-notice/manual-plan brief still demand `duo_handoff`. Graceful degradation, no crash.
- **Pre-existing PLAN.md:** baseline captures its mtime; readiness requires mtime to MOVE, so stale plans don't trigger premature nudges.
- **Signal false positives:** sentiment alone NEVER takes over (only strengthens a failure/loop signal); loop/failure alone respects cooldown (converts to `cooldown-advice`, i.e. nothing); `verify` from signals is suppressed while the advisor done-gate can still run (session-side `doneGateCanRun` check) so the deep gate keeps precedence; `maxConsecutive` remains the hard cap with an explicit manual-escape warning when a strong signal hits it.
- **`#trackPlannerDwell` vs planning:** unchanged — it only fires in executing-like phases, so summon keeps its nag and manual planning is silent until the artifact exists (R1).
- **evaluateActivation degraded→inactive** when `canActivate` is false at revive time (duo.mode auto + orchestrator off + non-Fable main): pre-existing behavior, out of scope, documented here so nobody "fixes" it ad hoc.

## Verification (final)

1. `bun --cwd=packages/coding-agent run check:types` — green.
2. `bun test packages/coding-agent/src/duo` — all duo suites green (state, controller, session-wiring, takeover-signals, advisor-retry).
3. `bun test packages/coding-agent/test/agent-session-done-gate.test.ts packages/coding-agent/test/advisor-toggle.test.ts packages/coding-agent/test/advisor-watchdog.test.ts` — green (helper relocation + advisor paths unaffected).
4. `bun --cwd=packages/coding-agent run format-prompts` and `bun --cwd=packages/coding-agent run lint` — clean.
5. Manual smoke per Task 11 Step 3; qa agent verdict collected.
6. `git status` confirms NO changes under `src/modes/interactive-mode.ts`, `src/irc/`, `src/orchestrator-mode/state.ts` (foreign WIP + whitelist no-change).

## Critical Files (read before implementing)

- `packages/coding-agent/src/duo/state.ts` — the whole machine (200 lines); gates at :131-147, degraded at :58-64 & :165-168.
- `packages/coding-agent/src/duo/controller.ts` — full read; especially :106-175 (reevaluate), :235-284 (manual change), :301-321 (takeover), :345-393 (handoff), :455-501 (switch + dwell).
- `packages/coding-agent/src/duo/__tests__/controller.test.ts:1-170` — FakeHost pattern every controller test uses.
- `packages/coding-agent/src/session/agent-session.ts:1304-1432, 2076-2094, 2239-2361, 7195-7263, 9044-9093, 15758-15772` — duo wiring regions.
- `packages/coding-agent/src/config/model-resolver.ts:1307-1404` — DuoResolvedConfig + resolveDuoConfig.
- `packages/coding-agent/src/duo/prompts/*.md` — current phase briefs/overlays (tone + mustache identity-line convention to match).
- `packages/coding-agent/src/orchestrator-mode/state.ts` — read-only context: the whitelist that must NOT change.
