Drive real Chromium tabs from JavaScript or Python Eval with the global `browser` object.

<instruction>
- Static content? Use `read`. Use `browser` for JavaScript execution, authenticated sessions, and interactive actions.
- JavaScript: `await browser.open(options)` returns a `BrowserTab`; `browser.tab(name)` returns an existing handle; `await browser.close(options)` releases tabs.
- Python: `await browser.open(name=…, url=…)`, synchronous `browser.tab(name)`, and `await browser.close(name=…)`. Python methods accept keyword arguments.
- `annotate`: overlay human feedback UI on tab. User draws red boxes or uses **Pick** to select element DevTools-style, writes comment, then sends. Toolbar draggable/minimizable. Missing or hidden-headless tab auto-launches visible browser with fresh profile; pass `url` when no tab exists. First call may wait up to `timeout` and return submission. Normal CLI sessions queue later submissions as `browser-annotation` messages; otherwise call annotate again. Pending submissions survive reload and deliver when mode re-enabled. `enabled: false` removes overlay; `wait: false` enables without blocking. Timeout is not an error; future submissions still arrive.
- `open` options: `name`, `url`, `app`, `viewport`, `wait_until`, `dialogs`, `timeout`, `persist`, `profile`, `fresh`.
- `profile: "<name>"` gives that tab its OWN browser session — separate cookies, storage, and login — so several accounts can be driven side by side; reuse the same name to return to that logged-in session, and pass `fresh: true` to wipe it first. Tabs opened without a profile share the default session. One tab name belongs to one profile: use `acct-a`/`acct-b` style names for both.
- `close` options: `name`, `all`, `kill`, `timeout`.
- Direct tab helpers:
  - Navigation: `url`, `title`, `goto`.
  - Inspection: `observe`, `ariaSnapshot`, `screenshot`, `extract`.
{{#if jev}}
  - Goal-driven: `tab.act(goal, { maxSteps? })` — DEFAULT for multi-step DOM interaction (forms, search, login, filters, navigation). TypeSafe Jev observes the page, picks one operation and one observed element per step (CLICK / TYPE_TEXT / SCROLL / WAIT), and loops until `status` is `done`, `blocked`, or `max_steps` (default 30). Returns `{ status, steps: [{ operation, target: { id, role, name }, text?, pageChanged, url }], url, title, elapsedMs }`. Put every requirement and every value in `goal`; a small helper model derives typed text from it and never invents personal data. `done` is Jev's claim, not proof: verify with `observe`/`extract` afterwards. Fall back to manual helpers when Jev returns `blocked`, for canvas/iframe/shadow-root widgets, or for one obvious click.
  - Whole goal, no eval cell needed: the `browser_jev` tool runs the same policy from a tool call and returns one text report (status, steps, final URL, page text). Prefer it when the entire flow is the task; use `tab.act` when you are already scripting around it in an eval cell.
{{/if}}
  - Interaction: `click`, `type`, `fill`, `press`, `scroll`, `drag`, `scrollIntoView`, `select`, `uploadFile`.
  - Waiting: `waitFor`, `waitForSelector`, `waitForUrl`.
  - Page execution: `evaluate`. `tab.evaluate(string)` evaluates the string as a page-global expression; top-level `return` is invalid. Pass a function or invoke an IIFE string to use `return`.
- `tab.id(n)` / `tab.ref("e5")` return `BrowserElement` handles supporting `click`, `type`, `fill`, `press`, `hover`, `focus`, `select`, `uploadFile`, `scrollIntoView`, `boundingBox`, `isVisible`, `isHidden`, and `evaluate`. A string passed to `BrowserElement.evaluate` is a function expression invoked with the element as its first argument.
- JavaScript `await tab.run(fnOrCode, { args?, timeout? })` runs a function or code string. Functions receive `{ tab, page, browser, wait, assert }`; cell closures are not captured. Plain data, functions, and `RegExp` values are supported in `args`.
- Python `await tab.run(code, timeout=…)` accepts a JavaScript code string only. Direct Python helpers use the same method names; keyword arguments become a trailing JavaScript options object.
- `tab.run` executes in an isolated JavaScript tab runtime with raw Puppeteer `page`/`browser`, ordinary Eval helpers, and full Bun/Node + tool-bridge access. It is not sandboxed.
- Direct helpers and `tab.run` return real structured values. Nonempty inner `display` text prints in the outer Eval cell; screenshots surface as Eval images.
- Selectors accept CSS plus Puppeteer `aria/…`, `text/…`, `xpath/…`, and `pierce/…` query handlers.
- Navigation and re-renders invalidate observed ids and refs. Re-observe, then act in the same cell.
- Use `tab.select` for `<select>` elements; `tab.fill` does not support them.
- Raw request interception lasts only for the current `tab.run`.
- Application modes:
  - Omit `app` for default automation; no executable path required. Managed Chromium installs automatically on first use.
  - `app.path`: launch the specified browser or Electron executable. Chromium-family browsers use an OMPx-owned profile unless `args` supplies `--user-data-dir`.
  - `app.cdp_url`: attach to an existing CDP endpoint.
  - `app.relay: true`: drive the user's Chrome through the OMPx relay. `app.target` selects a tab by URL/title substring; without it, the visible tab is adopted. Opening with `url` navigates that adopted tab.
- Relay sessions are the user's real logged-in browser. Sites attribute actions to the user. Name a target or create a dedicated tab; NEVER navigate the visible tab without authorization.
- Closing releases the managed tab. It never closes relay/CDP-attached pages. `kill: true` terminates only applications spawned by this process, never reused browser processes.
- Idle tabs auto-freeze at turn settle (animated pages stop burning CPU/GPU) and unfreeze on next use; tabs idle past the idle-close timeout are closed. Pass `persist: true` on `open` to keep a tab live across turns (e.g. multi-step login); `browser.close` still releases explicitly.
</instruction>

<examples>
```javascript
const tab = await browser.open({ name: "docs", url: "https://example.com" });
const observed = await tab.observe();
await tab.id(observed.elements[0].id).click();
const title = await tab.run(async ({ tab }, suffix) => (await tab.title()) + suffix, { args: ["!"] });
await tab.close();
```

```python
tab = await browser.open(name="docs", url="https://example.com")
observed = await tab.observe()
await tab.id(observed["elements"][0]["id"]).click()
title = await tab.run("return await tab.title();", timeout=30)
await tab.close()
```
</examples>

<critical>
- MUST open a tab before direct use; `browser.tab(name)` does not open one.
- Default to {{#if jev}}`tab.act(goal)` for multi-step interaction and {{/if}}`tab.observe()`{{#if jev}} for inspection{{/if}}; use screenshots for visual confirmation.
- `tab.run` has full Bun/Node and tool-bridge access; it is not sandboxed.
- Relay and CDP actions operate on real user sessions.
</critical>

<examples>
# Open a tab and read structured page data
`{"action":"open","name":"docs","url":"https://example.com"}`
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); display(obs); return obs.elements.length;"}`
{{#if jev}}

# Drive a multi-step flow by goal (Jev), then verify the outcome yourself
`{"action":"run","name":"docs","code":"const r = await tab.act('Search for \"wireless headphones\" and open the first result'); display(r.status, r.steps.length); return (await tab.observe()).url;"}`
{{/if}}

# Click an observed element by id
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'Sign in link missing'); await (await tab.id(link.id)).click();"}`

# Screenshot to look at the page — no save path
`{"action":"run","name":"docs","code":"await tab.screenshot();"}`

# Keep a full-page screenshot on disk for a later step
`{"action":"run","name":"docs","code":"await tab.screenshot({ fullPage: true, save: 'screenshot.png' });"}`

# Fill and submit a form via selectors
`{"action":"run","name":"docs","code":"await tab.fill('input[name=email]', 'me@example.com'); await tab.click('text/Continue');"}`

# Attach to an existing Electron app
`{"action":"open","name":"cursor","app":{"path":"/Applications/Cursor.app/Contents/MacOS/Cursor"}}`

# Ask for human visual feedback
`{"action":"annotate","name":"main","timeout":120}`

# Ask for human visual feedback on a fresh page (auto-launches a visible browser)
`{"action":"annotate","name":"review","url":"http://localhost:3000","timeout":300}`

# Close one tab (browser stays alive if other tabs reference it)
`{"action":"close","name":"docs"}`

# Close every tab; leave spawned apps running
`{"action":"close","all":true}`

# Close every tab and kill spawned-app processes too
`{"action":"close","all":true,"kill":true}`
</examples>
<output>
Per call: `display(value)` output, then `code`'s return value. `run` always produces at least a status line.
</output>
