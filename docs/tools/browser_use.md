# browser_use

> OpenAI Computer Use for a managed browser tab: the model sends screenshot-driven coordinate actions (click, drag, type, keypress, scroll, wait, screenshot) against a fixed 1280x720 viewport and receives a fresh screenshot after each action group. Use it for canvas/WebGL games, 3D scenes, gesture-heavy UIs, and any state that lives outside the DOM. The `browser` eval prelude remains the tool for DOM, selectors, console, and network work.

## Source

- Tool: `packages/coding-agent/src/tools/browser-native-computer.ts`
- Registration and gate: `packages/coding-agent/src/tools/index.ts` (`browser_use` factory; enabled when `browser.enabled` and `browser.nativeComputer.enabled` are both true)
- Browser acquisition and tab lifecycle: `packages/coding-agent/src/tools/browser/registry.ts`, `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Native marker and provider wire types: `packages/ai/src/types.ts` (`NativeToolMarker`, `ComputerAction`)
- Test: `packages/coding-agent/test/tools/browser-native-computer.test.ts`

## Availability

- `browser.nativeComputer.enabled` (default `true`) plus `browser.enabled` gate the tool. Disabling either removes `browser_use` from the roster.
- Providers with a native computer-use surface (OpenAI Responses) receive the tool as a native `computer` marker; other providers call it as an ordinary function tool with the `actions` array.
- The tool is `essential` and `exclusive`: actions are serialized per session, and the managed tab named `computer` is reused across calls until the session closes.

## Parameters

| field | type | notes |
| --- | --- | --- |
| `url` | string, optional | Open or navigate the managed tab before running actions. |
| `actions` | `ComputerAction[]`, optional | Ordered OpenAI computer actions. Empty input takes a screenshot. |
| `action` | `ComputerAction`, optional | Single-action convenience form. |
| `pending_safety_checks` | array, optional | Any non-empty value rejects the call; safety checks require explicit approval. |
| `call_id` | string, optional | Provider correlation id for native calls. |

Unknown fields are rejected.

## Result

- Text line with the tab URL after the actions ran.
- One image block with the final screenshot (`image/png`), also mirrored into `providerMetadata.screenshot` so native providers can chain the next action.
- `details`: `{ actionCount, url, viewport, screenshot?, rejected? }`.
- Failures return `isError: true` with the underlying browser error message; an aborted signal throws `ToolAbortError`.
