Locate the declaration implementing one behavior when its file is unknown.

- Query shape: `Which function/method <one action> <one object> [under one condition]?` Include the domain terms the code is likely to use. Provide the narrowest known `path`; do not invent a path.
- MUST split a multi-stage investigation into separate lookups. Ask where compaction is scheduled, then where history is compacted; NEVER ask one lookup to explain scheduling, execution, summarization, and history replacement together.
- Known symbol or exact text? Use `grep` or LSP. Known file and line range? Use `read`. Scout locates code; it does not explain an entire flow.
- `max_files` defaults to 3 (1–8); `timeout` defaults to 60 seconds. Scout follows bounded alternatives itself; NEVER repeat the same failed call unchanged or raise source detail to force a match.
- Returns a selected local excerpt, scope limits, and request/token counts. Check the excerpt before drawing conclusions; selection is probabilistic.
- `no_match` means no declaration was selected within the inspected scope, not repository-wide absence. Narrow the question or scope using observed evidence; otherwise switch to ordinary file search.
- Local files only; directory navigation respects gitignore and excludes hidden entries. To inspect an otherwise excluded file, provide its exact path.
- Read-only. Before editing, use `read` on the returned path and range to obtain current edit anchors.
- Sent to the configured Jev endpoint: your query, paths relative to the search root, and the metadata allowed by `signals.scoutSourceDetail`. `headers` (default) sends declaration names, kinds, and line ranges, not signatures, comments, imports, literals, or bodies. Those names and paths can still be sensitive. Session secret redaction applies before sending.
- `outline` explicitly permits unfolded source, including whole short files. `bodies` additionally permits full bodies of short files after rejection. Neither is an automatic fallback from `headers`. Returned excerpts are read locally and are not sent back to Jev.
- Unsupported or malformed source produces partial coverage, not a raw-source fallback. Default mode does not search JSON, YAML, Markdown, or other data files.

```json
{"query":"Which method accepts a compaction request from the agent?","path":"packages/coding-agent/src/session","max_files":3}
```

```json
{"query":"Which method manually compacts the session context?","path":"packages/coding-agent/src/session/session-maintenance.ts","max_files":1}
```

```json
{"query":"Which function removes expired cache entries?","path":"src/cache","max_files":3}
```
