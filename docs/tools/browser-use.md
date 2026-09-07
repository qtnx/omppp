# browser_use

> Screenshot-driven pointer/keyboard control of a managed headless Chromium tab at a fixed 1280x720 viewport, in the OpenAI Computer Use action vocabulary. For canvas/WebGL games and graphic UIs where DOM selectors fail; `browser` remains the tool for text, selectors, and JS.

## Source
- Entry: `packages/coding-agent/src/tools/browser-native-computer.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/browser-use.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/browser/tab-supervisor.ts` — owns the `browser_use` tab; every action runs as a `run` cell in it.
  - `packages/coding-agent/src/tools/browser/registry.ts` — acquires the browser handle for the resolved browser kind.
  - `packages/coding-agent/src/tools/browser.ts` — `resolveBrowserKind()` picks shared/headless/relay Chromium the same way `browser` does.
  - `packages/ai/src/types.ts` — `ComputerAction` (the native OpenAI action union) and `ComputerToolCallMetadata`.
  - `packages/ai/src/providers/openai-codex-responses.ts` / `openai-responses-server.ts` — serialize the tool as `{type:"computer"}` when the model supports native computer use, otherwise as an ordinary function tool.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | No | Open this page in the tool's tab before running `actions`. The only way to navigate: headless Chromium has no address bar, so Ctrl+L / typing a URL does nothing. |
| `actions` | `Action[]` | No | Ordered actions executed in the tab. Omitting both fields returns a screenshot of the current state. |
| `pending_safety_checks` | `unknown[]` | No | Native computer-use safety checks. Any non-empty list rejects the call until explicitly approved. |

Unknown top-level fields are rejected (`"+": "reject"`).

### Action shapes

| `type` | Required fields | Notes |
| --- | --- | --- |
| `navigate` | `url` | Tool-local extension of the native vocabulary; same as top-level `url`, usable mid-sequence. |
| `click` | `x`, `y` | Optional `button`: `left` (default), `right`, `wheel`, `back`, `forward`. |
| `double_click` | `x`, `y` | |
| `move` | `x`, `y` | Hover only. |
| `drag` | `path: {x,y}[]` | Mouse down at the first point, move through the rest, mouse up at the last. |
| `scroll` | `x`, `y`, `scroll_x`, `scroll_y` | Wheel deltas in pixels at the pointer position. |
| `keypress` | `keys: string[]` | Playwright key names; several entries are pressed as one chord (`["Control","a"]`). |
| `type` | `text` | Types into the focused element. |
| `wait` | — | 500 ms pause. |
| `screenshot` | — | Capture without acting. |

Coordinates are viewport pixels (0–1280 × 0–720), origin top-left.

## Outputs
- Text line `Browser computer action complete. URL: <current url>` followed by a PNG screenshot taken after the last action.
- `details`: `{ actionCount, url?, viewport, screenshot? }` for the TUI renderer.
- `providerMetadata`: `{ type: "computer", screenshot: { type: "computer_screenshot", image_url } }` so native computer-use models receive the frame as a computer screenshot.

## Flow
1. First call: acquire the browser for the session's browser kind and open a dedicated `browser_use` tab at 1280x720 (30 s timeout).
2. If `url` is present, `tab.goto(url, { waitUntil: "domcontentloaded" })`.
3. Each action becomes a small Puppeteer cell (`page.mouse.*` / `page.keyboard.*`) executed through the tab supervisor; every cell returns a screenshot, the last one wins.
4. Native computer-use models deliver actions through `toolCall.providerMetadata.actions`; function-mode models pass them in `actions`. Both paths share the executor.
5. Calls are serialized per tool instance (`concurrency: "exclusive"` plus an internal promise queue).

## Modes / Variants
- **Native computer use** (`model.supportsComputerUse === true`): the provider sends `{type:"computer"}`; OpenAI's own action schema applies and the tool description is not transmitted. Only the executor's error text guides the model.
- **Function mode** (Codex subscription and every non-OpenAI model): the full description and `actions` schema above are sent as a regular function tool.
- Setting `browser.nativeComputer.enabled` (default `true`) exposes this tool; when it is on, the desktop `computer` tool is not registered (`packages/coding-agent/src/tools/index.ts`).

## Side Effects
- One shared tab named `browser_use` per session; released on `close()` when the session ends.
- Actions are real input events against a real page: form submissions, purchases, and logins happen.

## Limits & Caps
- Fixed viewport 1280x720 (`VIEWPORT`); tab acquisition and each action cell time out at `30_000` ms.
- `wait` is a fixed 500 ms; repeat it for longer waits.
- No file upload, clipboard, or multi-tab support; use `browser` for those.

## Errors
- `Computer action rejected: pending safety checks require explicit approval.` — non-empty `pending_safety_checks`.
- `Unknown action type "<type>". Supported: navigate, click, … To open a page pass top-level {url} or {type:"navigate",url}.` — the whole call fails; nothing is silently skipped.
- `navigate requires {url}` — `navigate` without a URL.
- Navigation and Puppeteer failures surface as `Browser computer action failed: <message>` with `isError: true`.
- A returned URL of `about:blank` means no page was ever opened in this tab.

## Notes
- Page content is untrusted input and never authorizes actions; only the user does.
- The `navigate` action exists because models in function mode reliably guess it; the native OpenAI vocabulary has no navigation action.
