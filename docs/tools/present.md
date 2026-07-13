# present

> Starts or refreshes the local Product Preview WebUI for reviewing product artifacts and sending feedback to the owning agent session.

## Source
- Entry: `packages/coding-agent/src/tools/present.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/present.md`
- Preview server: `packages/coding-agent/src/product-preview/server.ts`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `root` | `string` | No | Artifact root. Defaults to `docs/product`. |
| `paths` | `string[]` | No | Additional files or directories included in the preview. |
| `title` | `string` | No | Preview title shown in the browser. |
| `open` | `boolean` | No | Opens the local URL in the default browser. Defaults to `true`. |
| `share` | `boolean` | No | Sharing request. `true` is always rejected; only the user may enable sharing from the TUI. |

## Output

Success returns plain text containing:
- `Started` for the first call or `Refreshed` when reusing the running server;
- the loopback Product Preview URL;
- the number of discovered artifacts;
- `Share: active (URL and token redacted)` when the user already enabled sharing.

## Flow

1. The first call starts one session-owned Product Preview server with the selected artifact root and paths.
2. Later calls reuse that server and refresh its manifest instead of opening another listener.
3. Feedback support is attached to the owning agent session. Side-asks, comments, answers, and canvas feedback are delivered through that session while it remains connected.
4. Unless `open` is `false`, the tool opens the local preview URL in the default browser.
5. The tool never enables network sharing. The user controls sharing with `/product-preview share on|off|status`.

## Side Effects

- Starts and retains a loopback HTTP server for the current agent session.
- Reads product artifacts under `root` and any explicit `paths`.
- May open the system browser.
- May enqueue browser feedback into the owning agent session.

## Errors

- `share: true` returns an error directing the user to `/product-preview share on`.
- Invalid roots, unreadable artifacts, occupied ports, or preview startup failures surface as tool errors.
- A standalone preview without an owning agent cannot accept feedback and reports that capability as unavailable.

## Security

- Agents cannot enable sharing or obtain the share token.
- Shared URLs and tokens are redacted from tool output.
- Preview artifact paths and canvas payloads are validated by the Product Preview server before serving.
