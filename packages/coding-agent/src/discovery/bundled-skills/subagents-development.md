---
name: subagents-development
description: MANDATORY for delegated implementation. Defines ready-horizon packages, exclusive production ownership, minimal contract prefixes, bounded correction, and the rule that tests/maps/reviews never occupy the critical path without a production-code owner.
---

# Subagents Development

Many small owners beat one big agent: a 5-package fan-out with tight scopes finishes faster and drifts less than one agent holding a giant context. But a bad decomposition (vague scopes, shared files) is worse than solo work.

## Decomposition rules
- Use only as many packages as are ready and genuinely independent. One package is valid; 5–10 is a possible upper fanout, never a quota. Padding increases collisions and coordination cost.
- One package = ONE executable concern, clear file ownership (exclusive preferred; same-file overlap is safe — per-file edit locking serializes, agents preserve peer edits), ≤~5 files, and 1–2 acceptance checks it runs itself.
- Lock only the minimum shared type/schema required by the NEXT executable slice, then dispatch. NEVER pre-lock contracts for later phases.
- Assignment uncertainty inside one package belongs to its owner. State assumptions and dispatch; only a contradictory/impossible shared contract blocks that package. Do not “settle design” indefinitely.

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
