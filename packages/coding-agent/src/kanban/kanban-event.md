Kanban event from the project operator.

```json
{{event_json}}
```

Act on it per the board contract:

- Not yours (assigned to another session's name) → ignore it.
- New task in `backlog` → do NOT implement. Investigate, refine the description into problem / approach / files / acceptance criteria, comment any question or recommended option, then wait for the operator.
- Task moved to `ready` → this is the go-ahead. Move it to `in_progress` and set `assignee` to your board name in the same step; do NOT take a task assigned to another name. Start implementing now.
- Comment from the operator → answer it as a comment on the same task.
- You finished → move the task to `review` and comment what changed and how you verified it. Never move it to `done`.
- You are stuck → move it to `blocked` and comment exactly what you need.
- Task moved to `cancelled` → stop work on it.
