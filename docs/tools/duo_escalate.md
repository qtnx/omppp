# duo_escalate

> Hands the main stream to the duo planner model because the current work exceeds executor-grade difficulty.

## Source
- Entry: `packages/coding-agent/src/duo/escalate-tool.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/duo-escalate.md`
- Key collaborators:
  - `packages/coding-agent/src/duo/state.ts` — `TakeoverPurpose` / `TakeoverDecision` types describing valid duo phases.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool: `duo_escalate: s => new DuoEscalateTool(async reason => (await s.duoEscalateToPlanner?.(reason)) ?? "unavailable")`.
  - `packages/coding-agent/src/duo/handoff-tool.ts` — counterpart tool that hands the stream back to the executor.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `to` | `"planner"` | Yes | The duo planner model; the only valid literal value. |
| `reason` | `string` | Yes | Takeover brief for the planner: what was tried, what failed or is blocking, and the current state. Becomes the planner's takeover brief. |

## Outputs
Single-shot result, no `details`.

- Success: `content[0].text` = `"Escalation accepted: the planner takes the main stream at the next turn boundary."`

## Flow
1. `DuoEscalateTool.execute()` calls the injected `requestEscalate(reason)` callback, which delegates to `session.duoEscalateToPlanner?.(reason)`.
2. The callback returns `"ok"` (escalation accepted) or `"unavailable"` (escalation cannot happen right now).
3. On `"ok"`, the planner takes over the main stream at the next turn boundary, not synchronously inside this call.

## Modes / Variants
- Only meaningful while duo is in the executing phase — the tool exists to let the executor call for help when the work exceeds what it can safely resolve alone.

## Side Effects
- Session state
  - Schedules a model/stream switch (executor → planner) on the session's duo controller; takes effect at the next turn boundary.
- No filesystem, subprocess, or network effects directly in this tool.

## Limits & Caps
- `loadMode = "essential"`.
- Only available while duo is in the executing phase.

## Errors
- Escalation unavailable (wrong phase, or `session.duoEscalateToPlanner` absent) → `ToolError("duo_escalate is only available while duo is in the executing phase.")`.

## Notes
- Use for: the same problem was attempted twice without real progress, the work needs an architecture/design decision the plan does not answer, or deep multi-step reasoning is required rather than execution.
- Do not call for work that can instead be completed by delegating to subagents — escalate only for genuine planner-grade reasoning blockers.
- The planner resolves the blocker and hands control back via `duo_handoff`.
