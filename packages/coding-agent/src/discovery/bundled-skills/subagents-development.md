---
name: subagents-development
description: MANDATORY for delegated implementation. Defines ready-horizon packages, exclusive production ownership, minimal contract prefixes, bounded correction, and the rule that tests/maps/reviews never occupy the critical path without a production-code owner.
---

# Subagents Development

Many small owners beat one big agent: a 5-package fan-out with tight scopes finishes faster and drifts less than one agent holding a giant context. But a bad decomposition (vague scopes, shared files) is worse than solo work.

## Decomposition rules
- Use only as many packages as are ready and genuinely independent. One package is valid; 5–10 is a possible upper fanout, never a quota. Padding increases collisions and coordination cost.
- One package = ONE executable concern, clear file ownership (same-file overlap is safe — per-file edit locking serializes, agents preserve peer edits), ≤~5 files, and 1–2 acceptance checks it runs itself.
- Lock only the minimum shared type/schema required by the NEXT executable slice, then dispatch. NEVER pre-lock contracts for later phases.
- Assignment uncertainty inside one package belongs to its owner. State assumptions and dispatch; only a contradictory/impossible shared contract blocks that package. Do not “settle design” indefinitely.

## Handoff formula
`H := goal + workspace/current state + owned paths/symbols + evidence-backed anchors + locked contract + dependencies/ownership + acceptance + stop conditions + applicable repoSpec excerpts` (the system prompt's definition, restated for readers without it; realized as the task tool's assignment-fmt)
- The parent completes reconnaissance before dispatch. Send H once with decisive excerpts and exact `skill://`/context-file paths; a child that can act from H NEVER repeats repo-wide discovery.
- Child order: `read(forwarded skill/context when absent) → read(named anchors) → edit/check`; widen only for a stale anchor, a direct dependency required for correctness, or a missing contract, and report `Rediscovery: <path/symbol> — <reason>`.
- For a heavy Git conflict, use `skill://git-craft`'s conflict fanout contract: both-side diffs and intent per disjoint cluster; parent owns shared/generated/lock files and final integration.

## Gold-standard assignment — copy this shape, filled to this density
```
TARGET
  Owns: src/middleware/rateLimit.ts (new), src/middleware/index.ts (add export only),
        test/middleware/rateLimit.test.ts (new)
  Forbidden: src/server.ts, src/routes/** (wired by another package), any config file
  Non-goals: no Redis-backed store (in-memory only this package); no per-user tiers

CHANGE
  1. Create rateLimit(opts: {windowMs: number; max: number}) returning an Express
     middleware, keyed by req.ip, using a Map<string,{count,resetAt}> store.
  2. Over limit → respond 429 with the repo's error envelope
     {error:{code:"rate_limited", message:string, retryAfterMs:number}} —
     envelope shape is LOCKED, see src/lib/errors.ts::sendError, use it, do not inline JSON.
  3. Expire entries lazily on access; no timers.
  4. Export from src/middleware/index.ts following the existing named-export pattern.

ACCEPTANCE (run these yourself)
  - `<repo test command>` → green; tests cover:
    under-limit passes, over-limit 429 with envelope fields, window reset restores access.
  - `<repo typecheck command>` → clean.
    Resolve these placeholders to exact commands from the repository before dispatch.

DONE (report)
  Files changed; per-acceptance evidence (command + output); deviations from CHANGE
  with reasons; unresolved risks. STOP AND ESCALATE instead of guessing if: the error
  envelope doesn't fit 429 semantics, or Map memory growth seems unbounded for the
  stated traffic assumption.
```

## Isolation for true parallelism — git worktrees
Exclusive-ownership rules on paper still break when agents share a working tree (lockfiles, generated files, formatters). Physical isolation:
```bash
git worktree add ../wt-pkg1 -b agent/pkg1   # one per package
# dispatch each agent with cwd = its worktree
# integrate serially: merge/cherry-pick each branch, run gates between
git worktree remove ../wt-pkg1 && git branch -d agent/pkg1
```
Shared worktree? Generated files, lockfiles, registries, and formatters belong to one integration owner. NEVER create sibling agents on another owner's files; resume the owner, max two corrective iterations TOTAL per package.

## Route work to the right agent
Scouting/facts → `explore`; plans → `plan`; library research → `librarian`; UI → specialists; review → `reviewer`; verification → `qa` only when selected. Generic tiers implement production code. A locked execution wave MUST include a production owner; RED tests and seam maps belong inside that owner's package.

## Serialize vs parallelize
SERIALIZE only the minimum current-path architecture/contract/schema/risk decision and final integration. PARALLELIZE independent production slices with their tests, adapters, wiring, and later cleanup. Independent future concerns NEVER enter current Foundation.

