# duo_handoff

> Hands the main stream to the duo executor model — used to end the planning phase or close out a takeover.

## Source
- Entry: `packages/coding-agent/src/duo/handoff-tool.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/duo-handoff.md`
- Key collaborators:
  - `packages/coding-agent/src/duo/controller.ts` — `DuoHandoffResult` type and the controller method (`s.duoHandoffToExecutor`) that performs the actual stream switch.
  - `packages/coding-agent/src/duo/state.ts` — `TakeoverPurpose` / `TakeoverDecision` types describing valid duo phases.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool: `duo_handoff: s => new DuoHandoffTool(async resolution => (await s.duoHandoffToExecutor?.(resolution)) ?? "no-controller")`.
  - `packages/coding-agent/src/tools/plan-mode-guard.ts` — plan-mode reminder text that tells the model to call `duo_handoff` once a plan is locked.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `to` | `"executor"` | Yes | The duo executor model; the only valid literal value. |
| `resolution` | `string` | Yes | Brief for the executor and advisor: what was planned or resolved, current state, and next steps. Becomes the executor's brief (planning phase) or the advisor's catch-up context (takeover phase). |

## Outputs
Single-shot result, no `details`.

- Success: `content[0].text` = `"Handoff to executor scheduled at the next turn boundary."`

## Flow
1. `DuoHandoffTool.execute()` calls the injected `requestHandoff(resolution)` callback, which delegates to `session.duoHandoffToExecutor?.(resolution)`.
2. The controller's result (`DuoHandoffResult`) determines the outcome:
   - `"no-controller"` — no duo controller is active in this session → error.
   - `"wrong-phase"` — duo state machine is not in a phase that supports handoff → error.
   - `"already-executor"` — the resolved executor already holds the main stream → error.
   - `"switch-failed"` — the controller could not switch the main-stream model → error.
   - any other value — success; handoff is scheduled.
3. On success, the actual model switch happens at the next turn boundary, not synchronously inside this call.

## Modes / Variants
- Planning phase: the plan is locked and ready to execute — `resolution` is the executor's brief.
- Takeover phase: the takeover objective is resolved or verified — `resolution` is the advisor's catch-up context.
- Executing phase: if the Fable/planner model currently holds the main stream, calling `duo_handoff` switches it back to the configured executor. If the executor already holds the stream, the tool reports `already-executor` instead of switching.

## Side Effects
- Session state
  - Schedules a model/stream switch on the session's duo controller; takes effect at the next turn boundary, not immediately.
- No filesystem, subprocess, or network effects directly in this tool (the controller may trigger those).

## Limits & Caps
- `loadMode = "essential"`.
- Only valid while duo mode is active with a controller in a compatible phase (planning, takeover, executing, or degraded per the tool's error copy).

## Errors
- No duo controller active → `ToolError("duo_handoff is unavailable: no duo controller is active in this session.")`.
- Wrong duo phase → `ToolError("duo_handoff is unavailable: duo is not in a phase that can hand off (only planning, takeover, executing, or degraded).")`.
- Executor already holds the stream → `ToolError("duo_handoff: the resolved executor already holds the main stream — nothing to hand off.")`.
- Switch failure → `ToolError("duo_handoff failed: could not switch the main-stream model (see logs).")`.

## Notes
- Counterpart to `duo_escalate`, which hands the stream the other direction (executor → planner).
- Do not call repeatedly while a handoff is already pending; the switch is applied at the next turn boundary.
