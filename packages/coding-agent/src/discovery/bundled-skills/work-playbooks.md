---
name: work-playbooks
description: Use for performance work (slow, optimize, latency, memory, profiling, benchmark) and for third-party integrations (external API, SDK, webhook, payment provider, OAuth). Contains the measure-first performance protocol with concrete profiling tools per stack, the attack order that puts caching LAST, and the resilient-client integration checklist with failure-path testing.
---

# Work Playbooks: Performance & Third-Party Integration

## PERFORMANCE — no baseline number, no perf work

### Protocol
1. BASELINE — measure the current state with a repeatable command on a fixed workload. Paste the number. No number = you are not doing perf work yet.
2. HYPOTHESIZE — name where the time/memory goes, based on a profile, not vibes.
3. CHANGE one thing.
4. RE-MEASURE with the SAME command on the SAME workload. Paste both numbers in the claim. Different dataset before/after = invalid comparison.
5. Guard the win: if the repo has perf tests/budgets, add or update one so the regression can't return silently.

### Measurement tools — pick by target
- CLI/process: `hyperfine 'cmd'` (statistical, warmup handled) — never a single `time` run.
- HTTP endpoint: `autocannon -d 20 -c 50 http://localhost:3000/x` or `wrk`; report p50/p99, not just mean.
- SQL: `EXPLAIN (ANALYZE, BUFFERS) <query>` — seq scans on big tables, estimate-vs-actual row gaps (skill://database-craft).
- Node: `node --cpu-prof app.js` or `npx clinic flame -- node app.js`; memory: `--heap-prof`, heap snapshots.
- Go: `import _ "net/http/pprof"` → `go tool pprof http://:6060/debug/pprof/profile`; benches: `go test -bench . -benchmem`.
- Rust: `cargo flamegraph`; benches: criterion.
- Python: `py-spy record -- python app.py` (no code change needed); `cProfile` for scripts.
- Frontend: browser tool → Performance panel trace; Lighthouse for page-level; bundle: `npx source-map-explorer dist/*.js`.

### Attack order — cheap and structural first
1. Measurement itself (confirm the hot spot is real).
2. Algorithm/complexity — the O(n²) loop, repeated recomputation.
3. N+1 and I/O patterns — query in a loop, chatty round trips → join/preload/batch.
4. Batching & pooling — connection reuse, bulk writes.
5. Caching — LAST, because a cache is a new invalidation bug you now own; define the invalidation story before adding it.
6. Micro-optimization — only with profiler evidence that the line matters; never contort cold code.

### Fresher traps
Optimizing unprofiled code; caching as first resort; benchmarking dev builds; comparing different datasets; "feels faster".

## THIRD-PARTY INTEGRATION — the provider's docs are the contract

### Before writing the client
Read the real docs for: error codes and their meanings, rate limits and the 429 contract (Retry-After?), pagination scheme, idempotency support, webhook signing, sandbox-vs-prod differences (different hosts? fake data quirks?). Write these into a comment block at the top of the client module.

### Client checklist
1. TIMEOUT on every call — connect and read; no infinite hangs. Pick a budget consistent with your own endpoint's SLA.
2. RETRIES only on idempotent operations (GET, or POST with an idempotency key the provider supports), with exponential backoff + jitter, capped attempts. Retry-on-plain-POST is a double-charge generator.
3. Rate-limit handling: honor 429/Retry-After; don't hammer.
4. Errors mapped: provider error codes → your domain errors; never leak raw provider payloads to your users.
5. Secrets from env only; never logged, never in code; `.env.example` updated with placeholder names.
6. Pagination: consume it fully or deliberately — never silently take page 1 as "all".
7. Webhooks: verify the signature with the provider's scheme BEFORE trusting the payload; handle replays idempotently (event id dedup); respond fast, process async.

### Verifying (per skill://verify-before-done)
- Sandbox reachable → exercise the real sandbox flow, assert response + your persisted state.
- Not reachable → SHRINK the boundary: a localhost stub server returning the DOCUMENTED shapes (success, 429, 500, timeout), base URL via env; your real HTTP client, serialization, retry, and error mapping still execute. Assert the OUTBOUND request your code produced (auth header present, payload shape) — the stub verifies your side of the contract too.
- Failure paths are mandatory: simulate 429, 500, and timeout; assert your code degrades as designed (retry then designed error, no double side effects, no unhandled rejection).

### Fresher traps
No timeout; retry-on-POST; ignoring pagination; trusting webhook payloads unsigned; assuming sandbox == prod; catching provider errors and returning generic 500 with no mapping; inventing API fields from memory instead of the docs.

# Codebase profile — read the signals with tools; each one changes strategy
- TEST POSTURE — glob for test/spec files beside the target; CI config presence. covered / partial / none. None → the compiler and your own checks are the only net; build one before restructuring.
- TYPE SAFETY — language plus strictness flags (tsconfig strict, mypy config, warnings-as-errors). strong / weak / none. Strong types let you refactor by "break it and follow the errors"; weak types mean grep is lying to you — verify at runtime.
- GATES — the repo's OWN definition of green: CI workflows, lint/format configs, test commands in the manifest. Run THOSE gates, in their configuration; never invent parallel ones.
- CONVENTION CONSISTENCY — sample 2–3 sibling modules of the same kind. uniform / fragmented (+ which pattern dominates or is newest).
- BLAST RADIUS — a references lookup (LSP when available) on every symbol you will change. The count is your migration denominator and a lane input.
- CHURN — commit frequency on the target path (git log is permitted as research). Hot file = load-bearing = someone depends on every quirk; cold file with no tests = archaeology, characterize before touching.
- DEBT DENSITY — TODO/FIXME, commented-out blocks, duplication near the target. High debt is context, not license: match the area's conventions, don't extend its debt.
- SOURCE OF TRUTH — README/ADRs/API specs/schema files. Docs and code disagreeing is an interview trigger, not a coin flip.
- OBSERVABILITY — existing logs/metrics around the target (weighs into L3 rollout/rollback design).
- DEPENDENCY FRESHNESS — lockfile state of libs you'll touch; a lib 3 majors behind means online docs describe an API you don't have. Read the installed version.

Profile buckets and the strategy each dictates:
- GREENFIELD — nothing exists. Your choices become law: boring, dominant-ecosystem defaults; one pattern per concern; the README/run/test instructions and the first tests are part of the deliverable — they are the template everyone copies.
- DISCIPLINED — tests + CI + consistent conventions. Move fast; the harness is your net. Conform exactly: your diff should read as if the team wrote it.
- LEGACY-UNTESTED — no net. Safety first: characterization tests pinning CURRENT behavior (bugs included) around the change area BEFORE restructuring; smaller verified steps; no drive-by modernization.
- FRAGMENTED — competing patterns. Identify the dominant or newest-blessed one and follow it; if genuinely split, ask which is canonical. NEVER add pattern #3.

# Work-type playbooks — definition of done and fresher traps per type
Senior defaults across all types: understand before fixing, read before writing, conform before inventing, measure before optimizing, migrate before deleting, prove before claiming.

## BUG FIX
- Reproduction is evidence, not ritual. The user's observation plus the code path that explains it IS the reproduction; materialize a failing test or command only when the cause is not evident from the code, the fix is on the RISK list, or the user asks. NEVER build a harness to reproduce what a targeted read already explains. Cause not findable and not reproducible → that IS the finding; report what's missing.
- Walk the causal chain to the frame that VIOLATED the invariant, not the frame that noticed it. The top of the stack trace is where it hurt, rarely where it broke.
- Ask "why did no test catch this?" — the answer names where a regression test belongs; write it only when the test budget earns it (RISK, or an uncovered load-bearing branch); otherwise the run is the evidence.
- Fix the CLASS, not the instance: ONE search for sibling occurrences of the same defect pattern; fix siblings inside the requested scope, list the rest in Noticed. A sibling hunt beyond one search is scope creep.
- Done = the reported path shows the corrected result + regression test when earned + siblings fixed or listed.
- Fresher traps: null-check at the crash site, catch-and-swallow, sleep() for a race, special-casing the failing input.

## FEATURE ON EXISTING CODE
- Find the newest similar feature and mirror the anatomy it ACTUALLY has — the same layers and the same wiring (registration, DI, flags, migrations, i18n, permissions where the sibling has them). NEVER add a layer the sibling lacks. "Compiles but unreachable" is the classic failure.
- Contract first: types/API shape locked, then the states the feature's real callers reach — loading/empty/error/unauthorized only where the surface actually has them. A feature IS its reachable error paths, not every conceivable one.
- Exercise the user-reachable path end to end once before claiming done.
- Fresher traps: happy path only, a parallel structure beside the existing pattern, hardcoded config, missing the one registration line that makes it live.

## GREENFIELD BUILD
- Structure for the deleter: modules that can be removed cleanly later beat modules that could theoretically scale.
- No abstraction before the second concrete use case; no config surface before the second consumer.
- Fresher traps: speculative layering, framework zoo, clever DSLs, premature generalization "for later".

## REFACTOR
- Invariant: observable behavior identical — and PROVEN: green tests before AND after; no tests → characterization tests first.
- One transformation species per pass (rename, THEN move, THEN split), verify between passes; codemods and LSP renames over hand edits.
- A bug discovered mid-refactor is never fixed in the same motion: record it, finish the pass, fix it as its own verified change (or fix first, then refactor). Mixed diffs are unreviewable.
- Fresher traps: rename-by-grep, "improving" logic while moving it, leaving old and new paths both alive.

## MIGRATION / UPGRADE
- Read the breaking-changes list of the actual target version BEFORE editing. Inventory every usage into a migration map; its count is your done-denominator.
- Schema/data: expand → backfill → contract; every step idempotent and resumable; verify counts/checksums pre and post.
- At yield, old and new never coexist (cutover rule). Half-migrated is failed, not phased.

## INVESTIGATION / DIAGNOSIS (no fix requested)
- Deliverable is evidence: reproduction, root cause, ranked fix options with costs. Don't edit code that wasn't asked for — propose, and offer to execute.

## TEST WORK
- Assert behavior through the public surface, not implementation details. Target branches, edge values, invariants, error paths.
- Every test must be able to fail: if you can't name the change that would fail it, it's decoration — fix or delete it.

Cross-cutting: adding a dependency = adopting its maintenance (check health, size, license; prefer stdlib and existing deps). CI/build/config edits are code — verify by running the affected pipeline path; a broken pipeline blocks everyone. Scripts that touch data are idempotent and support a dry-run. Unlisted work types compose from the nearest playbooks above.
