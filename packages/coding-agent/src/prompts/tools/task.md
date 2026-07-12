{{#if asyncEnabled}}{{#if batchEnabled}}Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.{{else}}Delegate work to ONE background subagent per call.{{/if}}
Execution does not block your turn: you receive agent and job IDs immediately, and the final results deliver themselves when the subagents finish.{{#if hasBlockingAgents}}
Exception: agents marked BLOCKING below run inline — their results return in this call, while non-blocking items in the same batch still spawn as background jobs.{{/if}}{{else}}{{#if batchEnabled}}Run subagents synchronously by passing items in a `tasks[]` batch.{{else}}Run ONE subagent synchronously per call.{{/if}}
Execution blocks your turn: the call only returns once the work is completely finished.{{/if}}

# Delegation Strategy
- **Maximize parallelism:** Break work into the widest possible {{#if batchEnabled}}array of `tasks[]`{{else}}set of parallel `task` calls{{/if}}. NEVER serialize work that can run concurrently. Tasks touching different files or independent refactors should run in parallel; agents resolve their own file collisions live.
{{#when MAX_CONCURRENCY ">" 0}}
- **Concurrency cap:** At most {{pluralize MAX_CONCURRENCY "subagent" "subagents"}} run at once in this session — anything beyond that just queues, so a {{#if batchEnabled}}`tasks[]` batch{{else}}set of parallel `task` calls{{/if}} larger than {{MAX_CONCURRENCY}} only delays results. Keep the fan-out at or under the cap.
{{/when}}
- **Agent typing:** Choose each item's `agent` type first. Read-only research MUST use `scout`, which is optimized for rapid discovery. Use `explore` for broader codebase research and the default worker only when no listed specialist fits.
- **Sequence only when necessary:** The only reason to run A before B is if B strictly requires A's output to function (e.g., a core API contract or schema migration). {{#if ircEnabled}}If the missing piece is small, run them in parallel and have B ask A via `irc`!{{/if}}
{{#if ircEnabled}}- **Steering delivery:** Parent-to-subagent IRC is delivered immediately as steering; subagents blocked in `job poll` / `irc wait` do not need to poll separately for it.{{/if}}
- **Role matching:** Assign each subagent a specific `role` (e.g. "Security Reviewer", "DB Migrator"). Do not spawn generic workers.
- **No overhead:** Each assignment MUST instruct its agent to skip formatters, linters, and project-wide test suites. You will run those once at the end.
- **One-pass agents:** Prefer agents that investigate **and** edit in a single pass; only spin a read-only discovery step (e.g. `scout`) when the affected files are genuinely unknown.

# Inputs
- `agent` (optional): The base agent type to use (e.g., `scout`, `plan`, `reviewer`). Defaults to `{{defaultAgent}}`{{#if defaultAgentIsGeneric}} (the general-purpose worker){{/if}} — omit it for the default worker instead of passing `agent: "{{defaultAgent}}"`.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks. REQUIRED, session-specific only.
- `tasks[]`: Array of subagents to spawn.
  - `assignment`: Complete, self-contained instructions following assignment-fmt. One-liners or missing Acceptance/Done sections are PROHIBITED.
  - `id`: A stable CamelCase identifier (≤32 chars). Generated automatically if omitted.
  - `description`: A UI label only; the subagent NEVER sees it.
  - `role`: The specialist this subagent embodies. Tailor per spawn; do not clone a generic worker.
  - `self_review`: boolean, default false. `true` runs the automatic reviewer+fixer pass for this spawn.
{{#if isolationEnabled}}
  - `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{else}}
- `assignment`: Complete, self-contained instructions following assignment-fmt. One-liners or missing Acceptance/Done sections are PROHIBITED.
- `id`: A stable CamelCase identifier (≤32 chars). Generated automatically if omitted.
- `description`: A UI label only; the subagent NEVER sees it.
- `role`: The specialist this subagent embodies. Tailor per spawn; do not clone a generic worker.
- `self_review`: boolean, default false. `true` runs the automatic reviewer+fixer pass for this spawn.
{{#if isolationEnabled}}
- `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{/if}}

# Context and Communication
Subagents start blank. They have no access to your conversation history.
{{#if ircEnabled}}- **Steering delivery:** Parent-to-subagent IRC is delivered immediately as steering; subagents blocked in `job poll` / `irc wait` do not need to poll separately for it.{{/if}}
{{#if batchEnabled}}
- Pass large payloads using `local://<path>` URIs, NEVER inline text.
{{else}}
- Write shared project state ONCE to a `local://` file (e.g., `local://ctx.md`) and reference that URL in each `task`.
{{/if}}

# Format Contracts
{{#if batchEnabled}}
The `context` field MUST follow this format:
# Goal         ← what the batch accomplishes
# Constraints  ← rules and session decisions
# Contract     ← shared interfaces
{{/if}}

The `assignment` field MUST follow this format:
<assignment-fmt>
# Target       ← files + symbols the agent owns; forbidden files; explicit non-goals
# Change       ← step-by-step add/remove/rename; exact APIs, types, patterns; locked contracts it must not alter
# Acceptance   ← per-item checks the subagent can run or observe itself (focused tests, command output, behavior); no project-wide commands
# Done         ← required report contents: files changed, evidence per Acceptance item, deviations/assumptions, blockers; conditions to stop and escalate instead of guessing
</assignment-fmt>

<assignment-quality>
An assignment is a contract for a reader with ZERO conversation history. Before sending, check:
- Self-contained: every file path, symbol, contract, and decision named. "As discussed" and bare pronouns are dead references.
- Scoped: owned files listed; out-of-bounds named explicitly.
- Verifiable: each Acceptance item is a check the subagent can run or observe itself.
- Bounded: names the conditions to stop and report instead of guessing.

WRONG — forces the subagent to guess intent, scope, and done-ness:
  "Fix the spinner bug in the event controller and make sure tests pass"
RIGHT:
  # Target
  src/modes/controllers/event-controller.ts `#handleAutoCompactionStart` only; do NOT touch the retry handlers.
  # Change
  Stop and null `ctx.loadingAnimation` before `statusContainer.clear()`, mirroring `#handleAgentEnd`.
  # Acceptance
  `bun test test/modes/controllers/event-controller-compaction-spinner.test.ts` green; new test proves the spinner handle is released on `auto_compaction_start`.
  # Done
  Report files changed + test output; flag any behavior that deviates from this spec as an explicit deviation, not silently.
</assignment-quality>

# Available Agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
Prefer delegating implementation here. Decompose the work into the smallest independent units, dispatch each to the most fitting agent, and run disjoint units in parallel. Specialist routing comes before generic implementer tiers:
- Read-only scouting / fast codebase discovery → `scout`; broader exploratory research → `explore`.
- Architecture / work breakdown → `plan`.
- UI/UX/frontend/design/visual tasks → `designer` as the stable default design lead.
- Frontend/UI implementation or build tasks → `frontend_ui`.
- UI/UX/design review, audit, critique, or quality feedback → `ui_ux_reviewer`.
- UX/UI copy, copywriting, microcopy, error-state, empty-state, onboarding, or guidance text → `ux_copywriter`.
- Prefer these specialists before `quick_task` / `task` / `heavy_task` for their domains.

Pick the implementer tier per unit by speed/model/review depth when no specialist above owns the work:
- `heavy_task` — load-bearing or high-accuracy work: a full feature, a cross-module change, tricky logic, anything where a bug is expensive. Richest review depth when `self_review: true`.
- `task` — routine medium-complexity work: a contained feature slice or a well-scoped change across a few files. Moderate review depth when `self_review: true`.
- `quick_task` — light mechanical work or a small contained feature with a locked spec: rename, move, boilerplate, localized edits, data collection. Fastest and safe to fan out widely.
Review is opt-in per spawn: leave `self_review` false (default) for faster mechanical/boilerplate/parallel/low-risk work you will verify yourself; set `self_review: true` for an automatic reviewer+fixer pass on load-bearing, cross-module, correctness/security-critical work, or work you will not verify yourself. This works on any tier.
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY: no edit/write/command tools){{/if}}{{#if blocking}} (BLOCKING: runs inline; its result returns in this call){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation and reporting; do the edits yourself or assign them to a writing agent.{{/if}}
{{/list}}
{{/if}}
