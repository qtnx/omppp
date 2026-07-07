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
