---
name: parallel-fanout
description: MANDATORY before any multi-file task, foundation phase, scout dispatch, or subagent wave planning. Contains the 7-phase fanout pipeline, the feature-slicing dimension table, the contract-vs-runtime (C/R) dependency test, the tier table, the wave-plan table every dispatch must fill first, a worked WRONG-vs-RIGHT example, the one-workflow rule (a whole wave plan executes as ONE workflow script), the one-wave scout fanout with a two-wave exploration budget, and the full-cycle rule — one subagent owns red test + implement + fix until green.
---

# Parallel Fanout

Wall-clock on the dependency-DAG critical path is THE metric. Two failure modes burn most sessions: a "foundation" phase executed as a serial chain of subagents, and TDD phases split across agents ping-ponging forever. This is the mechanical process that prevents both. Follow it phase by phase; the wave-plan table in Phase 4 is a REQUIRED artifact before any dispatch.

## The pipeline — seven phases, one pass

| # | Phase | Action | Output artifact | Exit criteria | Budget |
|---|---|---|---|---|---|
| 0 | Scout | Unknown territory only: dispatch 3–5 `explore` scouts in ONE parallel batch (aspects below) | facts with file:line | every SHARED contract shape known, or assumption stated | ≤2 waves, hard cap |
| 1 | Inventory | List deliverables as concrete nouns: files/module/endpoint/screen + its tests | deliverable list | zero "foundation/core/setup" entries — every entry names files | minutes |
| 2 | Dependency matrix | For each edge, name the exact symbol B needs from A; label C (contract) or R (runtime) via the C/R test | labeled edge list | every edge labeled | minutes |
| 3 | Contract prefix | Write ALL shared types/interfaces/schemas/signatures into their real files yourself (or one `plan` pass); typecheck | contract files, green typecheck | every C-edge satisfied; NO logic, NO tests written | one pass, minutes |
| 4 | Wave plan | Fill the wave-plan table: package, owned files, deps, kind, tier, wave, acceptance | wave-plan table | exclusive file ownership; wave 1 = every package whose edges are all C | minutes |
| 5 | Dispatch | Wave 1 as ONE parallel `task` batch; each package full-cycle (red test + implement + fix → green). Wave-2 package dispatches the moment ITS upstream lands | running subagents | all ready packages in flight simultaneously | immediate |
| 6 | Integrate | Serial merge per landing; reject evidence-free claims; strip scope creep | merged diff | each package's OWN tests green | per landing |
| 7 | Gates | Project-wide check/lint/affected tests ONCE; entry-point probe per skill://verify-before-done | evidence transcript | green + probe output | once, at the end |

Phases 1–4 are planning on paper — minutes total, no subagents except Phase 0 scouts. If you cannot fill the wave-plan table, the design is not settled; settle it, do not dispatch.

## How to slice a feature — pick the dimension that yields exclusive files

| Dimension | Cut here when | Package examples |
|---|---|---|
| Vertical sub-feature | the feature has independently usable parts | "export chat", "pin message", "search history" — each full-cycle, including its UI slice |
| Layer against a locked interface | parts share ONE data flow but only types cross the boundaries | repository / domain service / route-handler / UI as 4 packages against `contracts.ts` |
| Adapter boundary | several providers/integrations behind one interface | one package per provider adapter + shared interface in the prefix |
| Mechanical perimeter | registrations, renames, config, wiring, docs | one `quick_task` batch package |
| Cross-owner integration | a test must execute several owners' REAL code together | exactly ONE integration package, wave 2 |

Correct dimension chosen = 5–10 packages, exclusive file ownership, every cross-package edge is C. If a cut produces shared files or R-edges everywhere, pick a different dimension — do not force it.

## The C/R dependency test — apply to every edge

| Edge looks like | Test question | Label | Action |
|---|---|---|---|
| B imports A's types/interface/schema only | "Do B's tests execute A's code?" → NO | C | lock the shape in Phase 3; A and B run in PARALLEL |
| B's tests must call A's working code | → YES | R | B goes to wave 2 behind A — or stub A behind the locked interface when a stub is cheap, then B joins wave 1 |
| A and B edit the same file | — | conflict | re-cut ownership until files are exclusive; two agents NEVER share a file |

Default: assume C until proven R. Nearly every "foundation first" serialization is a C-edge wearing an R costume — types flow, not behavior.

## Tier table — per package, after slicing

| Tier | Use for | Notes |
|---|---|---|
| `quick_task` | mechanical locked perimeter: renames, wiring, boilerplate, config | fastest; fan out widely |
| `task` | contained senior slice — the default for wave-1 packages | `self_review: true` when you won't verify closely |
| `heavy_task` | ONLY the indivisible RISK/load-bearing core | slowest; before every `heavy_task`, split off every `task`/`quick_task`-ownable slice — a heavy package with 2+ independent concerns MUST split |
| `frontend_ui` (+ `designer`, `ui_ux_reviewer` bundle) | any UI slice | specialist routing overrides tiers |
| `explore` / `plan` / `librarian` | facts / architecture / external APIs | never implementation |

