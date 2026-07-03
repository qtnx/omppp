# workflow

> Runs a deterministic multi-subagent orchestration script (inline JS, a saved script, or a bundled/named workflow) in the background.

## Source
- Entry: `packages/coding-agent/src/workflow/index.ts` (`WorkflowTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/workflow.md`
- Key collaborators:
  - `packages/coding-agent/src/workflow/engine.ts` — `WorkflowRun`, `workflowConcurrency` (execution engine + concurrency cap).
  - `packages/coding-agent/src/workflow/sandbox.ts` — `runWorkflowScript`, `validateSyntax` (sandboxed script execution).
  - `packages/coding-agent/src/workflow/runtime.ts` — `createWorkflowGlobals` (the `agent`, `parallel`, `pipeline`, `log`, `phase`, `budget`, `workflow` globals exposed to scripts).
  - `packages/coding-agent/src/workflow/discovery.ts` — `discoverWorkflows`, `getWorkflowSource` (named/bundled workflow lookup).
  - `packages/coding-agent/src/workflow/storage.ts` — `persistWorkflowScript`, `readWorkflowScript`, `subagentTranscriptDir`.
  - `packages/coding-agent/src/workflow/journal.ts` — `WorkflowJournal` (resumable run state).
  - `packages/coding-agent/src/workflow/meta.ts` — `extractMeta`, `validateMeta` (required `export const meta = { name, description, phases }`).
  - `packages/coding-agent/src/task/executor.ts` — `runSubprocess` used to spawn each `agent()` call.
  - `packages/coding-agent/src/async` — `AsyncJobManager` backing the background job.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `script` | `string` | One of `script`/`scriptPath`/`name` | Inline JavaScript workflow script. Must start with a pure-literal `export const meta = { name, description, phases }`. |
| `scriptPath` | `string` | No | Path to a persisted workflow script; overrides `script` when set. |
| `name` | `string` | No | Name of a saved/bundled workflow to run. |
| `args` | `unknown` | No | Value exposed to the script as the `args` global. |
| `resumeFromRunId` | `string` | No | Resume from a previous run id in the same session (uses the journal). |

## Outputs
- `details: WorkflowToolDetails`: `{ runId, scriptPath?, meta?, async?, phases: [{index, title}], agents: [{index, label, phaseTitle?, state, agentId?, error?, tokens?, durationMs?}], logs: string[] }`.
- `async` field (when backgrounded): `{ state: "running" | "completed" | "failed", jobId, type: "workflow" }`.
- Progress streams over the `workflow:progress` `EventBus` channel as `WorkflowProgressFrame`s (`phase`, `log`, or `agent` state-change frames) while the run is in flight.

## Flow
1. `WorkflowTool.execute()` resolves the script source: `scriptPath` (read from disk) > `script` (inline, persisted via `persistWorkflowScript`) > `name` (resolved via `discoverWorkflows`/`getWorkflowSource`).
2. `validateSyntax()` parses the script and `extractMeta()` + `validateMeta()` require a leading pure-literal `export const meta = { name, description, phases }`.
3. The tool registers a background job (`AsyncJobManager`, `type: "workflow"`) and runs the script inside `runWorkflowScript()`'s sandbox.
4. The sandbox exposes globals from `createWorkflowGlobals()`: `agent()` spawns one subagent (via `runSubprocess`) and blocks until it finishes; `parallel()` runs a batch of zero-arg thunks concurrently up to `workflowConcurrency`; `pipeline()` flows items through per-item stages without a barrier; `log()`/`phase()` emit progress frames; `budget` tracks/guards token spend; nested `workflow()` runs another workflow inline (one level of nesting).
5. Each `agent()` call spawns a subprocess subagent, streaming `agent` progress frames (`start` → `done`/`error`/`cached`) with token/duration stats.
6. On completion/failure, the run's final state and logs are recorded in `WorkflowJournal`; `resumeFromRunId` on a later call restores journal state instead of restarting from scratch.

## Modes / Variants
- Inline script (`script`) — persisted to disk first via `persistWorkflowScript`, then executed.
- Persisted script (`scriptPath`) — read directly via `readWorkflowScript`.
- Named/bundled workflow (`name`) — resolved via `discoverWorkflows`/`getWorkflowSource`.
- Resume (`resumeFromRunId`) — continues a prior run using the same-session journal instead of re-running completed agents.

## Side Effects
- Filesystem
  - Persists inline scripts to disk; writes subagent transcripts under `subagentTranscriptDir`.
- Subprocesses
  - Each `agent()` call spawns a subprocess subagent via `runSubprocess` (same mechanism as the `task` tool).
- Session state
  - Registers and updates an async job (`type: "workflow"`) visible to the `job` tool.
  - Journals run state for resumability.

## Limits & Caps
- `MAX_WORKFLOW_AGENTS = 1000` — lifetime backstop on total `agent()` calls in a single run.
- `WORKFLOW_AGENT_STALL_MS = 180_000` — per-agent stall timeout before a spawn is surfaced as stalled.
- `MAX_WORKFLOW_SCRIPT_BYTES = 524_288` — maximum persisted workflow script size.
- Concurrency inside `parallel()` is bounded by `workflowConcurrency` (comparable to a `task` batch — callers should not pre-shrink batches).
- Gated by `workflow.enabled` setting and only available at top-level (`session.taskDepth === 0`) — not exposed to subagents.

## Errors
- Missing/invalid `export const meta` at the top of the script → validation error before execution starts.
- Script syntax errors caught by `validateSyntax()` before the sandbox runs.
- A throwing thunk inside `parallel()` propagates and fails the whole `parallel()` call; a throwing stage inside `pipeline()` fails only that item (becomes `null`, skips remaining stages).
- Exceeding `budget.total` (when a hard ceiling `+Nk!` is set) causes further `agent()` calls to throw.

## Notes
- Prefer `pipeline()` for independent per-item multi-stage chains; reserve `parallel()` for batches that need a barrier (dedup/merge across the whole set, early-exit, or cross-item comparison).
- Subagent prompts must be self-contained — shared background goes in a `local://` file referenced from each prompt, not duplicated inline.
- After a workflow completes, its output is a step, not a stopping point — the caller must verify results (read artifacts, run gates) before acting on them.
