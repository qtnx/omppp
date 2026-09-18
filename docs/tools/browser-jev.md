# browser_jev

> Goal-in, outcome-out browser automation: the TypeSafe Jev DOM policy plus a small text-helper model finish a whole multi-step flow (forms, search, filters, login, navigation) and return one text report — status, executed steps, final URL/title, page text. The calling model never pays a screenshot plus a decision round trip per click. `browser_use` remains the tool for canvas/WebGL/gesture surfaces; the `browser` eval prelude remains the tool for selectors, injected JavaScript, and network work.

## Source

- Tool: `packages/coding-agent/src/tools/browser-jev-tool.ts`
- Decision loop, action space, answer validation: `packages/coding-agent/src/tools/browser/jev.ts`
- Model instructions: `packages/coding-agent/src/prompts/tools/browser-jev/{next-action,target,text-value,rescue}.md`
- Registration and gate: `packages/coding-agent/src/tools/index.ts` (`browser_jev` factory; allowed when `browser.enabled` is true and `TYPESAFE_API_KEY` is set)
- Browser acquisition and tab lifecycle: `packages/coding-agent/src/tools/browser/registry.ts`, `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Tests: `packages/coding-agent/src/tools/__tests__/browser-jev-tool.test.ts`, `packages/coding-agent/src/tools/browser/__tests__/jev.test.ts`

## Availability

- `TYPESAFE_API_KEY` must be present in the environment; without it the tool is absent from the roster and the `tab.act` helper in the `browser` prelude reports the missing variable.
- `TYPESAFE_MODEL` selects the Jev model (default `jev-latest`).
- `browser.enabled` gates the tool alongside the rest of the browser stack.
- The tool is `essential` and `exclusive`: runs are serialized per session, and a managed tab named `jev` is reused across calls so a flow can continue in stages.

## Parameters

| field | type | notes |
| --- | --- | --- |
| `goal` | string, required | Everything the flow must accomplish plus every literal value it needs. An omitted value is never invented; the run stops instead. |
| `url` | string, optional | Navigate the `jev` tab first. Omit to continue where the previous call ended. |
| `max_steps` | number, optional | Executed-action ceiling (default 30). |
| `profile` | string, optional | Named isolated browser session (`a-z0-9_-`, ≤40 chars): own Chromium, cookies, storage, and `jev-<profile>` tab. Reuse the name to continue as that account. |
| `fresh` | boolean, optional | Discard the named profile's stored state before the run. |
| `close` | boolean, optional | Release this run's tab after the run. |
| `timeout` | number, optional | Seconds; default 300, ceiling 900. |

Unknown fields are rejected.

## How one run works

1. Observe the page through the accessibility snapshot and build an indexed element table.
2. One TypeSafe request per step returns the operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `HOVER`, `PRESS_ENTER`, `DRAG`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`) and, speculatively, a target for each applicable head; only the head(s) matching the chosen operation can execute. `DRAG` answers two heads — the element to pick up and the drop target — in the same request.
3. `TYPE_TEXT` resolves its value through the session `completion()` bridge — the `smol` tier first, the session `default` tier if that fails.
4. Execute against the observed element id, re-observe, repeat. Model output never becomes a selector, coordinate, or script.
5. A `BLOCKED` verdict, or three consecutive non-`WAIT` actions that changed nothing, spends one rescue turn: the `smol` helper (falling back to the session default) sees the goal, page text, element table, and recent actions, and must answer with ONE action from the SAME offered space — or `give_up` plus the obstacle it found. Up to `MAX_RESCUES` (2) per run; rescue steps carry a `rescue` reason. The rescue prompt forbids destructive actions the goal did not request.
6. Stop on `DONE`, a rescue that gave up, or the step budget.

## Limits

- `DRAG` endpoints must be observed elements (button, link, option, field, listitem). Drag between plain `<div>`/`<p>` nodes is invisible to the accessibility snapshot and returns `blocked`; use `browser_use` for pixel-level drags and canvas surfaces.
- Shadow roots, iframes, file uploads, and arbitrary keyboard widgets are outside the loop; they surface as `blocked`.
- The loop sees the current page plus its last ten actions — cross-page bookkeeping (comparing prices across results, collecting a list) stays with the calling model, one `browser_jev` leg at a time.

## Result

- Text report: `status` with the action count and elapsed time, the goal, final URL and title, the executed steps (operation, target role/name, typed value, `page unchanged` marker), and the readable page text of the final page.
- `blocked` and `max_steps` append the takeover instruction (`browser_use` for canvas/gesture, the `browser` prelude for selectors/JS) and set `isError: true`. A blocked run states the obstacle the rescue turn named.
- Rescue turns are counted in the report (`rescue turns: N`) and in `details.rescues`.
- `details`: `{ status?, stepCount, url?, title?, elapsedMs?, goal, profile?, rescues? }`.