## Wave-plan table — fill before dispatch, verbatim shape

| Pkg | Owns (files) | Needs from others | C/R | Tier | Wave | Acceptance (runs itself) |
|---|---|---|---|---|---|---|

Worked example — persistent chat + document store + tool registry + migration + UI.

WRONG (stalls the session): `Foundation: contracts → repositories → registry → orchestrator → migration` as 5 serial dispatches — only TYPES flow between them — plus RED-agent → implement-agent → fix-agent loops per item.

RIGHT — prefix: parent writes `src/chat/contracts.ts` + `src/docs/contracts.ts` (`ChatDocument`, `ChatRepository`, `ToolRegistry`, `OrchestratorEvents`), typecheck green, then:

| Pkg | Owns (files) | Needs from others | C/R | Tier | Wave | Acceptance (runs itself) |
|---|---|---|---|---|---|---|
| P1 SqliteChatRepository | src/chat/repo-sqlite.ts + test | ChatRepository iface | C | task | 1 | its test green: CRUD + empty/missing-doc paths |
| P2 DocumentStore | src/docs/store.ts + test | ChatDocument type | C | task | 1 | its test green: persist/load/version |
| P3 ToolRegistryExecutor | src/tools/registry.ts + test | ToolRegistry iface | C | task | 1 | its test green: register/execute/unknown-tool error |
| P4 ChatOrchestrator | src/chat/orchestrator.ts + test | ifaces only; fakes repo behind ChatRepository | C | task | 1 | its test green: event flow + error paths |
| P5 BusinessToolsEvents | src/tools/events.ts + test | OrchestratorEvents type | C | quick_task | 1 | its test green: mapping table |
| P6 ChatPanel UI | ui/ChatPanel.tsx + story | ChatDocument type | C | frontend_ui | 1 | story renders states: loading/empty/error/filled |
| P7 WireAndIntegrate | src/chat/index.ts + integration test | P1+P3+P4 working code | R | task | 2 | integration test through the real entry point |
| P8 MigrateLegacyEvents | scripts/migrate-events.ts + test | P5 working code | R | task | 2 | idempotent dry-run + count verification |

Wave 1 = ONE `task` batch of P1–P6 (six agents in parallel). P7 dispatches when P1+P3+P4 land; P8 when P5 lands. Each assignment pastes in: owned files, forbidden files, the locked contract snippet, acceptance commands, and "done = your Acceptance passes".

## Plan lock — one critique round, then dispatch

- The wave plan earns AT MOST ONE critique round (super_review/reviewer). Triage findings: BLOCKING = a reproducible defect in the planned path, a security violation on the requested path, a contradictory/impossible contract, or unguarded irreversible harm. Everything else (hypothetical hardening, future ops, coverage breadth, later-task edge cases) = a deferred NOTE — one line in the plan, never a redesign.
- Apply blocking fixes once → LOCKED → dispatch in the SAME turn. Re-review only on new material EXECUTION evidence (failing gate, contract contradicted by code, changed requirement). Wording edits never reopen review.
- Existing-plan fast path: an approved plan/brief with file ownership and acceptance commands already in the repo/session IS the locked plan — skip Phases 0–3, reuse/fill the wave-plan table, dispatch immediately.
- Stall rule: 2 consecutive turns of plan/review artifacts with zero dispatch → the next turn dispatches with stated assumptions.
- Locked = execute: reason about each step internally as you go; never write a per-step plan, mini-plan, or plan restatement between steps. The wave-plan table is the LAST planning artifact — after it, the only planning writes are a one-line amendment on a concrete contradiction and todo status updates.

## One workflow run = the whole wave plan

When the `workflow` tool is available and the wave-plan table has 4+ packages or any wave-2 row, execute the ENTIRE plan as ONE `workflow` script. NEVER drip per-package one-off dispatches for a plan a script can run, and NEVER split one wave plan across several workflow runs — design the script so that when it returns, only your integration check remains.

`workflow` runs IMPLEMENTATION phases only — never scouting or planning (scout = ONE parallel `task` batch of `explore` agents; planning happens before scripting). The whole job closes in 1–2 workflow runs total; review/QA/repair phases belong to the final integration phase, not inside intermediate-task runs.

