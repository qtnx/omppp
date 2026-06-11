<system-notice>
The user's message above contains the **workflow** keyword. For a concrete task that benefits from multi-step or parallel subagent work, call the `workflow` tool with a dynamic JavaScript workflow script.

Use this only when fan-out improves coverage, confidence, or scale. For trivial lookup, single edit, or a question only about workflows, answer directly.

<when>
Worth it when the task benefits from decomposition + parallel coverage, independent/adversarial cross-checking, or scale one context cannot hold. Scout inline FIRST (identify files, conflicts, failures, call sites, or review dimensions), then fan out over the discovered work-list.

Common shapes:
- **Understand** — parallel readers over subsystems → structured map.
- **Design** — judge panel of independent approaches → scored synthesis.
- **Review** — split into dimensions → find per dimension → adversarially verify findings.
- **Research** — multi-modal sweep → deep-read hits → synthesize.
- **Migrate** — discover sites → transform each → verify.
</when>

<workflow-use>
- Scout inline first: identify files, conflicts, failures, or review dimensions.
- Then call `workflow` with inline `script` and any dynamic values in `args`.
- Script MUST start with pure-literal `export const meta = { name, description, phases }`.
- Use `phase()`, `log()`, `agent()`, `parallel()`, and `pipeline()` inside the script.
- Use `schema` for subagent outputs you branch on.
- Keep subagent prompts self-contained: target files, constraints, acceptance.
- After workflow completion, verify results yourself before claiming status.
</workflow-use>

<helpers>
- `agent(prompt, { agent_type, model, label, schema }?)` — run one subagent; returns final text, or a validated object when `schema` is provided. Shared background belongs in a `local://` file referenced from each prompt. The call blocks until the subagent finishes.
- `parallel(thunks)` — run zero-arg functions concurrently through the session task concurrency limit, preserving input order. Catch expected failures inside each thunk if partial results are useful. In loops, bind each closure's value (`const item = items[i]`) before creating the thunk.
- `pipeline(items, ...stages)` — map items through stages left-to-right. There is a barrier between stages: all items finish stage N before stage N+1 begins. Use it only when a stage needs all prior results.
- `log(message)` emits progress; `phase(title)` groups status lines under a phase.
</helpers>

<structure>
For independent per-item chains (review → verify, fetch → extract → score), wrap the whole chain in one function and run it with `parallel()` so each item flows through its own steps without waiting on unrelated work.

Reach for `pipeline()` only when a stage genuinely needs all previous-stage results first: dedup/merge across the whole set, early-exit on zero, or compare against other findings. Do not add a barrier just to flatten/map/filter; do that with plain JavaScript between calls.
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