## Integration protocol (when packages return)
1. Claims without package acceptance evidence return to the SAME owner; max two corrections TOTAL per package across all failures.
2. Check the locked current-slice contract; future hardening notes never reopen it.
3. Reject scope creep without creating a new Foundation task.
4. Merge landings and run only failure-matched cross-cutting gates.
5. Dispatch independent QA only when the lane, external harness, or user requires it; QA never starts before production implementation exists.

## Anti-patterns
One vague mega-task; package quotas; planning future rows; RED-only/seam-map waves; sibling fixer churn; reverting or clobbering a sibling's edits in shared files; serial Foundation; dispatch blocked by local unknowns; unconditional QA/gates; trusting evidence-free completion.

## Work package contract — what every batch and assignment must carry
Every assignment MUST be executable by a reader with ZERO conversation history. Shared batch context names the Goal (observable outcome, repo/worktree, cwd, current state, exact bootstrap/run commands — never invented), Constraints (repo rules, batch non-goals, safe assumptions, shared-file ownership, parent-only broad gates), and Contract (literal shared signatures/types/schemas/error shapes pasted or cited as an exact readable `file:symbol`, ownership map, dependencies, explicitly OPEN local choices). Every named path, symbol, caller count, contract, and command MUST be grounded in repo/tool evidence before dispatch; unknown → read it first or mark the package `BLOCKED`.

Each assignment follows the task tool's assignment-fmt (Target / Pointers / Change / Acceptance / Done): exact write-owned files and symbols marked create/modify/delete, read-only references, forbidden files, non-goals; `file:line` anchors for every edit site with the decisive code pasted inline and what NOT to read; current → desired behavior with the locked contract quoted and the `file:symbol` pattern to mirror; 1–2 copy-pasteable focused checks with cwd, expected output, and one failure path for behavior; the deliverable form and the report shape (`command/check → decisive output` per Acceptance item, deviations, assumptions, unresolved risks).

Default stop conditions (every assignment names them): on-disk contract differs from LOCKED; correctness requires a forbidden edit; an Acceptance command remains unusable after its documented setup; ambiguity materially changes public behavior. The owner returns `BLOCKED` with condition, evidence, attempts, and decision needed; it NEVER silently redesigns a locked contract or broadens scope. Implementation packages complete only with production code and Acceptance evidence; read-only packages only with the requested evidence.

## Tier profiles — each tightens assignment-fmt, never replaces a section
- `quick_task` — one locked mechanical concern: list every file/symbol or an exact enumerable pattern with the expected match count; prescribe the transformation completely (no architecture, API, edge-case, or product decision left open); one cheapest decisive check (a behavior probe only when runtime behavior changes); minimal report, 1–3 bullets per section, shared context never repeated. Contract mismatch, unexpected cross-module work, or an unbounded match set → `BLOCKED`, never "investigate".
- `task` — one contained senior slice across a few files with explicit write ownership and integration boundary; lock local/public contracts, edge/error behavior, reference pattern, callsites, owned wiring; 1–2 focused checks covering changed behavior and one failure path; production slice + evidence; broader architecture or a newly discovered RISK boundary → `BLOCKED`.
- `heavy_task` — one indivisible load-bearing objective after all independent mechanical/perimeter work is split off: primary files, affected modules, forbidden siblings, callsite/blast-radius denominator; locked interfaces and state transitions; invariants, failure modes, concurrency/data-integrity concerns, integration order, explicit non-goals; staged focused gates plus the required execution-harness rung with realistic success input, failure input, expected output/state, and rollback/observability checks when risk requires them; report production result, caller-migration count, evidence per stage, residual risk. A contract/risk contradiction → `BLOCKED`; NEVER ship a partial core or compatibility fallback.

## Heavy-task decomposition gate
Before EVERY `heavy_task`, split off ANY independently ownable `task`/`quick_task` slice; keep ONLY the indivisible RISK/load-bearing core in `heavy_task`. A heavy package with 2+ independently ownable concerns MUST split. Skip splitting ONLY when ownership cannot be cut, contracts cannot pre-lock, the package is wholly RISK-core, or integration overhead exceeds the latency saved. NEVER down-tier RISK/load-bearing work to hit a wall-clock target.

## Assignment quality — verify before sending
Self-contained (no "as discussed", bare pronouns, hidden decisions, unstated setup) · source-grounded (every path, symbol, count, contract, command exists) · anchored (`file:line` sites with decisive code pasted) · scoped (one concern, exact write ownership, explicit non-goals) · contract-locked (shared shapes, ownership, OPEN choices agree across tasks) · verifiable (commands runnable as written, expected evidence concrete) · bounded (stop conditions yield a decisive `BLOCKED`).
WRONG: "Fix the spinner bug in the event controller and make sure tests pass." RIGHT: the gold-standard assignment above — owned files with symbols, anchors with pasted code, the exact change, one copy-pasteable check with expected output, and the report shape.
