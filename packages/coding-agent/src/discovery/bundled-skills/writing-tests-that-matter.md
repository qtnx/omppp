---
name: writing-tests-that-matter
description: MANDATORY when authoring tests. Defines criticality-based test budgets, behavior assertions, mutation checks, and the execution rule that implementation tests stay with the production owner instead of forming a RED-only critical-path package.
---

# Writing Tests That Matter

Coverage % is not the goal; a test suite is a tripwire field. Every test must be able to fail on a plausible mistake — if you cannot name the code change that would fail it, it is decoration: fix or delete it.

## Test budget — criticality sets the investment
"Does it RUN?" is proven for every change (entry-point probe per skill://verify-before-done); how much test AUTHORING the change earns depends on what breaks if it breaks:
- CRITICAL — money/payment/ledger, auth/permissions/tenant isolation, data integrity/migrations, published API contracts, load-bearing backend logic → full targeted coverage below; green focused suites are a completion gate.
- STANDARD — ordinary backend, services, libraries other code calls, AND frontend logic (state machines, reducers/stores, form validation, data transforms, calculations, permission/routing guards) → targeted tests on the changed behavior (priority list below); stop there.
- RUNS-FIRST — the render/wiring surface ONLY: screens, components, layout/styling, internal tools, admin dashboards, demos, one-off scripts → the real run is the primary evidence (browser/CLI probe: happy path + one failure path). Do NOT chase coverage or full-suite green here; a pre-existing unrelated red test is reported, not adopted.
Frontend LOGIC is never runs-first: extract it from the component where practical (store/reducer/validation module) and test it at its tier; only the thin rendering shell stays probe-verified. Tier comes from blast radius, not file extension: a frontend change carrying auth or payment logic is CRITICAL.
During an implementation task, RED tests + production code + fixes belong to ONE full-cycle owner. NEVER dispatch test-only work while no owner is changing production code. A separate test package is valid only for cross-owner integration after production owners are in flight or landed, or when the user's entire request is explicitly test-only.

## Target selection — what earns a test
In priority order, for the code you changed:
1. Every new/changed CONDITIONAL BRANCH — both sides.
2. BOUNDARIES — empty, 0, 1, max, one-past-max, unicode/emoji strings, very large input, duplicate entries.
3. ERROR PATHS — and assert the SPECIFIC error: code/type/message field, not just `expect(...).toThrow()`. A designed 422 and an accidental crash both "throw"; only the assertion tells them apart.
4. INVARIANTS across fields — totals reconcile, state machine only takes legal transitions, output sorted/unique when promised.
5. The bug you just fixed — regression test that fails on the pre-fix code (watch it red before green).
NOT worth tests: trivial getters, framework glue the framework already tests, private implementation details.

## Assert behavior through the public surface
Test what the caller observes, not how it's done inside. Reaching into privates or asserting "method X was called" (except at an external boundary) welds the test to the implementation — every refactor breaks it while real bugs slip past.

## Structure
- One behavior per test; name states the behavior: `rejects_expired_token`, not `test2`.
- Arrange-Act-Assert visibly separated.
- Table-driven for input matrices:
  - Go: `tests := []struct{name string; in X; want Y}{...}` + `t.Run(tt.name, ...)`
  - JS: `it.each([[in, want], ...])('%s', ...)` (vitest/jest)
  - Python: `@pytest.mark.parametrize("inp,want", [...])`
- Factories over copy-pasted fixtures: one `makeUser(overrides)` returning a valid default with per-test overrides — when the shape gains a required field, you fix ONE factory, not 60 literals.

## The mutation check (do it mentally, or actually)
For each test written, name the mutation it catches: "flip this `<=` to `<` → this test fails." Can't name one? The test asserts nothing. Spot check for real: temporarily break the code, confirm the test goes red, restore.

## Anti-flaky rules
- TIME: pin the clock — `vi.useFakeTimers()` / `freezegun` / inject a clock; never assert "createdAt is within 100ms of now".
- NO SLEEPS: `sleep(500)` then assert is a race with a timer. Await the condition: poll with timeout, or await the actual promise/event.
- ORDER: each test builds and tears down its own state; no test depends on another having run; DB tests wrap in a rolled-back transaction or truncate between.
- RANDOMNESS: seed it or inject it.
- NETWORK: unit tests never touch the real network; boundary fakes assert the OUTBOUND request (payload, headers) — the contract from your side.
- PARALLELISM: unique resources per test (temp dirs via mkdtemp, random free ports), never shared literal paths/ports.
A test that fails 1/50 runs is a bug NOW: reproduce with a 50x loop, fix the race, never mark-as-retry.

## Test doubles ladder
real > fake (in-memory impl honoring the contract) > stub (canned responses) > mock (interaction assertions). Take the realest that keeps the test fast and deterministic; mocks only at true external boundaries, and then assert what your code SENT, not merely "was called".

## Definition of done for a testing task
Suite green; every changed branch and error path exercised (name them); zero sleeps introduced; each new test passes the mutation check; run count printed as evidence (skill://verify-before-done).
