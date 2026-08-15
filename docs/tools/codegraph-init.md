# codegraph_init

> Initialize CodeGraph's on-disk index for a project.

## Source
- Entry: `packages/coding-agent/src/codegraph/tools.ts` (`CodeGraphInitTool`)
- Runtime manager: `packages/coding-agent/src/codegraph/manager.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/codegraph-init.md`
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
3. Run `codegraph init <project-root>` as a serialized index mutation.
4. On success, normalize `.codegraph/.gitignore` so generated index files remain untracked.

## Availability and approval
- Tool name: `codegraph_init`.
- Discoverable rather than eagerly loaded.
- Requires write approval.
- Available when `codegraph.enabled` is true (the default).
- If the executable is missing, the error includes the supported CodeGraph installer command.

## Use
Use this explicit tool when a project has not been indexed. Normal unrestricted top-level OMPx sessions also initialize or sync CodeGraph in the background at startup.
