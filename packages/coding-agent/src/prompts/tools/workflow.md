Execute a deterministic JavaScript workflow that orchestrates multiple subagents. Runs in the background — returns immediately with a run id; a notification arrives on completion. Watch live progress with `/workflows`.

## When to use

Use this tool when the user explicitly asks to run/orchestrate/fan out a concrete task and multiple independent slices or a real multi-stage chain make orchestration cheaper or more reliable than direct execution. A mention, complaint, negation ("don't use workflow"), quick lookup, or single edit is not a workflow request. Also use a named/saved workflow when explicitly requested.

## Parameters

- `script`: inline JS workflow (see format below).
- `scriptPath`: path to a persisted script (overrides `script`) — used to resume/iterate.
- `name`: a saved/bundled workflow to run.{{#if namedWorkflows}} Available: {{namedWorkflows}}.{{/if}}
- `args`: value exposed to the script as the `args` global.
- `resumeFromRunId`: resume a prior run; the longest unchanged prefix of `agent()` calls returns cached results.

## Script format

Begin with a PURE LITERAL `export const meta = { name, description }` (optional `whenToUse`, `phases`), then the body using these globals:

- `agent(prompt, opts?)` → subagent. Without `schema`, returns its final text (string). With `schema` (a JSON Schema object), the subagent is forced to return structured data and `agent()` returns the validated object. Returns `null` if skipped — filter with `.filter(Boolean)`. `opts`: `{ label, phase, schema, model, agentType }`.
- `parallel(thunks)` → BARRIER. Awaits an array of `() => Promise` thunks. A throwing thunk resolves to `null` (never rejects). Use ONLY when you need all results together.
- `pipeline(items, stage1, stage2, …)` → NO barrier. Each item flows through all stages independently. Each stage gets `(prevResult, originalItem, index)`. A throwing stage drops that item to `null`. This is the DEFAULT for multi-stage work.
- `phase(title)` → start a new progress group.
- `log(message)` → narrator line shown above the progress tree.
- `budget` → `{ total, spent(), remaining() }`. `total` is null if no budget set; once `spent() ≥ total`, `agent()` throws. Guard loops: `while (budget.total && budget.remaining() > 50000) { … }`.
- `workflow(nameOrRef, args?)` → run another workflow inline (one level of nesting only).
- `args` → the `args` you passed.

## Constraints

- Concurrent `agent()` calls use a host-aware auto cap: at most 8, with lower limits on CPU- or memory-constrained machines; excess calls queue. Lifetime agent count is capped at 1000.
- `Date.now()`, `new Date()` (no args), and `Math.random()` are unavailable (they break resume). Pass timestamps/seeds via `args`.
- The script's top-level `return` value (if any) becomes the workflow's result.
