{{#if asyncEnabled}}{{#if batchEnabled}}Delegate work to background subagents: multiple items in one `tasks[]` batch. Non-blocking — you receive IDs immediately.{{else}}Delegate work to ONE background subagent per call. Non-blocking — you receive an ID immediately.{{/if}}{{#if hasBlockingAgents}} Agents marked BLOCKING run inline and return in this call.{{/if}}{{else}}{{#if batchEnabled}}Run subagents synchronously via a `tasks[]` batch; blocks until all finish.{{else}}Run ONE subagent synchronously; blocks until it finishes.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Async Job Contract
- Results auto-deliver. A settled `hub jobs`/`hub wait` snapshot is the delivery; no duplicate `async-result` follows. NEVER busy-poll; use exact-ID wait only when completely blocked. `hub`/`irc` are for peer messaging, never completion.
- Job IDs are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `hub send`, `agent://<id>`, or `history://<id>`.
- With `outputSchema`, a result's parsed payload — when present — is served at `agent://<id>` (fields via `agent://<id>?q=.<field>`) regardless of validity; a schema-violating result also previews payload inline in auto-delivered follow-up.
- `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.
{{/if}}

# Strategy
- Dispatch every independent ready item concurrently{{#if batchEnabled}} in one `tasks[]`{{else}} as parallel calls{{/if}}; sequence only when B strictly needs A's output{{#if ircEnabled}} (small missing piece → run parallel, B asks A via `irc`){{/if}}. Concurrent edits to the same files auto-resolve{{#if ircEnabled}}; agents coordinate directly over IRC when needed{{/if}}. NEVER shrink or serialize a batch to avoid file overlap.{{#when MAX_CONCURRENCY ">" 0}} Cap: {{pluralize MAX_CONCURRENCY "subagent" "subagents"}} at once; larger batches only queue.{{/when}}
- Pick the `agent` first: read-only research → {{#if scoutAvailable}}`scout` (fast) or `explore` (broader){{else}}an available read-only agent{{/if}}; a specialist for its domain; {{#if defaultAgentIsGeneric}}the general-purpose worker{{else}}the spawn-policy default{{/if}} only when nothing fits. Give each item a specific `role`; never generic workers.
- Brief so the owner never re-discovers: exact `file:line`/`file:symbol` anchors and decisive code inline; first action is an edit, not a search. Cross-task contracts go in {{#if batchEnabled}}batch `context`{{else}}the task{{/if}} before dispatch. Every task skips formatters, linters, and project-wide suites — you run those once at the end.
- Fast exit: the owner yields the moment Acceptance passes — no polish, no unrequested gates, no broadened scope. Prefer agents that investigate AND edit in one pass.
- Handoff: every assignment realizes `H` (system Definitions); a required fact that is absent or stale justifies only a narrow lookup plus a reported rediscovery. Heavy git conflicts fan out per `skill://git-craft` (disjoint clusters to children; shared/generated/lock files and integration with the parent; NEVER wholesale ours/theirs).
{{#if ircEnabled}}- Parent-to-subagent IRC is delivered immediately as steering; blocked children in `job poll`/`irc wait` need no separate poll.{{/if}}

# Inputs
- `agent` (optional): base agent type (e.g. {{#if scoutAvailable}}`scout`, {{/if}}`plan`, `reviewer`). {{#if defaultAgentIsGeneric}}Defaults to the general-purpose worker (`{{defaultAgent}}`) — omit rather than pass that name; only omit after checking the list below.{{else}}The spawn-policy default (`{{defaultAgent}}`) applies when omitted. Omit `agent` when the spawn-policy default is the best fit.{{/if}}{{#if allowedAgentsText}} Spawn policy allows: {{allowedAgentsText}}.{{/if}}
{{#if batchEnabled}}
- `context` (REQUIRED, session-specific): shared Goal / Constraints / Contract for whole batch, stated once — outcome and why, repo/worktree/cwd/current state, exact repo-provided bootstrap commands (never invented), repo rules and non-goals, shared-file ownership, parent-only gates, LOCKED literal signatures/schemas (or exact readable `file:symbol`), ownership of each contract side, real runtime ordering, OPEN local choices.
- `tasks[]`: `name` (stable CamelCase ≤32, auto if omitted) · `agent` (as above) · `task` (assignment-fmt below; one-liners or missing Acceptance/Done are PROHIBITED) · `model` (explicit selector or fallback chain; `:reasoning` suffix kept; overrides agent model){{#if evalToolsEnabled}} · `tools` (eval-defined tools exposed to subagent){{/if}}{{#if effortEnabled}} · `effort` `"lo"|"med"|"hi"`{{/if}} · `outputSchema` (JSON Schema; overrides agent/session schemas) · `schemaMode` `"permissive"` (default) | `"strict"` · `max_runtime_seconds` (MUST set: `quick_task` 300, `explore`{{#if scoutAvailable}}/`scout`{{/if}} 600, `task` 900, `heavy_task` 2400; ceiling, not target; `0` = unlimited) · `self_review` (default false; `true` runs reviewer+fixer pass){{#if isolationEnabled}} · `isolated` ({{#if applyIsolatedChanges}}own worktree, successful changes applied to parent checkout{{else}}own worktree, changes kept as patch/branch artifacts{{/if}}){{/if}}. Legacy aliases `assignment`, `id`, `description`, `role` still accepted.
{{else}}
- `name` (stable CamelCase ≤32, auto if omitted) · `task` (assignment-fmt below; one-liners or missing Acceptance/Done are PROHIBITED) · `model` (explicit selector or fallback chain; `:reasoning` suffix kept; overrides agent model){{#if evalToolsEnabled}} · `tools` (eval-defined tools exposed to subagent){{/if}}{{#if effortEnabled}} · `effort` `"lo"|"med"|"hi"`{{/if}} · `outputSchema` (JSON Schema; overrides agent/session schemas) · `schemaMode` `"permissive"` (default) | `"strict"` · `max_runtime_seconds` (MUST set: `quick_task` 300, `explore`{{#if scoutAvailable}}/`scout`{{/if}} 600, `task` 900, `heavy_task` 2400; ceiling, not target; `0` = unlimited) · `self_review` (default false; `true` runs reviewer+fixer pass){{#if isolationEnabled}} · `isolated` ({{#if applyIsolatedChanges}}own worktree, successful changes applied to parent checkout{{else}}own worktree, changes kept as patch/branch artifacts{{/if}}){{/if}}. Legacy aliases `assignment`, `id`, `description`, `role` still accepted.
{{/if}}
Subagents start blank — no conversation history. Pass large payloads via `local://<path>` URIs, never inline.

# assignment-fmt
<assignment-fmt>
# Target
Role/objective (implementation delivers production behavior, not a plan) · Owns: exact write-owned files/symbols marked create/modify/delete · May read: exact reference files/patterns · Forbidden: other owners' files, generated files, lockfiles, unrelated cleanup · Non-goals.
# Pointers (no rediscovery)
Exact `path:line`/`path:symbol` for every edit site plus the `file:symbol` pattern to mirror; the decisive code pasted inline (current shape, intended shape when known); what NOT to read. Every anchor comes from a read you actually did — never an invented line, symbol, or command.
# Change
1. Current behavior → desired observable result. 2. Ordered requirements with exact inputs, outputs, errors, state transitions. 3. The LOCKED contract quoted — never inferred field names. 4. The existing `file:symbol` pattern/helper to mirror instead of a second convention. 5. Required edge/error cases and invariants — include the adjacent cases the intent obviously needs. 6. Wiring/callsites this task owns vs another task or the parent. 7. Safe assumptions; local uncertainty stays with the owner unless it contradicts a locked contract.
# Acceptance
1–2 focused, copy-pasteable checks with exact cwd and setup, verified against the repo's manifest/harness/existing tests; expected exit and decisive output per check; behavior changes exercise the changed path plus one designed failure path; tests name observable branches, never implementation details. NEVER project-wide gates.
# Done
Yield the moment every Acceptance item passes — no polish, no unrequested gates, no suites, no formatters. Deliverable form (default: uncommitted working-tree edits). Report files + symbols changed and each Acceptance item as `command/check → decisive output`, plus deviations, assumptions, unresolved risks, blockers. Stop conditions (defaults: on-disk contract differs from LOCKED; correctness needs a forbidden edit; an Acceptance command stays unusable after setup; ambiguity changes public behavior; plus task-specific ones) → return `BLOCKED` with condition, evidence, attempts, decision needed; NEVER redesign a locked contract or broaden scope. Completion = production code + Acceptance evidence (read-only tasks: the requested evidence).
</assignment-fmt>
Tier profiles (`quick_task` one locked mechanical concern and one decisive check · `task` one contained senior slice · `heavy_task` one indivisible load-bearing objective with staged gates) and a gold-standard example: `skill://subagents-development`.

# Available agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
Specialists before generic tiers: read-only research → {{#if scoutAvailable}}`scout`; broader exploration → `explore`{{else}}an available read-only specialist; broader exploration → `explore`{{/if}} · architecture/work breakdown → `plan` · UI/UX design lead → `designer` · frontend/UI implementation → `frontend_ui` · UI/UX review → `ui_ux_reviewer` · UX copy → `ux_copywriter`. Generic tiers by depth: `heavy_task` (load-bearing, cross-module, expensive-if-wrong; richest review with `self_review: true`) · `task` (routine medium slice) · `quick_task` (locked mechanical or small contained change; fastest, fans out widely). `self_review` is opt-in per spawn: leave false for work you verify yourself; set true for load-bearing, cross-module, correctness/security-critical work or work you will not verify.
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY){{/if}}{{#if blocking}} (BLOCKING: inline result){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation; do edits yourself or assign to a writing agent.{{/if}}
{{/list}}
{{/if}}
