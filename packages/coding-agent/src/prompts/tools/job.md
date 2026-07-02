Inspects, waits, or cancels async jobs.

Results arrive automatically on completion; reach for this tool only to intervene.

# Operations

## `list: true`
Inspect what's running.

## `poll: [id, …]`
Blocks until at least one specified job finishes, new context arrives (peer message, another job's result, a queued user message), or the call is aborted. With a fixed `async.pollWaitDuration` (`5s`–`5m`) the wait is additionally capped at that duration and may return a still-running snapshot. Omit `poll` (no `list`/`cancel`) to wait on ALL running jobs — NEVER enumerate ids you don't need to filter.
- Use only when genuinely blocked with no other work.
- Completed jobs include final output.

## `cancel: [id, …]`
Stop running jobs.
- Use when a job is stalled, hung, or no longer needed.
