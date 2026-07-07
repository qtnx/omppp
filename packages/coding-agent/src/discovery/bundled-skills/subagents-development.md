---
name: subagents-development
description: MANDATORY when delegating implementation to subagents, orchestrating parallel work, splitting a feature into work packages, or dispatching task/quick_task/heavy_task agents. Contains the 5–10-package decomposition rules, exclusive file ownership, a fully-filled gold-standard assignment to copy, git-worktree isolation for parallel agents, serialize-vs-parallelize lists, and the integration protocol for returned work.
---

# Subagents Development

Many small owners beat one big agent: a 5-package fan-out with tight scopes finishes faster and drifts less than one agent holding a giant context. But a bad decomposition (vague scopes, shared files) is worse than solo work.

## Decomposition rules
- Target 5–10 packages for a typical multi-file feature — but only as many as have GENUINELY independent ownership. Padding to hit a number creates merge conflicts.
- One package = ONE concern, exclusive ownership of its files (no two agents touch the same file), ≤~5 files, 1–2 acceptance checks the subagent can run ITSELF.
- Interface-first: lock shared types/contracts/schemas SERIALLY yourself (or one plan pass), write them down, then fan out all independent slices in ONE parallel batch call.
- A package's assignment is self-contained for a reader with ZERO conversation history: every path, symbol, contract, and decision named. If you can't write it that precisely, the design isn't settled — settle it first.

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
  - npx vitest run test/middleware/rateLimit.test.ts → green; tests cover:
    under-limit passes, over-limit 429 with envelope fields, window reset restores access.
  - npx tsc --noEmit → clean.

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

## Route work to the right agent
Scouting/facts → `explore` (read-only). Plans → `plan`. Library research → `librarian`. UI design/build/review/copy → `designer`/`frontend_ui`/`ui_ux_reviewer`/`ux_copywriter`. Review → `reviewer`. Verification → `qa`/`browser_qa`. Second opinion → `oracle`. `quick_task`/`task`/`heavy_task` = implementation ONLY: quick_task for mechanical locked-spec work you verify yourself; task for contained slices (self_review when you won't verify closely); heavy_task for load-bearing/risk-adjacent work with strict acceptance + self_review.

## Serialize vs parallelize
SERIALIZE: architecture decisions, shared contracts, DB schema, state machines, money/auth logic, final integration, final review. PARALLELIZE: independent modules, frontend+backend after the contract locks, tests from a locked matrix, mechanical edits, adapters behind one interface, docs/config.

## Integration protocol (when packages return)
1. Claims without evidence are re-run or rejected — never trusted.
2. Check each report against its LOCKED contract; contradictions between packages resolved by you, not by whichever landed last.
3. Strip scope creep: edits outside the package's Target are reverted unless obviously required and reviewed.
4. Merge serially, run cross-cutting gates yourself (typecheck, affected tests), then the entry-point probe per skill://verify-before-done.
5. Non-trivial integrations → background a `qa` agent with the full harness handoff (commands, ports, env, seed, what you ran + evidence).

## Anti-patterns
One vague "build the feature" mega-task; two agents editing one file; implementers inventing behavior where the assignment was silent (that's your spec gap — fix the assignment); dispatching before contracts lock; merging without gates; trusting "done" without the Acceptance evidence.
