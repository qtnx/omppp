Hand the main stream to the duo planner because the current work exceeds executor-grade difficulty.

Call this tool when:
- You attempted the same problem twice without real progress.
- The work needs an architecture or design decision the plan does not answer.
- Deep multi-step reasoning is required rather than execution.

`reason` becomes the planner's takeover brief — state what you tried, what failed, and the current state. The planner resolves the blocker and hands back via `duo_handoff`. Do not call this for work you can complete by delegating to subagents.
