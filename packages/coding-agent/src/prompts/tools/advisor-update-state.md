Replace the durable advisor state stored at `local://advisor-state.md`.

Use this whenever the user's requirements, current plan, phase, decisions, watchpoints, dispatched subagents, verification verdicts, or effort changes. Keep it concise but complete enough that a re-primed advisor can resume oversight without relying on conversation memory.

Recommended sections:
- `## Goal` — current user objective and success criteria.
- `## Requirements` — explicit user requirements with status and evidence pointer.
- `## Plan / Todos` — current phase and ordered work.
- `## Decisions` — locked decisions and one-line rationale.
- `## Watchpoints` — risks, drift signals, and standing reminders.
- `## Verification` — dispatched QA/test/browser/subagent checks and verdict status.
- `## Effort log` — executor effort changes and reason.

Replace the whole file each call. Do not append stale guidance.
