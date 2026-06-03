# Changelog

## [Unreleased]

### Added
- Added global Context GC stats reporting for durable database-wide records, sessions, payloads, and token savings.
- Added DB-backed context unloading extension with inventory, unload, recall, and pin tools.

### Fixed
- Shortened Context GC unload reminders so they no longer enumerate candidate record IDs or tool-call details.
