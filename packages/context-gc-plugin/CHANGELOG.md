# Changelog

## [Unreleased]

## [1.0.7] - 2026-06-09

### Added
- Added global Context GC stats reporting for durable database-wide records, sessions, payloads, and token savings.
- Added DB-backed context unloading extension with inventory, unload, recall, and pin tools.

### Changed
- Context GC unload reminders now wait until context usage is above 50% and explicitly call out stale tool calls, file reads, and searches as unload candidates.
- Stale Context GC inspection tool outputs are now compacted automatically after a later `context_unload` cleanup.

### Fixed
- Shortened Context GC unload reminders so they no longer enumerate candidate record IDs or tool-call details.
