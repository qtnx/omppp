Drives real Chromium tab; full puppeteer access via JS execution.

<instruction>
- Static content (articles, docs, issues/PRs, JSON, PDFs, feeds)? Use `read` with the URL — reader-mode text without spinning up browser. Reach for browser only for JS execution, authentication, or interactive actions.
- Four actions:
  - `open` — acquire or reuse named tab (`name` defaults `"main"`). Optional `url` navigates after tab ready. Optional `viewport` sets dimensions. Optional `dialogs: "accept" | "dismiss"` auto-handles `alert`/`confirm`/`beforeunload` so navigation/clicks don't hang; by default dialogs are unhandled and the page hangs until you wire `page.on('dialog', …)`.
  - `close` — release tab by `name`, or every tab with `all: true`. For spawned-app browsers, set `kill: true` to terminate process tree (default leaves running).
  - `run` — execute JS against existing tab. `code` is body of async function with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. Function's return value JSON-stringified into tool result; multiple `display(value)` calls accumulate text/images.
  - `annotate` — overlay a human feedback UI on the tab: the user draws red boxes or uses **Pick** to select an element DevTools-style (hover highlights the element under the cursor; click marks its box), writes a comment, then hits "Send to agent". The floating toolbar can be dragged anywhere and minimized to a pill. If the named tab is missing or lives on a hidden headless browser, a **visible** browser is launched automatically with a fresh profile (pass `url` when no tab exists). The first call may wait up to `timeout` and return one submission directly. When session queue support is available (normal CLI sessions), annotation mode also registers a background listener, so later submissions are queued as `browser-annotation` messages and wake the agent even while idle; otherwise re-issue `{action:"annotate"}` to pull the next buffered submission. Submissions made while no agent is connected are saved in the page (survives reloads) and delivered automatically the next time annotation mode is enabled. `enabled: false` removes the overlay and stops background delivery; `wait: false` enables without blocking. Timing out is not an error — future submissions still arrive automatically when queue support exists; rects stay on the page.
- Tabs survive across `run` calls and in-process subagents — open once, reuse.
- Browser kinds (`app` field on `open`):
  - default (no `app`) → headless Chromium with stealth patches.
  - `app.path` → spawn absolute binary (Electron/CDP); a running instance with an open CDP port is reused. No stealth patches — NEVER tamper with a real desktop app.
  - `app.cdp_url` → connect to existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring matched against url+title to pick a BrowserWindow.
- `tab` helpers; drop to raw puppeteer `page` for anything they don't cover:
  - `tab.goto(url, { waitUntil? })` — navigate; clears element cache.
  - `tab.observe({ includeAll?, viewportOnly? })` — accessibility snapshot: `{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`. Ids stable until next observe/goto.
  - `tab.id(n)` — element id from last observe → `ElementHandle` (`.click()`, `.type()`, …).
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)`.
  - `tab.waitFor(selector)` — wait until attached; returns the `ElementHandle`.
  - `tab.drag(from, to)` — endpoints: selector (center-to-center) or `{ x, y }` viewport point (canvases, sliders).
  - `tab.scrollIntoView(selector)` — center element in viewport; use before clicking off-screen elements.
  - `tab.select(selector, …values)` — set `<select>` option(s); returns resulting selection. `tab.fill` NEVER works for selects.
  - `tab.uploadFile(selector, …filePaths)` — attach files to `<input type="file">`; paths relative to cwd.
  - `tab.waitForUrl(pattern, { timeout? })` — substring or `RegExp`; polls `location.href` (catches SPA pushState). Returns matched URL.
  - `tab.waitForResponse(pattern, { timeout? })` — substring, `RegExp`, or `(response) => boolean`; returns puppeteer `HTTPResponse` (`.text()`/`.json()`/`.status()`/`.headers()`).
  - `tab.evaluate(fn, …args)` — `page.evaluate` with abort signal wired; use for ad-hoc DOM reads.
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — capture and attach for viewing (`silent: true` skips). Pass `save` (a path) only when a later step needs the file.
  - `tab.extract(format = "markdown")` — Readability-extracted content (`"markdown"` | `"text"`); throws when nothing readable.
- Selectors: CSS plus puppeteer handlers `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`; Playwright-style `p-aria/…`, `p-text/…` normalized.
</instruction>

<critical>
- MUST `open` before `run` — `run` never creates a tab.
- Default to `tab.observe()` for page state — structured data with actionable element ids. Screenshot ONLY when visual appearance matters.
- Navigation invalidates element ids — re-observe before using them.
- `code` runs with full Node access. Treat as your code, not sandboxed code.
</critical>

<examples>
# Open a tab and read structured page data
`{"action":"open","name":"docs","url":"https://example.com"}`
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); display(obs); return obs.elements.length;"}`

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
Per call: `display(value)` outputs (text/images), then the JSON-stringified return value of `code`. `run` always produces at least a status line.
</output>
