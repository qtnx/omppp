Locate the one declaration that implements a behavior when you know what the code does but not its name or file.

<instruction>
- Routing:
  - Behavior known, name and file unknown → this tool, before guessed `grep` keywords.
  - Exact name or text → `grep`/`lsp`. Known file and lines → `read`. A whole flow → locate its pieces here, then `read` them.
  - `codegraph_explore` absent, unindexed, still indexing, or off-target → this tool for the lookup. NEVER install CodeGraph or build its index to answer one.
- Query:
  - Shape: `Which function/method <verb> <object> [<one distinguishing condition>]?` Types too: `Which interface describes <data>?`
  - Each call returns ONE declaration. One behavior per query; split multi-stage investigations into separate calls and run independent calls in parallel.
  - Use the verbs and nouns the code likely puts in names; the pick follows them. Scoped to one file, "refreshes one stored OAuth credential" picked `refreshStoredOAuthCredential`, while "…before a request is sent" picked `prepareOAuthCredentialForRequest`.
  - Add a condition only when it distinguishes the target from its siblings.
  - Keep code terms in English, even when the conversation is not.
- Scope (`path`):
  - Scope decides success more than wording. Pass the narrowest directory or file your evidence supports: the owning package's `src`, a feature directory, one file. NEVER invent a path.
  - Repository root and wide containers (`packages`, a monorepo's top level) usually end in `no_match` after the first listing.
  - Known file, unknown name — especially a file too large to read → pass the file with `max_files: 1`. One request, about half a second.
  - Each directory level costs one request (~0.4 s); most hits take 1–3 requests.
- `max_files` (default 3, max 8): files read before their declarations are compared. Wide directory of similar files → 6–8. File `path` → 1.
- `timeout` defaults to 60 seconds; a timeout means the scope is too broad.
</instruction>

<output>
- `found`: one excerpt (≤100 line-numbered lines), `Note:` lines, a `Scope:` line (directories and files inspected, partial or not), and Jev usage.
- A hit is a ranked guess. You MUST confirm the excerpt does what you asked; a caller, wrapper, or sibling of the target means re-query with the verb and object the excerpt suggests, or `read` around it.
- `no_match`: nothing selected inside the inspected scope. NEVER treat it as proof of absence.
- After `no_match` or an off-target hit, change exactly one input:
  1. `Scope:` shows 1 directory and 0 files → the start was too high; pass the owning package or feature directory.
  2. A note says a directory, file-read, or ranking budget was reached → narrow `path` or raise `max_files`.
  3. Otherwise reword with vocabulary from listings or excerpts you already saw.
- Two refinements without a hit → `grep` for the likely names. NEVER repeat a call unchanged.
- Read-only: `read` the returned range for fresh anchors before editing.
</output>

<avoid>
- Bare identifiers (`"awaitQueryReadiness readinessTimeoutMs"`): known names → `grep`.
- Topics (`"codegraph bug"`): name the behavior instead.
- Bundles (`"Which functions build, sync, and query the index, and how do they handle errors?"`): one call per behavior.
- Repository root as `path` when you know the package.
</avoid>

<caution>
- Sent to the configured Jev endpoint: the query, paths relative to `path`, and file outlines at the user's `signals.scoutSourceDetail` level. `headers` (default) sends declaration names, kinds, and line ranges — no signatures, comments, imports, literals, or bodies. Names and paths can still be sensitive; session secret redaction applies. Excerpts are read locally and never sent back.
- Only the user can raise disclosure: `outline` unfolds source, including whole short files; `bodies` adds full bodies of short files after a miss. NEVER try to force more source out of a miss.
- Source code only: JSON, YAML, Markdown, and other data files are skipped unless the user chose `bodies`; gitignored and hidden paths only when passed as the exact `path`. Unparseable files give partial coverage.
</caution>

<examples>
Behavior inside a known package:
```json
{"query":"Which method waits for the CodeGraph index before running an explore query?","path":"packages/coding-agent/src"}
```
Unknown method in a 12k-line file:
```json
{"query":"Which method formats the parent conversation as bounded context for subagents?","path":"packages/coding-agent/src/session/agent-session.ts","max_files":1}
```
Wide directory of similar files:
```json
{"query":"Which method schedules the spinner animation for a running tool call?","path":"packages/coding-agent/src/modes/components","max_files":8}
```
Two stages, two parallel calls:
```json
{"query":"Which method accepts a compaction request from the agent?","path":"packages/coding-agent/src/session"}
```
```json
{"query":"Which function replaces session history with a compaction summary?","path":"packages/coding-agent/src/session"}
```
</examples>

<critical>
- One behavior per call, the narrowest evidenced `path`, the code's own verbs and nouns.
- Known name or text → `grep`; known lines → `read`.
- Confirm every hit; `no_match` is not absence.
- Refine by changing one of `path`, `max_files`, or wording — at most twice — then `grep`.
</critical>
