Read and mutate the Kanban board for this session only.

- `board` lists every status column and its tasks.
- `get` returns one task with its comments; `comments` returns task comments.
- `create` requires `task`; `update` requires `taskId` + `patch`; `move` requires `taskId` + `move`; `delete` requires `taskId` + `expectedVersion`; `comment` requires `taskId` + `comment`.
- Mutations appear immediately on the owner's browser board.
- `expectedVersion` is required in `patch` for `update`, in `move` for `move`, and directly for `delete`.
- Conflict? Re-read the board or task, then retry with its current `version`.
- Status values: `backlog | ready | in_progress | blocked | review | done | cancelled`.
