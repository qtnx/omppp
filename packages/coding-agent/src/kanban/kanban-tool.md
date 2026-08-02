Read and change this project's Kanban board. The board is shared by every OMPx session in this directory and is the operator's view of your work, so the board — not chat — is where task state and task conversation live.

## Operations

Each call takes `op` plus that op's fields.

|op|fields|does|
|---|---|---|
|`board`|—|Every column with its tasks.|
|`get`|`taskId`|One task, its comments, and any images embedded in its description, returned as real images.|
|`create`|`task`|Creates a task. `task` needs `title`, `status`, `priority`; may add `description`, `assignee`, `labels`, `dueAt`.|
|`update`|`taskId`, `patch`|Edits fields. `patch` needs `expectedVersion` plus only the fields you are changing.|
|`move`|`taskId`, `move`|Changes column/position. `move` needs `expectedVersion`, `status`, `index` (0 = top).|
|`delete`|`taskId`, `expectedVersion`|Removes a task. Prefer asking the operator to cancel instead.|
|`comment`|`taskId`, `comment`|Adds a comment; `comment` needs `body`. No author field — your session name is stamped for you.|
|`comments`|`taskId`|The comment thread.|

`status`: `backlog`, `ready`, `in_progress`, `blocked`, `review`, `done`, `cancelled`.
`priority`: `lowest`, `low`, `medium`, `high`, `highest`.
`dueAt`: RFC3339 UTC, e.g. `2026-08-09T17:00:00Z`, or `null` to clear.

`expectedVersion` is the task's current `version`. A mismatch fails with a version conflict: re-read with `get`, reconcile with whatever changed, then retry — never clobber a concurrent edit.

## How the board is worked

- **Comment to talk.** Questions, decisions, progress worth knowing, and completion notes go on the task as comments, so the operator can follow the work without reading your chat.
- **`backlog`** — a raw idea. Refine it: rewrite the description into problem, approach, files/interfaces, and acceptance criteria; comment any question or the option you recommend. Do not implement.
- **`ready`** — the operator's go-ahead. Move it to `in_progress` yourself and start.
- **`review`** — where you put finished work, with a comment on what changed and how you verified it.
- **`blocked`** — where you put work you cannot continue, with a comment saying exactly what you need.
- **`done` / `cancelled`** — the operator's calls. Never move a task to `done` yourself.

Tasks assigned to another session's board name are not yours; unassigned tasks are open to any session.
