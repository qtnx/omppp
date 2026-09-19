# Changelog

## [Unreleased]

### Added

- Added a run-scoped discovery reminder: after 8 `read`/`grep`/`glob`/`codegraph_explore` calls in a run with no edit and no `task` dispatch, the tool result carries a one-time notice to fan out `scout`/`explore` subagents instead of hand-scouting. Tunable via `discoveryThreshold`, suppressed when TypeSafe classifies the slice as targeted lookups.

## [1.6.6] - 2026-07-25

### Changed

- Reworded the delegation reminder to require anchored briefs (exact `file:line` plus pasted code) and to allow continued hands-on work when the remainder is a single contained edit, a shared prerequisite, or a live debug loop.

## [1.3.0] - 2026-06-11

### Added

- Added the Delegation Reminder extension: tracks per-turn hands-on tool usage (`edit`, `write`, `ast_edit`, `bash`) and, when the session runs in Orchestrator Mode (`task.eager` on with the `task` tool available), appends a one-time mid-turn `<system-notice>` nudging the model to delegate via subagents once the configured threshold is crossed without any `task` delegation.
- Recorded a per-turn `delegation-reminder` stats entry (`appendEntry`, session-log only) carrying `{ model, provider, api, handsOnCount, taskCount, threshold }` for per-model offender stats, without bloating the LLM conversation.
