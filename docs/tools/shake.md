# shake

> Schedules an end-of-turn context shake that elides stale bulky tool results or drops images from conversation history.

## Source
- Entry: `packages/coding-agent/src/tools/shake.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/shake.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/index.ts` — registers the tool via `ShakeTool.createIf(session)`, gated on `session.requestShake` being defined.
  - `ToolSession.requestShake` — session hook that schedules the actual shake pass.
  - `packages/coding-agent/src/session/shake-types.ts` — `ShakeMode` type (`"elide" | "images"`).
  - `packages/coding-agent/src/tools/compact.ts` — sibling tool for wholesale end-of-turn history archival instead of targeted elision.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | `"elide" \| "images"` | No | Shake mode; defaults to `"elide"`. `elide` replaces older bulky tool results and large fenced/XML blocks with `[shaken ~N tokens - recover: artifact://<id>]` placeholders. `images` drops all images from conversation history. |
| `reason` | `string` (1–500 chars) | Yes | Why shake is appropriate now — the phase or task transition. User-visible. |

## Outputs
Single-shot result.

- `details`: `{ mode: ShakeMode, reason: string, status: "scheduled" \| "already-scheduled", meta?: OutputMeta }`.
- `status: "already-scheduled"`: `content[0].text` = `"Shake already scheduled — it runs when the current turn ends. Do not call again."`
- `status: "scheduled"`: `content[0].text` = `"Shake scheduled. It runs automatically when this turn ends — finish in-flight work and yield. Older bulky tool results and large blocks may be replaced with artifact recovery links; images mode drops images."`

## Flow
1. `ShakeTool.execute()` reads `session.requestShake`; throws if the session does not support shaking.
2. Defaults `mode` to `"elide"` when omitted, then calls `requestShake(mode)`, which returns a `ToolShakeRequest` with a `status`.
3. `status === "unavailable"` → throws `ToolError` with the request's `detail`.
4. Otherwise returns a text result describing whether the shake was newly scheduled or was already pending.
5. The actual shake pass runs automatically right after the current turn ends — this tool only schedules it. Content dropped by `elide` remains recoverable via the `artifact://<id>` link in its placeholder.

## Side Effects
- Session state
  - Schedules an end-of-turn shake; dropped if the turn aborts.
  - `elide`: replaces bulky older tool results / large blocks with recoverable placeholders, keeping the durable payload accessible by artifact id.
  - `images`: strips all images from history (not selectively recoverable the same way).

## Limits & Caps
- `loadMode = "discoverable"`.
- Only registered when the session exposes `requestShake`.
- `reason` is capped at 500 characters.

## Errors
- Session does not support shaking → `ToolError("Shake is not available in this session.")`.
- Underlying request reports `unavailable` → `ToolError("Cannot shake: <detail>")`.

## Notes
- Use at a phase/task transition where older raw tool output is no longer needed, or under context pressure mid-task when wholesale `compact` is premature.
- Prefer `context_unload` (when available) for single-item targeted cleanup; `shake` is a broader elide/images pass.
- Do not use when details from old results are still needed verbatim — state them in a reply first.
