# browser_jev eval — XLords

Measures whether one `browser_jev` call can finish a real game goal in one shot: drive the live XLords app, clear whatever blocks the page (modal, end-of-round gate, consent banner), and come back with a report the caller can trust.

## What a pass means

A task passes when the tool's own report shows the expected `status` **and** the task's evidence markers (a URL fragment, page-text excerpt, or step label), with no main-model hand-holding in between. That is the whole point of the tool: the calling model hands over a goal and reads one outcome.

A recorded `blocked` or `max_steps` is a legitimate result. It is written to the results file as a failure with the observed status and the reason the report named — never massaged into a pass, and never hidden.

`expect.needsRescue` marks tasks that are expected to need the helper rescue turn (a gate in front of the goal). When it is set, a run that finishes without spending a rescue turn is flagged, because it usually means the goal was easier than intended or the gate was not reached.

## Running

```bash
# what exists
bun run evals/browser-jev/run.ts --list

# the exact command for one task, without running it
bun run evals/browser-jev/run.ts --dry-run --task send-chat

# one real run against the live app
TYPESAFE_API_KEY=... bun run evals/browser-jev/run.ts --task send-chat --json

# a viewport slice, or the whole matrix
TYPESAFE_API_KEY=... bun run evals/browser-jev/run.ts --viewport mobile
TYPESAFE_API_KEY=... bun run evals/browser-jev/run.ts
```

Flags: `--list`, `--dry-run`, `--task <id>`, `--viewport <desktop|tablet|mobile|mobile-landscape>`, `--timeout <seconds>`, `--model <provider/model>`, `--profile <name>`, `--cwd <dir>`, `--json`.

Results land in `evals/browser-jev/results/<timestamp>.json` (full parsed reports) and a sibling `.md` table.

### Session and login

The browser daemon is scoped to the directory the CLI runs in, so the XLords login lives with that project directory — `--cwd` selects which one is reused. `--profile <name>` gives the run its own persistent browser (own cookies and login), which is what you want for a dedicated game account:

```bash
TYPESAFE_API_KEY=... bun run evals/browser-jev/run.ts --task claim-quest --profile xlords
```

`TYPESAFE_API_KEY` is read from the environment only. It is never written to a results file, a task, or a log.

## Adding a task

Add an entry to `tasks.ts`: an `id`, the `url`, a `goal` that states every literal value the flow needs (which building, which message, which quest), the `viewports` it is meaningful under, and an `expect` block with the status plus at least one evidence marker. Keep the goal explicit — the helper model that supplies typed values copies them from the goal and invents nothing.

## App notes (measured)

- The city is a PlayCanvas canvas inside `iframe /xlcanvas/index.html`. Sprite content has no DOM node of its own.
- The app ships its own accessibility mirror: `div#a11y-layer` contains real `<button data-a11y-mirror="element" data-a11y-id="building:castle" aria-label="Castle level 30, idle">` controls. They are invisible (`opacity: 0`) but clickable (`pointer-events: auto`), and their boxes are the building positions on the canvas.
- That mirror lives under `aria-hidden="true"`, so a plain accessibility snapshot sees almost nothing (2 controls). `browser_jev` observes with hidden controls included and therefore sees the full HUD and the building mirror (~81 controls) — that recovery is what makes these tasks possible at all.
- The game's `window` exposes no `A11Y`-named globals; the mirror is DOM-only. Assert on labels or `data-a11y-id`, not on window state.
