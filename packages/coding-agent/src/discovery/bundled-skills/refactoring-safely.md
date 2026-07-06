---
name: refactoring-safely
description: MANDATORY for any refactor, restructure, extract, rename, move, split, inline, modernize, or clean-up task on existing code. Use BEFORE touching the code — this skill contains the characterization-test protocol for untested legacy code, staged single-species transformation passes, golden-output diffing, and the rules that keep observable behavior provably identical. If the area you are about to restructure has no tests, reading this skill is not optional.
---

# Refactoring Safely

The invariant: observable behavior IDENTICAL — and PROVEN, not assumed. "It's just a refactor" is the sentence spoken before every silent behavior drift.

## Step 1 — assess the net
- Tests cover the area → run them, confirm green BEFORE touching anything. This green is your baseline.
- Weak/no tests → build the net first: **characterization tests**.

## Characterization tests (for legacy/untested code)
Pin CURRENT behavior — including its bugs — before restructuring:
1. Pick representative inputs: the common case, each boundary (empty, 0, 1, max), and the weird ones you find in real data/fixtures.
2. Run the CURRENT code on each; capture actual outputs (don't reason about what it "should" return — record what it DOES return).
3. Write tests asserting exactly those outputs. Found a bug while capturing? Note it in `Noticed:` — do NOT fix it now; the characterization pins it so the refactor provably didn't change it. Fixing is a separate change after.
4. For flows too big to unit-pin: golden files — serialize the full output of 2–3 real flow runs to files, commit-adjacent; after refactoring, re-run and `diff` field-by-field.

## Step 2 — staged passes, one transformation species each
Never mix transformation kinds in one motion. Order for a typical restructure, verifying (build + tests green) BETWEEN each pass:
1. RENAME — via LSP rename only; rename-by-grep is banned (misses dynamic access, comments lie, strings collide).
2. MOVE files/symbols — with import-updating tooling; then build.
3. EXTRACT functions/modules — mechanical lift, no logic edits.
4. CHANGE SIGNATURES — via LSP code actions; `lsp references` count before = migrated count after.
5. SIMPLIFY internals — only now, with the net fully green around you.
Prefer codemods for repetitive structural edits: ast-grep pattern rewrites over hand-editing 40 call sites.

## Iron rules
- A bug discovered mid-refactor is NEVER fixed in the same motion. Record it, finish the pass, fix it as its own verified change (or fix first, then refactor). Mixed diffs are unreviewable and unbisectable.
- No "improving while moving": changed default, reordered conditions, "cleaner" error message — each is a behavior change smuggled inside a refactor. If you want it, it's a separate change.
- Old and new paths never coexist at yield: every caller migrated, old path deleted (clean cutover). `grep` the old symbol name = 0 hits.
- Public boundaries (published API, wire format, persisted data, CLI flags) keep behavior unless changing them IS the task.

## Step 3 — prove identity
- Full baseline suite green AFTER, same as BEFORE.
- Golden-output diff on the representative flows: identical, or every diff explained and accepted explicitly.
- Per skill://verify-before-done: run one real flow through the refactored code at its entry point.
- Perf-sensitive area → same measurement before/after (a refactor that 10x'd a hot path's allocations is a regression, not a cleanup).

## Fresher traps
Rename-by-grep partial hits; giant single-commit refactor (unreviewable — stage it); "while I'm here" logic edits; leaving compat shims/aliases "temporarily"; refactoring without ever running the code; trusting stale build artifacts in monorepos (rebuild the lib, then test through a real consumer).
