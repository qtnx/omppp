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
- `single` (default) — the executor keeps direct tools and does the work itself, delegating only where it genuinely speeds things up. Fixes, features of a few files, verification, and any task that fits one sitting are `single`.
- `multi` — reserve for long-running, multi-phase implementation with several independent workstreams (a locked plan with 3+ phases or 4+ parallelizable packages). The executor runs in Safe orchestrator mode and delegates everything.
- Omitted — keep the current scope; a planning handoff with no scope runs as `single`. The executor may still enter orchestrator mode itself mid-task when the work turns out to be multi-phase.
