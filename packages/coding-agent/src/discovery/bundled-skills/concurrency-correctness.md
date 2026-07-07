---
name: concurrency-correctness
description: MANDATORY when the task involves races, concurrent/parallel execution, locks, transactions spanning logic, retries, queues, idempotency, double-submit, duplicate events, or "sometimes it happens twice / sometimes it's wrong". Contains the runtime-specific race models (Node await-interleaving, Go, Rust, Python), idempotency-key design, optimistic vs pessimistic locking with code shapes, the unique-constraint-as-guard rule, the outbox pattern, and how to actually TEST concurrency with parallel real requests.
---

# Concurrency Correctness

Exactly-once delivery is a lie the network tells you. Design for at-least-once + idempotent handling, and let the DATABASE enforce uniqueness — application-level check-then-act cannot.

## Know your runtime's race model
- **Node/JS**: single-threaded, but every `await` is a yield point — check-then-act ACROSS an await over shared state (module map, cache, "did I already…?" flag, DB read→write) is a textbook race between interleaved requests. The fix is atomicity at the store (constraints, upserts, atomic ops), not more JS.
- **Go**: real parallelism. Any variable touched by 2+ goroutines needs a mutex, channel ownership, or atomic. `go test -race ./...` is MANDATORY for any concurrency-adjacent change, plus a `-race` build for the manual probe. Loop-variable capture in goroutines and map concurrent writes are the classic bites.
- **Rust**: the compiler catches data races, NOT logic races (check-then-act via two lock acquisitions, TOCTOU on files/DB) nor deadlocks; don't hold a std mutex across `.await` (use the async runtime's), don't block the async runtime with sync IO.
- **Python**: the GIL doesn't save you — races live across `await`/thread switches at IO points exactly like Node; multiprocessing shares nothing unless explicit.

## Idempotency keys — design
For any effectful operation a client may retry (payments, orders, sends):
1. Client generates a key (UUID) per logical operation and re-sends the SAME key on retry.
2. Server: `INSERT INTO idempotency_keys(key, request_hash, status, response) ... ON CONFLICT DO NOTHING` (or unique-index + catch conflict) BEFORE doing the work.
3. Conflict → return the STORED response of the original attempt (same status/body). Same key + different payload → 422.
4. Key row and the side effect commit in the SAME transaction, or the key is a lie.

## Locking — pick deliberately
- **Unique constraint as the real guard** (first choice): don't check-then-insert — insert and catch the conflict (`ON CONFLICT`, duplicate-key error). The DB is the only referee all your replicas share.
- **Optimistic** (default for low contention): `version` column; `UPDATE ... SET v=v+1 WHERE id=$1 AND v=$expected`; 0 rows affected → someone else won → re-read and retry (bounded loop) or surface a conflict.
- **Pessimistic** (hot rows, must serialize): `SELECT ... FOR UPDATE` inside a SHORT transaction; lock scope minimal; consistent lock ORDERING everywhere (always account-lower-id first) or you've built a deadlock.
- Atomic ops beat read-modify-write: `UPDATE accounts SET balance = balance - $1 WHERE id=$2 AND balance >= $1` — the WHERE is the invariant; 0 rows = insufficient funds, no race possible.

## DB + message atomicity — the outbox
Writing the DB and publishing an event are two systems: "commit then publish" loses events on crash; "publish then commit" emits lies. Outbox: write the event to an `outbox` table IN the same transaction as the state change; a relay publishes and marks sent. Consumers dedup by event id (at-least-once).

## Retries
Only idempotent operations; exponential backoff + JITTER (thundering herd otherwise); capped attempts; overall timeout budget smaller than the caller's; a retry storm against a struggling dependency is an outage amplifier — respect 429/Retry-After.

## Testing concurrency — for real, per skill://verify-before-done
- Fire N parallel REAL requests at the entry point: `seq 20 | xargs -P20 -I{} curl -s -X POST :3000/redeem -H "..." -d '{"code":"X"}'` — then assert INVARIANTS on the store: exact row counts, balance arithmetic reconciles, exactly one redemption. The assertion is on state, not on "no error appeared".
- Duplicate-event handling: deliver the same event twice; state changes once.
- Go: `-race` on tests AND the probed binary. Flaky reproduction: loop 50x (skill://bug-hunting) — a race you can't reproduce reliably yet is not understood yet.

## Fresher traps
Check-then-act across await; fixing races with `sleep`; in-process mutex "protecting" a multi-replica deployment (the lock must live in the shared store); retry-on-POST without idempotency keys; catch-and-retry around non-idempotent code; assuming queue delivery order.
