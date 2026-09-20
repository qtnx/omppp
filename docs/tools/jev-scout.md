# jev_scout

> Locate a declaration by describing the behavior, when its name is unknown.

## Source
- Entry: `packages/coding-agent/src/tools/jev-scout.ts` (`JevScoutTool`)
- Retrieval core: `packages/coding-agent/src/jev/scout.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/jev-scout.md`
- Navigation/ranking prompts: `packages/coding-agent/src/prompts/jev/scout-*.md`
- Registration and availability gate: `packages/coding-agent/src/tools/index.ts`
- Declaration index: `crates/pi-ast/src/summary.rs` (`sourceDeclarations`)

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | One action on one object; include the relevant domain. |
| `path` | string | No | File or directory to search. Defaults to the working directory. |
| `max_files` | integer 1-8 | No | Maximum files inspected. Default 3. |
| `timeout` | number > 0 | No | Overall timeout in seconds. Default 60, clamped by `tools.maxTimeout`. |

## Outputs
- Returns the selected excerpts as `path:startLine-endLine` with line-numbered local source, followed by any warnings.
- Reports the searched scope (directories visited, files read, whether the scope was partial) and Jev usage (requests, input and output tokens).
- `details` carries the full `ScoutResult`, including `status`, `excerpts`, `warnings`, and `truncated`.
- No match returns `no_match` for the searched scope; that is not proof of absence elsewhere in the repository.
- Invalid arguments, timeouts, and retrieval failures raise `ToolError`; an aborted call raises `ToolAbortError`.

## Flow
1. Resolve `path` against the session working directory.
2. Build a native tree-sitter declaration index for candidate files: names, kinds, and line ranges, including methods inside classes.
3. Ask Jev to navigate directories and rank declaration pages, bounded by at most three ranking rounds, eight directory visits, and `max_files`.
4. Read the selected ranges locally and return them verbatim.

## Disclosure and limits
- Default `headers` detail sends declaration names, kinds, and line ranges plus the query and paths relative to the chosen root. It does not send signatures, literal values, imports, comments, or bodies.
- `signals.scoutSourceDetail` may raise this to `outline` or `bodies`, which permit unfolded source; `headers` never escalates on its own.
- The session secret redactor runs on outbound text before every request.
- Serialized state is bounded per request and per call; a larger index is paged rather than cut before relevance ordering.
- Source is read locally with a size limit. Parsed data files and parse failures never fall back to raw source in the default mode.

## Availability and approval
- Tool name: `jev_scout`.
- Essential and available only when a Jev (TypeSafe signals) endpoint is configured.
- Requires read approval; the tool never writes.
- Available to read-only subagents, which remain read-only.

## Use
Use it when you can describe the behavior but not name the symbol. A known symbol belongs in `grep` or LSP; an observed path and range belongs in `read`. Narrow `path` to a directory or file you have evidence for rather than guessing one, and do not repeat a failed call unchanged.
