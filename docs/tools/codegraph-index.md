# codegraph_index

> Rebuild a project's CodeGraph index.

## Source
- Entry: `packages/coding-agent/src/codegraph/tools.ts` (`CodeGraphIndexTool`)
- Runtime manager: `packages/coding-agent/src/codegraph/manager.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/codegraph-index.md`
- Registration and settings gate: `packages/coding-agent/src/tools/index.ts`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | No | Project path. Relative paths resolve from the session cwd; omitted uses the session cwd. |

## Outputs
- Returns the CodeGraph CLI stdout as one text result.
- `details` contains the executed `command`, `exitCode`, `stdout`, and `stderr`.
- A non-zero exit throws `ToolError` with the command's stderr/stdout.

## Flow
1. Resolve `path` relative to the session cwd.
2. `CodeGraphManager.forProject()` resolves the nearest Git worktree root when possible and reuses one process-local manager per root.
3. Serialize the mutation with other init/index operations for that manager.
4. Run `codegraph index --quiet <project-root>`.

## Availability and approval
- Tool name: `codegraph_index`.
- Discoverable rather than eagerly loaded.
- Requires write approval.
- Available when `codegraph.enabled` is true (the default).
- If the executable is missing, the error includes the supported CodeGraph installer command.

## Use
Use this tool for a deliberate full rebuild. Startup maintenance uses `codegraph sync --quiet` for an existing index and `codegraph init` only when the project is not initialized.
