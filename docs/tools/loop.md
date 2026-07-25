# loop

> Schedule a self-contained prompt to re-run as follow-up turns every `interval`, `count` times.

## Source
- Entry: `packages/coding-agent/src/tools/loop.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/loop.md`
- Key collaborators:
  - `packages/coding-agent/src/session/loop-manager.ts` — session-scoped scheduler (`LoopManager`) delivering iterations as follow-up turns.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool via `LoopTool.createIf(session)`; the factory gate also refuses `loop` when `session.taskDepth !== 0`.
  - `ToolSession.getLoopManager` — session hook returning the lazy `LoopManager` (`undefined` in sessions that cannot host loops).
  - `packages/coding-agent/src/session/agent-session.ts` — owns the `LoopManager` instance and calls `cancelAll()` on dispose, reset, new-session, branch, and `/btw` paths.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | `string` (1–4000 chars) | Yes | Self-contained instruction delivered verbatim on every iteration as a follow-up turn. Must not start with `/`. |
| `interval` | `string` | Yes | Cadence between iterations after the first: `"10s"`, `"5m"`, `"1h"` (fractional values allowed, e.g. `"1.5m"`), or a bare number of seconds. Minimum 10s. |
| `count` | `number` (int, 1–100) | Yes | Total iterations including the immediate first one. |

## Outputs
Single-shot result; the loop then runs in the session background.

- `content[0].text`: `Loop <id> scheduled: "<prompt>" every <interval>, <count> iterations. Iteration 1/<count> queued. Iterations arrive as follow-up messages; the loop stops after <count> iterations or when the session ends.`
- `details`: `{ id: string, prompt: string, interval: string, intervalMs: number, count: number, meta?: OutputMeta }` where `id` is `l<base36 sequence>` (e.g. `l1`, `l2`, …).

## Flow
1. `LoopTool.createIf(session)` returns `null` when `session.taskDepth !== 0`, so subagent sessions never see the tool; `tools/index.ts` applies the same gate by name.
2. `execute(...)` resolves `session.getLoopManager?.()`; when the session cannot host loops it throws `ToolError("Loops are unavailable in this session.")`.
3. Prompts starting with `/` are rejected — follow-up turns cannot run extension commands.
4. `parseIntervalMs(...)` accepts `<number>[s|m|h]` (fractional allowed) or a bare seconds number; unparseable values throw a `ToolError` describing the expected formats, and anything under 10s throws a minimum-interval `ToolError`.
5. `LoopManager.schedule(...)` assigns the id `l<base36 seq>`, stores the entry, and fires iteration 1 immediately via `#tick` — no full-interval warmup wait.
6. Each tick builds `[loop <id> · <i>/<count>] <prompt>` and delivers it through the session `followUp` channel as an ordinary follow-up turn.
7. Chained `setTimeout` (never `setInterval`): the next timer is armed for `intervalMs` only after the current follow-up resolves, so exactly one live timer exists per loop and ticks cannot overlap.
8. After iteration `count` resolves (or a tick observes `iteration >= count`), `#finish` clears the timer, seals the entry, and removes it from the registry.
9. A rejected follow-up logs `Loop followUp rejected; cancelling loop` and cancels that loop (entry sealed and removed); other loops are unaffected.
10. `cancelAll()` — invoked from session dispose, reset, new-session, branch, and `/btw` paths — seals every entry and clears every timer; in-flight follow-up promises may settle but never schedule further iterations.

## Side Effects
- Session state
  - Queues `count` follow-up turns over the loop's lifetime (iteration 1 immediately).
  - Holds one `setTimeout` timer per active loop between iterations.
  - All loops are cancelled automatically when the session ends, resets, or branches; there is no mid-session cancel tool.

## Limits & Caps
- `loadMode = "discoverable"`; `approval = "read"`; `strict = true`.
- Depth-0 (main-session) agents only — subagent sessions never register the tool.
- Interval floor 10s (`MIN_INTERVAL_MS`); count ceiling 100; prompt ceiling 4000 chars.

## Errors
- Session cannot host loops → `ToolError("Loops are unavailable in this session.")`.
- Prompt starts with `/` → `ToolError("Loop prompt must not start with \"/\": extension commands cannot be delivered as follow-up turns.")`.
- Unparseable interval → `ToolError('Invalid interval value: … Expected a positive number of seconds or duration like "5s", "10m", "1h".')`.
- Interval under 10s → `ToolError("Interval too short: … Minimum interval is 10s (got <n>s).")`.

## Notes
- Use `job` (or async `bash`) for fire-and-forget background work; `loop` exists for recurring checks where each tick needs fresh model judgment.
- Cadence is measured from when the previous follow-up resolves, not from fire time — a slow turn shifts later ticks instead of bunching them.
- Distinct from the user-facing `/loop` interactive mode (`packages/coding-agent/src/modes/interactive-mode.ts`), which captures a repeated prompt into a file and auto-submits it; the `loop` tool is the model-facing scheduler built on `LoopManager` follow-up turns.
- Prompts must be self-contained: each iteration is a fresh follow-up turn, so "continue from where you left off" style prompts degrade.
