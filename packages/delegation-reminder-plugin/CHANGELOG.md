# Changelog

## [Unreleased]

### Added

- Added the Delegation Reminder extension: tracks per-turn hands-on tool usage (`edit`, `write`, `ast_edit`, `bash`) and, when the session runs in Orchestrator Mode (`task.eager` on with the `task` tool available), appends a one-time mid-turn `<system-notice>` nudging the model to delegate via subagents once the configured threshold is crossed without any `task` delegation.
- Recorded a per-turn `delegation-reminder` stats entry (`appendEntry`, session-log only) carrying `{ model, provider, api, handsOnCount, taskCount, threshold }` for per-model offender stats, without bloating the LLM conversation.
