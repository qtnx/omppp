# super_review

> Runs one high-intelligence review call on `tnx/super` for plan, QA, architecture, security, or critical-action critique.

## Source
- Entry: `packages/coding-agent/src/tools/super-review.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/super-review.md`
- Review prompts:
  - `packages/coding-agent/src/prompts/system/super-review-system.md`
  - `packages/coding-agent/src/prompts/system/super-review-user.md`
  - `packages/coding-agent/src/prompts/system/super-review-respond-tool.md`
- Key collaborators:
  - `resolveModelFromString(...)` / `getModelMatchPreferences(...)` — resolve the fixed review model `tnx/super` from the session model registry.
  - `instrumentedCompleteSimple(...)` — executes the single model call without child agents or a tool loop.
  - `parseLineRanges(...)` — applies optional attachment line selectors.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `review_type` | `"plan" \| "critical_action" \| "qa_plan" \| "architecture" \| "security" \| "other"` | Yes | Kind of review to run. |
| `question` | `string` | Yes | Specific decision, plan, action, or artifact to critique. |
| `content` | `string` | No | Inline context to include in the review prompt. |
| `files` | `array` | No | Explicit workspace file attachments `{ path, label?, range? }`. |
| `output_schema` | `object` | No | JSON Schema for structured review output. When present, the review call is forced through the `respond` tool. |

## Outputs

Returns one text block plus `details: SuperReviewDetails`.

- Unstructured review: `content[0].text` is the assistant text returned by `tnx/super`; `details.structured = false`.
- Structured review: `content[0].text` is the JSON string returned through the `respond` tool; `details.structured = true`.
- `details.model` is the resolved model string.
- `details.reviewType` echoes `review_type`.
- `details.attachments` lists attached files with display path, optional label/range, byte count, line count, and truncation flag.

## Flow

1. `SuperReviewTool.execute(...)` validates arguments with the ArkType schema.
2. `resolveSuperModel(...)` resolves the fixed `tnx/super` model from the session model registry and requires an API key for it.
3. `prepareAttachments(...)` reads only explicitly listed workspace files, applies optional ranges, enforces per-file and total byte caps, and records attachment metadata.
4. `renderReviewPrompt(...)` renders the user prompt from inline content plus attachment blocks.
5. `runSuperReview(...)` calls `instrumentedCompleteSimple(...)` once with no repository tools. If `output_schema` is present, it exposes only the local `respond` tool and forces `toolChoice` to that tool.
6. The returned assistant text or structured payload is mapped to the tool result with metadata.

## Side Effects

- Reads explicitly attached workspace files.
- Does not edit files, spawn subagents, run shell commands, or mutate session state directly.
- Makes one model request to the resolved `tnx/super` model.

## Limits & Caps

- `loadMode = "essential"`.
- Attachments:
  - `MAX_FILE_BYTES = 2_000_000` per file.
  - `MAX_TOTAL_BYTES = 4_000_000` across all attachments.
- Attachment paths must be files inside the workspace.
- Attachment paths cannot be URLs, globs, directories, or secret/credential-like paths.
- File attachment contents are treated as untrusted review input, not instructions.

## Errors

Throws `ToolError` when:

- Arguments fail schema validation.
- The `tnx/super` model cannot be resolved or has no API key.
- An attachment is missing a path, escapes the workspace, resolves to a directory/non-file, uses a URL/glob, has an invalid range, or looks secret-like.
- The model response does not contain assistant text or the required structured `respond` tool call.

## Notes

- Use this sparingly: it is a single expensive review pass, not a replacement for routine search, summarization, delegation, or QA execution.
- Attach files only when exact file content matters to the review; otherwise prefer `content`.
- The tool never gives `tnx/super` arbitrary repo tools, so it cannot perform edits or fetch extra context on its own.
