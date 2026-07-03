# orchestrator_mode

> Enter, exit, or inspect Safe orchestrator mode — a delegation-only toolset for multi-agent orchestration.

## Source
- Entry: `packages/coding-agent/src/tools/orchestrator-mode.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/orchestrator-mode.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/index.ts` — registers the tool (`orchestrator_mode: s => new OrchestratorModeTool(s)`).
  - `ToolSession.setOrchestratorModeState` / `getOrchestratorModeState` — session hooks that swap the active toolset.
  - `ToolSession.getPlanModeState` / `getGoalModeState` — mutually exclusive mode guards checked on `enter`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"enter" \| "exit" \| "status"` | Yes | `enter` switches the session to the safe orchestration toolset plus this control tool. `exit` restores the toolset that was active before entry. `status` reports the current mode without changing anything. |

## Outputs
Single-shot result, no streaming.

- `enter`: `content[0].text` = `"Orchestrator mode enabled."`, `details: { enabled: true, mode: "orchestrator" }`.
- `exit`: `content[0].text` = `"Normal mode restored."`, `details: { enabled: false, mode: "normal" }`.
- `status`: `content[0].text` = `"Orchestrator mode is active."` or `"Orchestrator mode is inactive."`, `details.enabled` reflects current state, `details.mode` is `"orchestrator"` or `"normal"`.

## Flow
1. `OrchestratorModeTool.execute()` dispatches on `params.op`.
2. `enter`: requires `session.setOrchestratorModeState` to exist; throws `ToolError` otherwise. Also throws if plan mode (`getPlanModeState()?.enabled`) or goal mode (`getGoalModeState() !== undefined`) is currently active — these modes are mutually exclusive with orchestrator mode. On success, calls `setOrchestratorModeState({ enabled: true })`.
3. `exit`: requires `setOrchestratorModeState`; calls it with `undefined` to restore the prior toolset.
4. `status`: reads `session.getOrchestratorModeState?.()?.enabled` (defaults to `false` when the hook is absent) and reports it without mutating session state.

## Modes / Variants
- `enter` / `exit` are the only state-mutating ops; `status` is read-only.
- Approval level is `"read"` — the tool itself does not require write approval even though `enter`/`exit` change which tools are exposed.

## Side Effects
- Session state
  - `enter` / `exit` swap the session's active tool set via `setOrchestratorModeState`; the effect is visible to the model as a different tool roster on the next turn.
- No filesystem, subprocess, or network effects.

## Limits & Caps
- `loadMode = "essential"`: always available when the tool factory is registered, independent of discovery gating.
- No retry or depth limits; `enter`/`exit` are idempotent no-ops if the underlying session hook chooses to treat repeated calls that way (the tool itself always overwrites state and reports success).

## Errors
- `enter`/`exit` without `session.setOrchestratorModeState` → `ToolError("Orchestrator mode is unavailable in this session.")`.
- `enter` while plan mode is active → `ToolError("Exit plan mode before entering orchestrator mode.")`.
- `enter` while goal mode is active → `ToolError("Exit goal mode before entering orchestrator mode.")`.

## Notes
- Intended for complex, multi-phase tasks that benefit from a delegation-only toolset (`task`, `irc`, `read`, `grep`, `glob`, and this control tool) rather than direct file edits; simple single-phase tasks should stay in normal mode.
- `status` is safe to call speculatively to check mode before deciding whether to `enter`.
