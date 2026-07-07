---
name: migration-upgrade
description: MANDATORY for any dependency upgrade, framework upgrade, version bump, database schema change, or data migration/backfill. Use BEFORE editing anything — contains the read-breaking-changes-first rule, the usage-inventory done-denominator, the expand→backfill→contract schema pattern with a worked example, idempotent/resumable data-script rules, and zero-downtime coexistence rules.
---

# Migration & Upgrade

Half-migrated is FAILED, not phased. At yield, old and new never coexist (clean cutover) — except during a planned zero-downtime rollout window, which has its own rules below.

## Dependency / framework upgrade
1. Read the breaking-changes list for the EXACT version span first: the changelog/migration guide from your installed version to the target — every major in between. Never edit code from memory of the API.
2. Inventory every usage of changed APIs: LSP references / `grep -rn` per changed symbol → a migration map. **Its count is your done-denominator**: migrated == inventoried, verified by a final grep = 0 hits on removed APIs.
3. Use the framework's OWN codemods before hand edits (`npx @next/codemod`, `npx @angular/cli update`, `cargo fix --edition`, `go fix`). Then hand-migrate the remainder.
4. One MAJOR at a time; run the repo's gates between majors. A two-major jump that fails tells you nothing about which break bit you.
5. Lockfile updated deliberately; peer-dep fallout resolved (skill://dependency-doctor), not `--force`d.
6. Verify at the entry point per skill://verify-before-done — a green build after an upgrade proves compilation, not behavior.

## Schema migration — expand → backfill → contract
Worked example: rename `users.name` → `users.full_name` on a live table.
1. EXPAND — add the new, nullable, no constraint yet: `ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name text;` Deploy code that WRITES BOTH columns, READS new-with-fallback-to-old.
2. BACKFILL — batched, idempotent, resumable:
   `UPDATE users SET full_name = name WHERE full_name IS NULL AND id IN (SELECT id FROM users WHERE full_name IS NULL ORDER BY id LIMIT 5000);` — loop with progress logging and a small sleep; safe to kill and re-run at any point (the WHERE makes it idempotent).
3. VERIFY — `SELECT count(*) FROM users WHERE full_name IS NULL;` → 0; spot-check checksums/samples old vs new.
4. CONTRACT — only after all old-reading code is gone from production: add NOT NULL, drop old column, remove dual-write code. Contract is its own deploy, never bundled with expand.
Every step idempotent (`IF NOT EXISTS`, guarded updates) and resumable; every step has a rollback note (expand: drop new column; backfill: re-runnable; contract: the one irreversible step — say so and get the state verified before it).

## Data-migration scripts
- `--dry-run` flag MANDATORY: prints counts and a sample of would-be changes, writes nothing. Run it first, paste its output.
- Before/after counts captured; totals must reconcile (moved + skipped + failed == inventoried).
- Batch with progress output; transaction per batch, sized so a failure loses one batch, not hours.
- Any UPDATE/DELETE: run its WHERE as a SELECT first and eyeball the rows (skill://database-craft).
- Backup or snapshot the affected tables before the real run; say where the backup is.

## Zero-downtime coexistence rules
During rollout, old code and new schema (and vice versa) WILL coexist:
- Every schema step must be safe with BOTH code versions running (that's what expand/contract buys you).
- Message/API shape changes: additive first; consumers tolerate unknown fields; removal only after all producers/consumers are past the deprecation window. Changed a shape → check BOTH sides now: current consumer against new producer, or explicitly report the compatibility gap.
- Never repurpose an existing field's meaning — add a new one.

## Evidence for the done-claim
Inventory count vs migrated count; grep-zero on removed APIs; backfill verification query + result; dry-run output; entry-point probe on the migrated flow (response + rows), per skill://verify-before-done.
