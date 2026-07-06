---
name: database-craft
description: MANDATORY for schema design, adding indexes, slow queries, EXPLAIN analysis, N+1 problems, transaction boundaries, and ANY ad-hoc script or command that UPDATEs or DELETEs data. Contains honest-types rules, composite-index ordering, EXPLAIN ANALYZE reading, N+1 detection and fixes per ORM, transaction hygiene, and the data-script safety ritual (SELECT-first, dry-run, backup, batches).
---

# Database Craft

## Schema — honest types, enforced invariants
- Money: integer minor units or DECIMAL — NEVER float. Timestamps: timestamptz/UTC. Enum-like: real enums or CHECKed text, not free strings.
- NOT NULL by default; nullable is a design decision with a documented meaning for NULL.
- Foreign keys ON, with deliberate ON DELETE behavior — "the app enforces it" fails the first time two writers race (skill://concurrency-correctness).
- Uniqueness the business requires → a UNIQUE constraint/index, never an application check.
- Follow the repo's naming conventions (recon them first); migrations per skill://migration-upgrade (expand→backfill→contract).

## Indexing
- Index what you FILTER, JOIN, and ORDER BY — from real query patterns, not speculation.
- Composite order matters: equality columns first, then range/sort: `(tenant_id, status, created_at)` serves `WHERE tenant_id=? AND status=? ORDER BY created_at` — the reverse order doesn't.
- Prefix rule: that index also serves `(tenant_id)` and `(tenant_id, status)` — don't create redundant prefixes.
- Every index taxes every write; don't index-spam. Verify an index is actually used (EXPLAIN) before and after adding it.
- Partial indexes for hot subsets: `CREATE INDEX ... WHERE status = 'active'`.

## Reading EXPLAIN (ANALYZE, BUFFERS)
- Seq Scan on a large table under a selective WHERE → missing/unusable index (function on the column? type mismatch? leading wildcard LIKE?).
- rows=ESTIMATE vs actual rows off by 100x → stale statistics (`ANALYZE <table>`) or correlated columns — the planner is flying blind.
- Nested Loop over a huge outer set → often the estimate problem above.
- Buffers: read≫hit → cold/oversized working set. Sort Method: external merge → work_mem or a covering index for the ORDER BY.
- Always ANALYZE (actual execution), not bare EXPLAIN, when diagnosing — but not on a destructive query (wrap in `BEGIN; EXPLAIN ANALYZE ...; ROLLBACK;`).

## N+1 — detect and fix
- Detect: enable query logging (or the ORM's debug), run the flow once, count queries — a query-per-item loop is the signature. `grep`-level tell: `await`/query inside a `for` over records.
- Fix by ORM: Prisma `include`/`in`-batched query; TypeORM/Sequelize `relations`/`include`; ActiveRecord `includes`; SQLAlchemy `selectinload`; Django `select_related`/`prefetch_related`; GraphQL resolvers → DataLoader.
- Or drop to one SQL join/`WHERE id = ANY($1)` when the ORM fights you.
- Verify: query count before vs after, same flow — that's the evidence number.

## Transaction hygiene
- Boundary = the invariant: everything that must be atomic inside ONE transaction; anything independent outside.
- SHORT: no network calls, no user waits, no heavy compute inside an open transaction — locks held = throughput burned + deadlock surface.
- Know the default isolation (usually READ COMMITTED): two reads in one transaction may see different data; if the logic needs a stable read → explicit locking or higher isolation, chosen deliberately.
- Error path: rollback guaranteed (finally/defer/context manager); a swallowed error inside a transaction that then commits is data corruption with a green log.

## Data-script safety ritual — for EVERY ad-hoc UPDATE/DELETE
1. Write the WHERE as a SELECT first; run it; EYEBALL the rows and the count. This step is non-negotiable.
2. Snapshot: `CREATE TABLE users_backup_YYYYMMDD AS SELECT * FROM users WHERE <same where>;` (or a dump). Note where it is.
3. Dry-run mode for scripts: print counts + a sample of would-be changes, write nothing; paste that output before the real run.
4. Execute in bounded batches with progress output; transaction per batch (a failure loses one batch, not hours); re-runnable WHERE (idempotent).
5. After-counts reconcile: changed + skipped + failed == the SELECT's count. Verify a sample row's new values.
6. `LIMIT` your blast radius during the first batch; widen after it verifies.
An UPDATE without a WHERE clause reviewed twice is how companies end up in the news.

## Pooling basics
Pool size ≈ what the DB can actually serve (cores + disk), not "moar" — oversized pools convert load spikes into connection storms; every service replica multiplies it. Exhaustion symptoms (timeouts acquiring a connection) → look for leaked connections (missing release on an error path) before raising the limit.
