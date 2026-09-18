# duo_change_phase

> Moves the duo session into another work phase, so that phase's configured model takes the main stream.

## Source
- Entry: `packages/coding-agent/src/duo/phase-tool.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/duo-change-phase.md`
- Key collaborators:
  - `packages/coding-agent/src/duo/controller.ts` — `requestPhaseChange` applies the phase's model (and registers its fallback chain); `DuoPhaseChangeResult` describes the outcome.
  - `packages/coding-agent/src/signals/types.ts` — `WorkPhase` / `WORK_PHASES` define the valid phase values.
  - `packages/coding-agent/src/config/settings-schema.ts` — `duo.phaseModels` maps each phase to one selector or an ordered list.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates it on a live duo phase (`DUO_TOOL_NAMES`).
  - `packages/coding-agent/src/session/session-duo-orchestrator.ts` / `agent-session.ts` — host hooks (`duoChangePhase`) the tool call travels through.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `phase` | `"preplanning" \| "planning" \| "implementing" \| "verifying" \| "debugging" \| "blocked" \| "reporting"` | Yes | Work phase to move into. The phase's configured model takes the main stream. |
| `reason` | `string` | No | One-line rationale shown to the user as part of the phase-change notice. |

## Outputs
Single-shot result, no `details`.

- Success: `content[0].text` = `"Phase changed to <phase>; its configured model now holds the main stream."`

## Flow
1. `DuoChangePhaseTool.execute()` validates `phase` with `isWorkPhase` and calls the injected `requestPhaseChange(phase, reason)` callback, which delegates to `session.duoChangePhase?.(...)`.
2. The controller records the work phase, resolves the phase's first unsuppressed candidate, registers the remaining candidates as its rate-limit fallback chain, and switches the main-stream model. An unlisted phase restores the resolved executor.
3. The result decides the outcome:
   - `"unavailable"` — no live duo controller (inactive/suspended phase) → error.
   - `"switch-failed"` — the controller could not switch the main-stream model → error.
   - `"ok"` — the phase and its model are applied; a notice carries the phase, the model, and `reason`.

## Modes / Variants
- `preplanning` — the duo opener: brainstorm the request and scout the code before a plan exists.
- Any phase listed in `duo.phaseModels` — applies that phase's model chain.
- A phase without a `duo.phaseModels` entry — the resolved executor takes the stream.

## Side Effects
- Session state
  - Sets the duo work phase (persisted in the duo snapshot, shown by `/duo status`) and switches the main-stream model.
  - Registers the phase's later candidates as the active model's `retry.fallbackChains` entry, so a rate-limited phase model fails over inside the phase.
- No filesystem, subprocess, or network effects directly in this tool.

## Limits & Caps
- `loadMode = "essential"`.
- Only available while duo is live (`isDuoPhaseLive`: not `inactive`, not `suspended`).
- Unlike the classifier-driven phase switch, this path skips the confidence and streak gates — an explicit request is authoritative.
- The sticky `preplanning` phase holds against classifier re-routing for at most four turns before the classifier may take over.

## Errors
- Unknown phase value → `ToolError("duo_change_phase: unknown work phase <value>.")`.
- No live duo controller → `ToolError("duo_change_phase is only available while a duo controller is driving the session.")`.
- Switch failure → `ToolError("duo_change_phase failed: could not switch the main-stream model (see logs).")`.

## Notes
- A phase change re-routes the phase model only; it never hands the stream between planner and executor — that is `duo_handoff` / `duo_escalate`.
- Counterpart to the classifier: TypeSafe turn signals drive automatic phase switching, while this tool lets the model declare the phase it is actually in.
