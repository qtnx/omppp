Schedules a context shake to run after the current turn ends.

What it does:
- `elide` (default): replaces older bulky tool results and large fenced/XML blocks with `[shaken ~N tokens - recover: artifact://<id>]` placeholders. Use the artifact link to recover exact content later.
- `images`: drops all images from conversation history.

Scheduling semantics:
- This tool only schedules the shake. It runs right after the current turn ends.
- The scheduled shake is dropped if the turn aborts.

When to use:
- At a phase or task transition where older raw tool output is no longer needed.
- During context pressure mid-task when wholesale `compact` is premature.

When not to use:
- Details from old results are still needed verbatim; state them in a reply first.
- For targeted single-item cleanup, prefer `context_unload` when available.
- At a real boundary with nothing pending, prefer `compact`.

`reason` is user-visible. Name the transition clearly.
