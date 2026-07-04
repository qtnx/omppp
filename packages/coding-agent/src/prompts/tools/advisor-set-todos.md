Replace the session todo list when the executor's plan has drifted from the advisor brief.

Use this tool to reprioritize, reorder, split, or repair todos so the active work matches the mission brief and current user request. The current todo list arrives in the session delta; treat it as state you must preserve unless there is a clear reason to change it.

Rules:
- Submit every phase in the desired final order.
- Submit every item in the desired final order with one status: `pending`, `in_progress`, `completed`, or `abandoned`.
- Never silently drop non-completed items. Carry them forward or mark them `abandoned` with intent.
- Do not clear the list; an empty `phases` array is rejected.
- Prefer one `in_progress` item that names the executor's current focus.

The change is persisted as a `user_todo_edit` custom entry so it survives compaction and resume.