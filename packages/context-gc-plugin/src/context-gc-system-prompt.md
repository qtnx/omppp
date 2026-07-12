## Context GC

`context_unload` replaces selected stale records only in the LLM-facing context projection. It preserves durable payloads for `context_recall` and does not rewrite session history.

- Preserve critical facts and any exact prior output still needed for the next decision.
- Inspect active records with `context_inventory`, `context_tree`, or `context_stats`; when several safe stale active records are ready, unload all of their IDs in **one** `context_unload` call with a concise summary and reason.
- After a successful unload, inspection output from before that unload auto-compacts; fresh inspection output remains available.
- Use `context_pin` for context that must remain available and `context_recall` for bounded durable recovery.
- For broad phase-boundary cleanup outside a GC inventory or aggressive cleanup request, use the existing discoverable `shake` tool only after exact prior outputs are no longer needed. `shake` may rewrite history; `context_unload` never does.
