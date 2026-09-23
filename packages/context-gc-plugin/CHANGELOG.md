# Changelog

## [Unreleased]

### Changed

- The per-request context check indexes messages and branch entries once instead of comparing every record against every message, about 12x faster with 1000 messages and records.

## [1.10.2] - 2026-09-19

### Added

- Consumed tool output is now shed mid-turn while the prompt cache is still warm: a large tool result the model has read exactly once (the slice the previous request introduced) is replaced by its recall placeholder when Jev judges the upcoming work no longer needs it and the rewrite pays back on the next request. Set `OMP_CONTEXT_GC_HOT_TRIM=0` to disable.

### Changed

- Prompt-cache warmth is tracked per model instead of per session: switching model (duo planner/executor, manual switch) reads cold only for the model that will serve the next request, so a switch trims stale prompt records while the model that just answered keeps its live prefix. The cold-cache trim is now judged by Jev against the upcoming work when signals are available, and falls back to the previous kind-based heuristic otherwise.

## [1.8.1] - 2026-09-08

### Added

- Cold-cache auto-shake: when the provider prompt cache has expired (idle past the cache TTL — 1h by default, `OMP_CONTEXT_GC_CACHE_TTL_MS` overrides — or process start), stale tool output older than the last 12 messages is unloaded automatically before the request, so the unavoidable cache rewrite starts from a smaller prompt. Records stay recallable via `context_recall`; `OMP_CONTEXT_GC_AUTO_SHAKE=0` disables.

### Changed

- `context_unload` now applies its projection lazily: pending unloads stay verbatim while the provider prompt cache is warm and are applied once the cache is idle past its TTL or the pending savings reach 30% of the live context, so a small unload no longer rewrites the whole cached prompt.

## [1.7.3] - 2026-08-15

### Changed

- Context GC now keeps one live SQLite connection per database path, skips re-reading stored payload blobs on hash hits, and loads branch records in a single lookup so inventory and footer usage estimates no longer reopen or scan the multi-gigabyte store on every call.

## [1.6.0] - 2026-07-12

### Changed

- Context GC inventory and reporting now account for active messages and report truthful projected net savings; batch unload output is compact and duplicate-safe with placeholders, and prompt guidance batches stale active IDs before using `shake` for broad phase-boundary cleanup.

## [1.0.7] - 2026-06-09

### Added

- Added global Context GC stats reporting for durable database-wide records, sessions, payloads, and token savings.
- Added DB-backed context unloading extension with inventory, unload, recall, and pin tools.

### Changed

- Context GC unload reminders now wait until context usage is above 50% and explicitly call out stale tool calls, file reads, and searches as unload candidates.
- Stale Context GC inspection tool outputs are now compacted automatically after a later `context_unload` cleanup.

### Fixed

- Shortened Context GC unload reminders so they no longer enumerate candidate record IDs or tool-call details.
