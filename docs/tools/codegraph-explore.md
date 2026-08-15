# codegraph_explore

> Explore indexed code structure, verbatim source, and call paths in one query.

## Source
- Entry: `packages/coding-agent/src/codegraph/tools.ts` (`CodeGraphExploreTool`)
- Runtime manager: `packages/coding-agent/src/codegraph/manager.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/codegraph-explore.md`
- Registration and settings gate: `packages/coding-agent/src/tools/index.ts`
- Startup lifecycle: `packages/coding-agent/src/sdk.ts`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | non-empty string | Yes | Natural-language question, symbol names, file names, or short code terms. |
| `projectPath` | string | No | Project to query. Relative paths resolve from the session cwd; omitted uses the current project manager. |
| `maxFiles` | integer >= 1 | No | Maximum source files returned. OMPx caps the value at 100. |

## Outputs
- Returns the CodeGraph CLI's line-numbered exploration text as one text result.
- `details` contains the executed `command`, `exitCode`, `stdout`, and `stderr`.
- A non-zero exit throws `ToolError` with the command's stderr/stdout.
- Readiness/setup failures throw an actionable `ToolError`; callers may fall back to normal file tools.

## Flow
1. Resolve `projectPath` relative to the session cwd when supplied.
2. Reuse the process-local `CodeGraphManager` for the nearest Git worktree root.
3. Await that manager's readiness. An existing index is synced; an absent index is initialized; a missing executable produces an unavailable error rather than blocking OMPx startup.
4. Run `codegraph explore`, adding `--path <projectPath>` and `--max-files <n>` when supplied, followed by `query`.
5. Return CodeGraph's source and call-path report unchanged.

## Availability and approval
- Tool name: `codegraph_explore`.
- Essential/default-active and available when `codegraph.enabled` is true (the default).
- Requires read approval.
- Unrestricted top-level sessions start index maintenance in the background. When ready, OMPx queues hidden guidance without triggering an agent turn.
- Subagent, restricted-tool, and disabled-CodeGraph sessions do not auto-start the manager.

## Use
Use this before grep/read loops when locating or understanding code. The returned line-numbered source is already read; only fall back to `grep`, `glob`, or `read` when CodeGraph is unavailable or its result is incomplete or stale.
