# jev_scout retrieval evals

Runs the real retrieval core against the configured Jev endpoint. It checks the returned file, declaration boundary, and verbatim local source; a related caller does not count as the expected implementation. The runner does not test an entire coding-agent conversation.

## Run

From the repository root:

```sh
bun evals/jev-scout/run.ts --suite session-compaction --list
bun evals/jev-scout/run.ts --suite session-compaction --repeat 3
bun evals/jev-scout/run.ts --suite ompx --repeat 3
bun evals/jev-scout/run.ts --suite xlords-backend --root /path/to/xlords-backend-game-server --repeat 3
bun evals/jev-scout/run.ts --suite xlords-frontend --root /path/to/xlords-web-fe --repeat 3
```

Other flags: `--task <id>` (repeatable), `--timeout <seconds>`, `--json`, `--detail <headers|outline|bodies>`. Default detail is `headers`. Any missed attempt produces exit code 1; a red eval is not a passing test suite.

Artifacts are `results/<suite>-<detail>-<timestamp>.json` and `.md`. They include source hashes, exact queries, hits, returned ranges, latency, token counts, and outbound state/outline byte and row counts. Neither source excerpts nor outbound payloads are persisted. Unique counts deduplicate identical serialized state or outline rows within an attempt. Older artifacts without exposure fields did not measure those fields; missing counts are not zero disclosure.

## Query guide

Ask for one action on one object, using the narrowest scope already known. Scout finds declarations; use `read` to explain their implementation afterward.

```json
{"query":"Which method accepts a compaction request from the agent?","path":"packages/coding-agent/src/session","max_files":3}
```

That directory query reached `requestCompactionFromAgent` in 3/3 recorded attempts. Once the implementation file is known:

```json
{"query":"Which method manually compacts the session context?","path":"packages/coding-agent/src/session/session-maintenance.ts","max_files":1}
```

The exact-file query passed 3/3; the same question at directory scope failed 3/3. Shorter wording alone is not a guarantee: action precision and an evidence-backed scope both matter. Do not invent a file path to narrow the query.

Do not combine scheduling, execution, summarization, and history replacement into one lookup. Do not repeat a failed call unchanged. A known symbol belongs in grep/LSP; an observed path and range belongs in `read`. Never increase source disclosure merely to force a match.

## Search and disclosure limits

- Default `headers` uses a native tree-sitter declaration index: names, kinds, and line ranges, including methods inside classes. It does not serialize signatures, literal values, imports, comments, or implementation bodies.
- Query text and paths relative to the chosen root are sent too. Names and paths can themselves be sensitive; this is reduced disclosure, not anonymity. The session redactor still runs before each request.
- Source is read locally with a 2 MiB limit. Parsed data files, unsupported syntax, and parse failures never fall back to raw source in default mode.
- Selected files are compared together. Rejected declaration pages advance without resending the same candidates; at most three location-ranking rounds run. Navigation requests are additional, with at most eight directory visits and the caller's `max_files` limit (default 3, range 1–8).
- Serialized redacted state is bounded to 32 KiB per request and 192 KiB per call. These bounds exclude fixed question instructions and response tokens. A larger native index is paged, not cut off before relevance ordering.
- `outline` explicitly permits unfolded source, including whole short files. `bodies` tries outlines first and may offer full bodies of files up to 400 lines after rejection, within the same ranking budget. `headers` never escalates.
- `no_match` is scoped, not proof of repository-wide absence. Inspect the partial flag and warnings.

## Reported-session regression

`session-tasks.ts` preserves all four original query strings from session `01a0bab7-a8d2-7028-a0e3-5892d9413885`, plus five focused variants and a negative control. Target declarations are pinned independently; they are not inferred from scout output.

Before this repair, `bun evals/jev-scout/session-baseline.ts` found only the entry tool. Directory lookup returned `no_match` (2 requests, 8,803 input tokens), exact AgentSession lookup returned `no_match` without a request, and exact SessionMaintenance lookup returned `no_match` (1 request, 4,405 input tokens). The current AgentSession was 524,594 bytes, 306 bytes over the old 512 KiB cap. Separately, the old outermost-fold summary hid class methods.

Accepted run: `results/session-compaction-headers-2026-09-19T18-14-31-998Z.json`:

- All three previously failing original lookups reached their exact expected methods: 9/9 attempts.
- The original entry query returned `CompactTool.execute:56-85` instead of the pinned whole class at line 35: 0/3 under the unchanged strict boundary criterion, although the returned handler is in the correct file and executes the request. This is retained as a scoring limitation, not silently counted as a pass.
- Full suite: **24/30**. The broad focused compaction-directory case still chose session-context helpers instead of the compaction method.

## Cross-corpus measurements

Same expected-file hashes in the historical and accepted runs; three attempts per case. These are in-sample measurements, not confidence intervals or an unseen-query accuracy guarantee.

| Suite | Historical headers | Accepted names-only headers | Total tokens, before / after |
| --- | --- | --- | --- |
| OMPx | 24/24 | 21/24 | 113,937 / 176,716 |
| XLords Go | 25/36 | 26/36 | 180,786 / 98,535 |
| XLords TS/TSX | 33/36 | 33/36 | 111,520 / 121,663 |

XLords combined: **58/72 to 59/72**, with 292,306 to 220,198 total tokens. The one-hit difference does not establish a statistical improvement. OMPx regressed on selecting the workspace-tree wrapper versus its helper; do not describe the repair as uniformly more accurate or cheaper.

Accepted artifacts:

- `results/ompx-headers-2026-09-19T18-14-28-450Z.json`
- `results/xlords-backend-headers-2026-09-19T18-14-32-131Z.json`
- `results/xlords-frontend-headers-2026-09-19T18-14-34-530Z.json`

A matching-name-only first-page experiment was removed: it reduced the session score to 18/30 and the Go score to 24/36. The `18-20-*` artifacts record that rejected experiment, not the accepted implementation. All declaration candidates remain eligible within the bounded pages.

Known misses remain visible: broad march/quest navigation, ambiguous item-grant and guild methods, and helper-versus-entry selection. No task was changed to turn these misses green. The focused variants were refined while designing the query guide; the four original session queries and existing OMPx/XLords ground truth remain unchanged.

## Deterministic verification

```sh
bun test packages/natives/test/source-declarations.test.ts packages/coding-agent/test/jev-scout.test.ts
```

These tests use deterministic fake Jev responses with the real native parser and tool boundary. They cover late class methods, disjoint pages, malformed/data-file exclusion, one-line and computed-name canaries, session query redaction, explicit body-mode rejection/retry, and request/cumulative state budgets. Live retrieval accuracy is measured separately by the evals above.
