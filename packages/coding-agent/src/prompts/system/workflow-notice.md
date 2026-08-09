<system-notice>
The user's message above contains the **workflow** keyword. For a concrete task that benefits from multi-step or parallel subagent work, call the `workflow` tool with a dynamic JavaScript workflow script.

Use this only when fan-out improves coverage, confidence, or scale. For trivial lookup, single edit, or a question only about workflows, answer directly.

<when>
Worth it when the task benefits from decomposition + parallel coverage, independent/adversarial cross-checking, or scale one context cannot hold. For a quick lookup or single edit, just do it directly — don't spin up agents.{{#if scoutAvailable}} Scout inline FIRST{{else}} Explore inline FIRST{{/if}} (identify files, conflicts, failures, call sites, or review dimensions), then fan out over the discovered work-list.

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

{{#if taskBatch}}
- Call `task` once per independent fan-out batch.
{{else}}
- Call `task` once per independent subagent.
- Do not pass `context` or `tasks[]`; the single-spawn task schema accepts one assignment directly.
{{/if}}
</workflow-use>

<helpers>
Workflow scripts run in the `workflow` tool and have these globals:

- `agent(prompt, { agentType, model, label, phase, schema }?)` — run ONE subagent; returns its final text, or the validated object when `schema` (a JSON Schema object) is provided. `agentType` picks a discovered agent (`workflow-subagent` by default; `"explore"`, `"reviewer"`, `"tester"`, …); `label` names the artifact; `phase` overrides the current phase for that spawn. Shared background goes in a `local://` file referenced from each prompt, not a parameter. Subagents are told their final text IS the return value, so branch on returned data instead of parsed prose when `schema` is used. `agent()` blocks until the subagent finishes.
- `parallel(thunks)` — BARRIER. Start zero-arg functions concurrently, preserving input order; returns once all finish. `agent()` calls inside those thunks are limited by the workflow concurrency cap. Rejected/throwing thunks become `null` in the returned array instead of rejecting the whole call. In loops, bind each closure's value (`const item = items[i]`) before creating the thunk.
- `pipeline(items, …stages)` — NO barrier. Each item flows through all stages independently; each stage gets `(prevResult, originalItem, index)`. If a stage throws, that item becomes `null` and skips its remaining stages. Use this as the default for multi-stage per-item chains.
- `log(message)` — emit a progress line above the status tree. `phase(title)` — start a phase; subsequent status lines group under it.
- `budget` — `{ total, spent(), remaining() }`. `total` is the workflow token-budget setting or `null` when none is set; `spent()` counts output tokens from workflow `agent()` calls; `remaining()` is `Infinity` when `total` is `null`. Once `spent() ≥ total`, further `agent()` calls throw. Guard loops on `budget.total` first: `while (budget.total && budget.remaining() > 50000) { … }`.
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
