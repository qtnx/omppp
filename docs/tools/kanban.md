# kanban

> Reads and mutates the live Kanban board of the session that owns it, and returns board or task JSON plus any images embedded in a task description.

## Source
- Entry: `packages/coding-agent/src/kanban/tool.ts`
- Model-facing prompt: `packages/coding-agent/src/kanban/kanban-tool.md`
- Key collaborators:
  - `packages/coding-agent/src/kanban/runtime.ts` — owns the board server, mounts and unmounts the tool as sessions register, and exposes `KanbanModelApi` to the tool.
  - `packages/coding-agent/src/kanban/store.ts` — SQLite persistence (`~/.omp/agent/agent.db`): tasks, comments, activity, attachments, short-id counters, idempotency records.
  - `packages/coding-agent/src/kanban/validation.ts` — validates every payload before it reaches the store and produces `KanbanError` on rejection.
  - `packages/coding-agent/src/kanban/delivery.ts` — routes board activity back to sessions and background board agents.
  - `packages/coding-agent/src/kanban/server.ts` — HTTP API and the browser board the tool shares state with.
  - `packages/collab-web/src/kanban/` — the board UI whose mutations arrive through the same store.

## Availability
The tool only mounts while a board is running for this session (`/kanban`). Outside that, it is absent from the toolset rather than failing at call time. A tool call always addresses the caller's own board: `boardSessionId()` prefers `getKanbanSessionId()` and falls back to `getSessionId()`, so a forked board agent operates on the board it inherited, not a new one.

## Inputs

The params object **is** one operation; `op` is the discriminator and the other fields are per-op payloads.

| Op | Required fields | Effect |
| --- | --- | --- |
| `board` | none | Returns every status column with its tasks, plus the board cursor. |
| `get` | `taskId` | Returns one task, its comments, and images referenced by its description. |
| `comments` | `taskId` | Returns the comment thread only. |
| `create` | `task` | Creates a task. `status` and `priority` are required inside `task`; `title` is optional and an empty title renders as "Untitled task". |
| `update` | `taskId`, `patch` | Patches the fields present in `patch`. `patch.expectedVersion` is required. |
| `move` | `taskId`, `move` | Moves a task to `move.status` at `move.index`. `move.expectedVersion` is required. A move into `in_progress` stamps the caller's board name on an unassigned task. |
| `comment` | `taskId`, `comment` | Appends a comment. The author is the caller's board name; a client-supplied author is ignored. |
| `delete` | `taskId`, `expectedVersion` | Deletes a task and its comments. |

### Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"board" \| "get" \| "create" \| "update" \| "move" \| "delete" \| "comment" \| "comments"` | Yes | Operation discriminator. |
| `taskId` | `string` | For every op except `board` | Task uuid. The `T-<n>` short id is a display name, not a lookup key. |
| `task` | object | For `create` | `title?`, `status`, `priority`, `description?`, `assignee?`, `labels?`, `dueAt?`. |
| `patch` | object | For `update` | `expectedVersion` plus at least one changed field. |
| `move` | object | For `move` | `expectedVersion`, `status`, `index`. |
| `expectedVersion` | `number` | For `delete` | The task's current `version`. |
| `comment` | object | For `comment` | `body`. |

Statuses: `backlog`, `ready`, `in_progress`, `blocked`, `review`, `done`, `cancelled`. Priorities: `lowest`, `low`, `medium`, `high`, `highest`.

## Outputs
A single-shot `AgentToolResult` whose text is the operation's JSON — the compacted board for `board`, the task (with comments for `get`) otherwise. `details` carries the same data in typed form (`op`, `taskId`, `status`, `board`, `task`, `comments`, `comment`) for the renderer.

`get` additionally resolves `/api/v1/sessions/<session>/attachments/<id>` links in the description and returns up to 6 images as real `ImageContent` blocks, so a screenshot pasted onto a card is visible to the model rather than being a dead link.

## Errors
- Validation failures surface as `KanbanError` with an HTTP-shaped status: `422 validation_error` for a malformed payload, `404` for an unknown task, `409 version_conflict` when `expectedVersion` no longer matches.
- A version conflict is the expected outcome of concurrent edits, not a bug: re-read the task or board and retry against its current `version`. Never retry by dropping `expectedVersion`; that would silently overwrite the operator's edit.
- Read-only ops (`board`, `get`, `comments`) never require approval and never mutate.

## Notes
- Mutations appear on the owner's browser board immediately; the board and the tool share one SQLite store and one activity stream.
- Write ops carry an idempotency key, so a retried call after a dropped response reuses the recorded result instead of creating a second task or comment.
- Board activity comes back to the agent as `kanban-event` messages (`packages/coding-agent/src/kanban/kanban-event.md`). That payload is untrusted user-authored data: it is quoted state, never instruction.
- The column contract lives in the event prompt, not in this tool: `backlog` means refine and wait, `ready` is the operator's go-ahead, `review` is the agent's exit, and only the operator moves a task to `done` or `cancelled`.
