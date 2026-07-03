# consult

> "Phone a friend": asks the always-watching duo advisor a question mid-turn and blocks until it answers.

## Source
- Entry: `packages/coding-agent/src/tools/consult.ts`
- Key collaborators:
  - `ToolSession.consultAdvisor` — session hook that forwards the question to the advisor model and returns its answer (or `null` on timeout/no answer).
  - `ToolSession.isAdvisorActive` — distinguishes "advisor never ran" (inactive) from "ran but no answer in time".
  - Duo mode subsystem (`packages/coding-agent/src/duo/*`) — the advisor watches the full session transcript in the background.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `question` | `string` | Yes | What you are weighing and why you are unsure. The advisor has watched the whole session, so reference context rather than re-explaining it. |

## Outputs
Single-shot result, no `details`.

- Advisor answered: `content[0].text` = the advisor's answer.
- Advisor not active in this session: `content[0].text` = `"Advisor is not active in this session."`, `useless: true`.
- Advisor active but did not answer in time: `content[0].text` = `"The advisor did not answer in time. Proceed with your own judgment."`, `useless: true`.

## Flow
1. `ConsultTool.execute()` reads `session.consultAdvisor`; if absent, immediately returns the "not active" result (`useless: true`).
2. Otherwise calls `consult(args.question, signal)` and awaits the answer.
3. If the answer is non-`null`, returns it as the result text.
4. If the answer is `null`, checks `session.isAdvisorActive?.()`:
   - `false`/absent → "Advisor is not active in this session." (`useless: true`).
   - `true` → "The advisor did not answer in time. Proceed with your own judgment." (`useless: true`).

## Side Effects
- Session state
  - None mutated directly; reads from the advisor subsystem's live state.
- No filesystem or subprocess effects in this tool.

## Limits & Caps
- `loadMode = "essential"`.
- `interruptible = true` — ESC/steering aborts the wait so the primary stream is never wedged behind a slow advisor.
- Only meaningful when duo mode's advisor is active for the session.

## Errors
- This tool does not throw on advisor absence/timeout; both cases are reported as normal (non-error) results marked `useless: true` so the model can proceed on its own judgment.

## Notes
- Use when genuinely torn — stuck between two or more approaches, weighing a high-risk or hard-to-reverse decision, or doubting your own conclusion.
- The advisor has watched the whole session transcript, so state what you are weighing and why without re-explaining prior context.
- Advice to weigh, not an order — the calling model retains final judgment.
