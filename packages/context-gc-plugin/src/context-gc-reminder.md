Context GC: {{ eligible_tokens }} estimated tokens are eligible to unload.
{{#if context_usage_line}}
{{ context_usage_line }}
{{/if}}
Inspect safe stale active records, preserve critical facts, then batch all ready IDs into one `context_unload` call with a concise summary and reason. Pre-unload inspection output auto-compacts after a successful unload; use `context_pin` when exact context must remain available. For broad phase-boundary cleanup outside this inventory flow, use discoverable `shake` only when exact prior outputs are no longer needed.
