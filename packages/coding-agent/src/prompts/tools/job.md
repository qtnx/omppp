Manages async background tasks (e.g. bash scripts, subagents).

Background tasks deliver their results automatically the moment they finish. You NEVER need to poll to retrieve output. Only use this tool if you need to intervene in the lifecycle of a task.

# Interventions

- **Snapshot:** Pass `list: true` to inspect what's running without waiting.
- **Block and wait:** Pass `poll` with specific job IDs when you are completely blocked and cannot do any other work. A poll sleeps up to the current scheduled window (5m first poll, 10m on consecutive re-polls), returns EARLY when a watched job finishes or IRC/steering arrives, and on expiry returns a still-running snapshot with per-job live stats (elapsed, model, tools, tokens, last activity, STALLED flag) plus the next window size; re-issue `job poll` to keep waiting (sanctioned wait, NOT busy-polling).
  - During blocking subagent waits, this tool automatically considers context compaction before/while it waits. If the result says `[compaction scheduled while waiting — running at next boundary]`, STOP: end/yield this turn so the scheduled remote/local compaction can run before any re-poll. Do not call `compact` yourself after that note.
  - `async.pollWaitDuration: "block"` restores indefinite blocking; fixed `5s`..`5m` values use one fixed window then snapshot.
  - To watch EVERY running job, issue a call with NO fields at all (no `poll`, no `cancel`, no `list`). NEVER pass an array of every running ID.
  - A finished job's output, or the interrupting message and reason, is included in the next turn.
- **Stop execution:** Pass `cancel` with job IDs to kill jobs that have hung, stalled, or are no longer needed. A cancel-only call returns immediately.