```js
export const meta = { name: "chat-fanout", description: "wave plan P1-P8", phases: ["wave1", "wave2", "gates"] };
// Contracts (Phase 3) are already locked BEFORE scripting. Each agent prompt below is a
// complete work-package assignment: owned files, forbidden files, pasted contract snippet,
// acceptance commands, "done = your tests pass".
phase("wave1");
const w1 = await parallel([
  () => agent("P1 SqliteChatRepository — full-cycle: red test + implement + fix until green. Owns src/chat/repo-sqlite.ts + test. Forbidden: everything else. Contract: <paste ChatRepository>. Done = your tests pass; report files + test output.", { agentType: "task", label: "P1" }),
  // … P2–P5 same shape, tier per the wave-plan table …
  () => agent("P6 ChatPanel UI — owns ui/ChatPanel.tsx + story; states: loading/empty/error/filled. Contract: <paste ChatDocument>.", { agentType: "frontend_ui", label: "P6" }),
]);
phase("wave2"); // R-packages run after the wave-1 barrier
const w2 = await parallel([
  () => agent("P7 WireAndIntegrate — integration test through the real entry point. Owns src/chat/index.ts + test. Upstream results: " + JSON.stringify([w1[0], w1[2], w1[3]]), { agentType: "task", label: "P7" }),
  () => agent("P8 MigrateLegacyEvents — idempotent migration + dry-run + count verification. Owns scripts/migrate-events.ts + test.", { agentType: "task", label: "P8" }),
]);
phase("gates");
return await agent("Run repo gates across the union of changed files (typecheck + affected tests) and the entry-point probe; report command + decisive output.", { agentType: "task", label: "gates" });
```

Rules: one wave = one `parallel([...])` (use `pipeline()` for per-item chains like implement → verify); wave-2 thunks sit after the wave-1 barrier; the final stage runs gates so the workflow CLOSES the task. After it returns, you still own correctness: read the reports, spot-check evidence, reject claims without it.

## Full-cycle ownership — never split TDD across agents

- One package = its Acceptance driven to green inside ONE subagent — red test + implement + fix where the slice earns tests; build + real render/run probe for runs-first slices. Exit condition = ITS OWN acceptance passing.
- BANNED: a "write failing tests" agent, then an "implement" agent, then a "fix" agent over the same files. Each hop re-pays dispatch latency, loses the context the previous agent built, and the loop can cycle indefinitely.
- A separate test package is legitimate ONLY for cross-owner integration (the wave-2 R-package); unit/behavior tests for a slice belong to the slice's owner.

## Test budget — the Acceptance column scales with criticality

"Does it RUN?" is proven for every package (its Acceptance runs the real thing); how much test AUTHORING a slice earns depends on what breaks if it breaks:

| Tier | Surfaces | Acceptance shape |
|---|---|---|
| CRITICAL | money/ledger, auth/tenant isolation, data integrity/migrations, published API contracts, load-bearing backend logic | full targeted coverage — branches, edge values, error paths, invariants; green focused suite is the gate (P1–P4 above) |
| STANDARD | ordinary backend/services/libraries — and FRONTEND LOGIC: state machines, reducers/stores, form validation, transforms, calculations, permission/routing guards | targeted tests on the changed behavior only |
| RUNS-FIRST | the render/wiring surface ONLY: screens/components/styling, internal tools, admin dashboards, demos, one-off scripts | the real run: story/page renders its states, CLI probe happy path + one failure path (P6 above) |

Tier comes from blast radius, never file extension — a FE slice carrying auth/payment logic is CRITICAL, and FE logic is NEVER runs-first: when a UI package embeds real logic, cut it as its own STANDARD/CRITICAL logic package with tests (a store/reducer/validation module the component imports), leaving the component shell as the runs-first slice. On RUNS-FIRST slices, NEVER chase coverage or full-suite green; a pre-existing unrelated red test is reported to the parent, not adopted.

## Scout fanout — Phase 0, one wave, many aspects

| Aspect | Scout returns |
|---|---|
| Structure | entry points, module map, where the change lives |
| Contracts | exact types/interfaces/schemas touched, file:line |
| Prior art | newest similar feature to mirror, full anatomy |
| Test posture | harness, run commands, sibling test locations |
| Blast radius | callsites/risk hotspots of symbols to change |

Dispatch ALL applicable scouts in ONE parallel batch; skip aspects you already know. Scouts return compressed FACTS with file:line evidence — never designs. Budget: wave 1 + at most ONE follow-up wave for a NAMED contract gap ("exact shape of X?"), then run Phases 1–5 with stated assumptions. Unknowns INSIDE one package never hold dispatch — the owning subagent resolves them; only a SHARED-contract gap may hold Phase 3.

Stall signals — any one means lock contracts NOW and dispatch: scouts fired one at a time; re-reading files a scout covered; a foundation todo list that grew since the last wave; "let me also check…" with no package blocked on the answer. Every wave must end in an artifact (locked contract, dispatched packages, integrated diff); two waves of pure "understanding" = stall.

## Anti-patterns

Serial-chained "foundation" subagents when only types flow between them; phase-split TDD agents (red → implement → fix ping-pong); dispatching without a filled wave-plan table; waterfall dispatch one agent at a time; holding a ready package to batch with future ones; exploring the whole repo before cutting packages; re-scouting what a scout already returned; blocking the fanout on a question no package needs answered; two agents sharing a file.
