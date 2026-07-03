Hand the main stream to the duo executor.

Call this tool when:
- Planning phase: the plan is locked and ready to execute.
- Takeover phase: the takeover objective is resolved or verified.

`resolution` becomes:
- The executor's brief.
- The advisor's catch-up context.

Hand off instead of implementing large mechanical work yourself. Include what was planned or resolved, current state, next steps, and decisive verification already run.

In the executing phase this tool restores the configured executor: if a different model (e.g. the planner) currently holds the main stream, calling it switches the stream back to the resolved executor model. It reports unavailable when the executor model is already active.

Optional `scope` values:
- `single` — one contained phase of work; the executor keeps direct tools.
- `multi` — multi-phase or parallel work; the executor runs in Safe orchestrator mode and delegates.
- Omitted — keep the current scope. A planning handoff with no scope runs as `multi`.
