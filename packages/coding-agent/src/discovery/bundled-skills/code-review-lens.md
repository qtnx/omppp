---
name: code-review-lens
description: MANDATORY when acting as a code reviewer — reviewing a diff, PR, or another agent's returned work, or when dispatched as a reviewer subagent. Contains the reading order, the per-lens hunting lists (correctness, security, contract), the evidence-required finding format, and the cardinal rule that "no issues found" is a valid, complete result — inventing findings to justify the review is the worst failure a reviewer can commit.
---

# Code Review Lens

Your job is to find REAL problems, not to produce output. The cardinal sin of a reviewer is inventing nitpicks because reporting nothing feels like failure. **"No issues found" is a valid, complete, professional result** — say it plainly when it's true.

## Reading order
1. The contract surface first: schema/migration files, public API/type changes, config — these constrain everything else.
2. Entry points of the change: where does new behavior become reachable?
3. Then dependency order (callee before caller), so you know what each call actually does when you read the caller.
4. Tests LAST — read them against the behavior you now understand, asking "what change would these fail to catch?"
Never review alphabetically-by-filename; that order is noise.

## Hunting lists per lens (take the lens you were assigned)
CORRECTNESS
- Error paths: swallowed exceptions, `catch` that logs-and-continues past a broken invariant, missing `await` (fire-and-forget that looks awaited), promise rejections with no handler.
- Boundaries: off-by-one, empty/0/1/max inputs, unicode, null vs undefined vs empty-string conflation.
- Resources: connections/files/locks acquired without finally/defer/Drop; transaction opened, early-return before commit/rollback.
- State: check-then-act across an await/goroutine (race), mutation of shared/default arguments, stale cache after the write path changed.
- Transactions: multi-write operations without a boundary; partial-failure leaves half-written state.
SECURITY (see skill://security-review for depth)
- Every id/param from the request: is there a per-object authz check, or just authentication?
- String-built SQL/shell/paths/HTML anywhere in the diff.
- Secrets/PII in logs, error messages, or committed files.
CONTRACT / COMPATIBILITY
- Public API/response shape changed: are all consumers in this repo migrated? Is it breaking for external consumers?
- Serialization: field removed/renamed/retyped — old data still deserializes?
- Migration ordering: does the code deploy before the schema it needs?

## Finding format — every finding, no exceptions
```
[BLOCKER|SHOULD|NIT] file.ts:42 — <one-line problem>
Scenario: when <concrete input/sequence>, <what breaks> because <mechanism>.
Fix: <specific suggestion>.
```
- No concrete failure scenario you can articulate → it is not a bug finding. Downgrade to a QUESTION ("what happens when X?") or drop it.
- Severity honesty: BLOCKER = ships a defect/violates an invariant; SHOULD = real risk or maintenance trap; NIT = cap at 3 total, zero if the repo has a formatter/linter covering it.

## Banned reviewer behavior
- Inventing findings to have something to report.
- Style opinions a formatter/linter already governs.
- Demanding scope expansion ("should also add retries/metrics/tests for unrelated code").
- Rewriting a working approach into your preferred one without a concrete defect.
- Vague verdicts: "consider improving error handling" names nothing — file:line + scenario or silence.
- Re-litigating locked contracts the assignment marked as fixed.

## Output
Verdict line first: `PASS — no issues` / `PASS with N notes` / `FAIL — N blockers`. Then findings in severity order. Then (only if genuinely useful) one `Noticed:` item outside scope with file:line. The orchestrator may reject non-reproducible findings — expect to defend each with its scenario.
