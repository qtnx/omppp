<system-notice>
The user's message contains the **workflow** keyword and was classified as an explicit workflow directive. This permits workflow use; it does not make a workflow mandatory. When the eligibility gate below passes, call the `workflow` tool with a dynamic JavaScript workflow script; otherwise execute directly. Inside eval, Default to `workpool()` for 2+ independent items; use individual `agent()` handles only for dependency-coupled or schema-returning calls.

Fast path: a trivial lookup, one contained runnable slice, a direct command, or a question about workflows MUST be handled directly. Use `workflow` only when at least two independent subagent slices or a real multi-stage per-item chain materially improves wall-clock, coverage, confidence, or context isolation.

<when>
Worth it only when concrete work decomposes into independent parallel slices, a real multi-stage per-item chain, independent/adversarial cross-checking, or scale one context cannot hold. Otherwise execute directly.{{#if scoutAvailable}} Scout inline FIRST{{else}} Explore inline FIRST{{/if}} (identify files, conflicts, failures, call sites, or review dimensions), then fan out over the discovered work-list.

Common shapes:
- **Understand** — parallel readers over subsystems → structured map.
- **Design** — judge panel of independent approaches → scored synthesis.
- **Review** — split into dimensions → find per dimension → adversarially verify findings.
- **Research** — multi-modal sweep → deep-read hits → synthesize.
- **Migrate** — discover sites → transform each → verify.
</when>

<workflow-use>
- {{#if scoutAvailable}}Scout{{else}}Explore{{/if}} inline first: identify files, conflicts, failures, or review dimensions.
- Then call `workflow` with inline `script` and any dynamic values in `args`.
- Script MUST start with pure-literal `export const meta = { name, description, phases }`.
- Use `phase()`, `log()`, `agent()`, `parallel()`, and `pipeline()` inside the script.
- Use `schema` for subagent outputs you branch on.
- Keep subagent prompts self-contained: target files, constraints, acceptance.
- After workflow completion, verify results yourself before claiming status.
- Inside eval, `workpool(agent=None, *, name=None, context=None{{#if evalTools}}, tools=None{{/if}})` keeps workers alive across pushed items; `agent(...)` handles are for dependency-coupled or `schema` results.{{#if evalTools}} `@tool` (Python) / `tool(fn, {…})` (JS) defines a kernel-local tool exposed via `tools=`.{{/if}}
- Pool results auto-deliver. Need to block? Leave `eval`, then call `hub` with `op:"wait", ids:["<pool-name>"]`; re-issue until settled. NEVER block the kernel with `pool.wait()`.

{{#if taskBatch}}
- Call `task` once per independent fan-out batch.
{{else}}
- Call `task` once per independent subagent.
- Do not pass `context` or `tasks[]`; the single-spawn task schema accepts one assignment directly.
{{/if}}
</workflow-use>

<helpers>
State persists across `eval` calls. Every call provides:

- `workpool(agent=None, *, name=None, context=None{{#if evalTools}}, tools=None{{/if}})`: pool of keep-alive workers bounded by live `task.maxConcurrency`. `.push(*items)` returns item ids; each item goes to the least context-loaded idle worker, a new worker while capacity remains, or a busy worker's round-robin queue. `eval.workpool.freshAgents=true` instead spawns a new agent per item. `.status()` reports counts/workers; `.peek()` returns a non-consuming batch snapshot; `.close()` drops queued work.
  - The pool name is its background job id and label. Push all items while it is active; its first full drain settles and closes that pool job. New phase/wave after drain → create a new named pool.
  - Results auto-deliver. Need to block? Leave `eval`, then call `hub` with `op:"wait", ids:["<pool-name>"]`; re-issue until settled. NEVER block the kernel with `pool.wait()`.
- `agent(prompt, *, agent=None, label=None, schema=None, isolated=None, apply=None, merge=None{{#if evalTools}}, tools=None{{/if}})`: immediate `AgentHandle`; use for a small fixed dependency graph or when the parent needs validated `schema` data. `.wait()` returns text/data; `.handle` is `agent://<id>`. Unwaited results auto-deliver.
- `completion(prompt, *, model="default", system=None, schema=None)`: immediate `CompletionHandle` for a tool-free one-shot call. Tiers: `"smol"`, `"default"`, `"slow"`.
- `await judge(state, questions)`: typed `choice`/`bool`/`score` questions over one state → `{id: answer}` with probabilities. Cheaper than `completion()` for classification.
- `judge_batch(states, questions, *, concurrency=32, retries=1, min_ok=1, intent=None)`: the same questions over many states, run by the host so it outlives the cell. Set nonempty `intent` for its progress/job label (default `"Judging"`). Returns a `JudgmentBatch` at once; per cell pull a bounded slice with `await b.drain(timeout)` (or `async for k, item in b.drain_iter(timeout)`), read `b.status()`/`b.results()`/`b.failed()`, and `b.close()` when done. Item failures are `item.error`, never exceptions; `b.id` is a background job id (auto-delivers, `hub wait`). Never loop `judge()` over a list.
- `wait(handles, timeout=None, *, raise_errors=True)`: ordered barrier for agent/completion handles only; `raise_errors=False` keeps an error in its slot.
{{#if evalTools}}- `@tool` (Python) / `tool(fn, {…})` (JS): kernel-local tool exposed via `tools=`. Use for shared caches, dedup sets, scoring, or structured accumulation across pool workers; calls execute in YOUR kernel and a raised exception returns to the caller without killing it.
{{/if}}- `log(message)`: progress line. `phase(title)`: status-tree phase.
- `budget`: Python `budget.total` / `budget.spent()` / `budget.remaining()`; JS awaits them. User `+Nk` = advisory; `+Nk!` = hard.

Inside a workflow script:
- `agent(prompt, { agentType, model, label, phase, schema }?)` — run ONE subagent; returns its final text, or the validated object when `schema` (a JSON Schema object) is provided. `agentType` picks a discovered agent (`workflow-subagent` by default; `"explore"`, `"reviewer"`, `"tester"`, …); `label` names the artifact; `phase` overrides the current phase for that spawn. Shared background goes in a `local://` file referenced from each prompt, not a parameter. Subagents are told their final text IS the return value, so branch on returned data instead of parsed prose when `schema` is used. `agent()` blocks until the subagent finishes.
- `parallel(thunks)` — BARRIER. Start zero-arg functions concurrently, preserving input order; returns once all finish. `agent()` calls inside those thunks are limited by the workflow concurrency cap. Rejected/throwing thunks become `null` in the returned array instead of rejecting the whole call. In loops, bind each closure's value (`const item = items[i]`) before creating the thunk.
- `pipeline(items, …stages)` — NO barrier. Each item flows through all stages independently; each stage gets `(prevResult, originalItem, index)`. If a stage throws, that item becomes `null` and skips its remaining stages. Use this as the default for multi-stage per-item chains.
- `workflow(nameOrRef, args?)` — run another workflow inline (one level of nesting only). `args` is the value passed to this workflow invocation.

Workflows run through the `workflow` tool; with a background runner they launch in the background and report progress in `/workflows`. In headless/no-background contexts they run synchronously. Each workflow script is one well-scoped fan-out; chain phases by reading results before deciding the next workflow call.
</helpers>

<structure>
For independent per-item chains (review → verify, fetch → extract), use `pipeline()` so each item flows through its own steps without waiting on unrelated items.

Reach for `pipeline()` for per-item multi-stage chains where each item can advance independently. Use `parallel()` when you need a barrier because all results must be gathered before the next step: dedup/merge across the whole set, early-exit on zero, or compare against other findings. Do not add a barrier just to flatten/map/filter; do that with plain JavaScript between calls.
</structure>

<patterns>
Compose the harness the task calls for:
- **Adversarial verify** — independent skeptics per finding, each prompted to refute; keep only findings that survive.
- **Perspective-diverse verify** — give verifiers distinct lenses (correctness, security, performance, reproduction) instead of identical prompts.
- **Judge panel** — independent approaches scored by judges; synthesize from the winner and graft the best of the rest.
- **Loop-until-dry** — for unknown-size discovery, keep spawning finders until consecutive rounds surface nothing new; dedup against everything seen.
- **Multi-modal sweep** — parallel finders searching different ways, each blind to the others.
- **Completeness critic** — final agent asks what is missing: modality not run, claim unverified, file unread.
- **No silent caps** — if you bound coverage by top-N, no-retry, or sampling, `log()` what you dropped.

Scale to the ask: "find any bugs" → a few finders and single verification pass. "Thoroughly audit / be comprehensive" → larger finder pool, adversarial pass, and synthesis stage.
</patterns>

<pool-examples>
**Python:**

```python
phase("Review")
review = workpool({{#if scoutAvailable}}"scout", {{/if}}name="review", context="Return evidence with exact paths; do not edit.")
review.push(*[
    "Review authentication correctness",
    "Review authorization boundaries",
    "Review cancellation and cleanup",
    "Review performance regressions",
])
print(review.name)   # poll outside eval: hub wait, ids:["review"]
```

**JavaScript:**

```js
phase("Review");
const review = await workpool({{#if scoutAvailable}}"scout", {{/if}}{
    name: "review",
    context: "Return evidence with exact paths; do not edit.",
});
await review.push(
    "Review authentication correctness",
    "Review authorization boundaries",
    "Review cancellation and cleanup",
    "Review performance regressions",
);
console.log(review.name); // poll outside eval: hub wait, ids:["review"]
```

Need a snapshot without consuming/delivering results? `review.peek()` (JS: `await review.peek()`). Need activity counts? `review.status()`.
</pool-examples>

<execution>
- Decompose the surface first; capture it in a plan/TODO when it spans phases.
- Prefer `schema` for any agent whose output you branch on.
- After a fan-out returns, YOU own correctness: read artifacts, run gates, and verify before acting. Subagents do the legwork; they do not get the last word.
- Keep going until the task is closed — a returned workflow is a step, not a stopping point.
</execution>

<critical>
- NEVER ask the user to write the workflow script.
- NEVER use Python `eval` as the workflow implementation.
- NEVER treat subagent output as verified.
- NEVER fan out for trivial or purely conversational requests.
</critical>
</system-notice>
