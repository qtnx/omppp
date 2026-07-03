# compact

> Schedules an end-of-turn archival of older conversation history to free context space, keeping recent messages intact.

## Source
- Entry: `packages/coding-agent/src/tools/compact.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/compact.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/index.ts` — registers the tool via `CompactTool.createIf(session)`, gated on `compaction.strategy !== "off"` and `session.requestCompaction` being defined.
  - `ToolSession.requestCompaction` — session hook that schedules the actual archival (LLM-summary or snapcompact-image strategy, per settings).
  - `packages/coding-agent/src/tools/shake.ts` — sibling tool for targeted mid-task elision instead of wholesale archival.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `reason` | `string` (1–500 chars) | Yes | Why compaction is appropriate now — the boundary just reached. User-visible. |

## Outputs
Single-shot result.

- `details`: `{ reason: string, status: "scheduled" \| "already-scheduled", meta?: OutputMeta }`.
- `status: "already-scheduled"`: `content[0].text` = `"Compaction already scheduled — it runs when the current turn ends. Do not call again."`
- `status: "scheduled"`: `content[0].text` = `"Compaction scheduled. It runs automatically when this turn ends — finish in-flight work and yield. Recent messages survive; older history is archived."`

## Flow
1. `CompactTool.execute()` reads `session.requestCompaction`; throws if the session does not support compaction.
2. Calls `requestCompaction(params.reason)`, which returns a `ToolCompactionRequest` with a `status`.
3. `status === "unavailable"` → throws `ToolError` with the request's `detail`.
4. Otherwise returns a text result describing whether compaction was newly scheduled or was already pending.
5. The actual archival pipeline (LLM summary or snapcompact image frames, per `compaction.strategy`) runs automatically right after the current turn ends — this tool only schedules it, it does not compact synchronously.

## Side Effects
- Session state
  - Schedules end-of-turn compaction; dropped if the turn is aborted before it runs.
  - Archives the whole older conversation history (coarse, turn-boundary granularity) — not a selective unload of specific items.

## Limits & Caps
- `loadMode = "discoverable"`.
- Only registered when `compaction.strategy !== "off"` and the session exposes `requestCompaction`.
- `reason` is capped at 500 characters.
- The request is a no-op/rejected by the runtime if little substantial work happened since the last compaction (a genuine no-op is not honored as "scheduled" — treat repeated no-op calls as a signal to stop calling).

## Errors
- Session does not support compaction → `ToolError("Compaction is not available in this session.")`.
- Underlying request reports `unavailable` → `ToolError("Cannot compact: <detail>")`.

## Notes
- Call as the LAST action of a turn — never call and then continue heavy work in the same turn, since compaction has not run yet.
- Never call mid-task when exact details from earlier messages (line numbers, hashes, diffs, error text) are still needed, or while unresolved failures are under active investigation, or in a turn that leaves a question/approval pending.
- For targeted removal of specific stale tool results while continuing the same task, prefer `shake` (or `context_unload` when available) instead of wholesale `compact`.
- At most one call per turn; a "scheduled" result is already recorded, don't re-call.
