Context GC: {{ eligible_tokens }} estimated tokens are eligible to unload.
{{#if context_usage_line}}
{{ context_usage_line }}
{{/if}}
Use `context_inventory`, `context_tree`, or `context_stats` to analyze unloadable tool calls, file reads, searches, and other stale context, then call `context_unload` for contexts no longer needed with a concise summary and reason. Use `context_pin` for context that must remain available.
