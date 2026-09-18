Move the duo session into another work phase, so that phase's configured model takes the main stream.

Call this tool when the shape of the work changed:

- `preplanning` — open a fresh request by brainstorming the idea, understanding what the user actually needs, and scouting the relevant code before committing to a plan.
- `planning` — the idea is understood; produce the plan, resolve its open questions, and lock it.
- `implementing` — write the code, wire the feature, apply the plan.
- `verifying` — run the tests, typechecks, builds, and smoke checks that prove the change.
- `debugging` — a failure needs a root cause before anything else moves.
- `blocked` — progress needs access, credentials, or a decision only the user can make.
- `reporting` — summarize the outcome and its evidence; no further tool work is in progress.

`duo.phaseModels` decides which model each phase runs, and phases without an entry keep the executor. `reason` is shown to the user as the one-line rationale for the switch.

A phase change only re-routes the phase model; it never hands the stream between planner and executor — use `duo_handoff` or `duo_escalate` for that.
