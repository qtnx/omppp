# Session Memory Retention Fix — Implementation Plan

> **For agentic workers:** Each task is a self-contained package executed by one owner (production code + tests in the same package). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop unbounded JS-heap growth in long-lived `ompx` sessions (observed 7.8G RSS / 11.5G peak on an idle 2.5-day session) by swapping heavy payloads of cold history to disk-backed blob refs, reversibly.

**Architecture:** The disk layer already externalizes images/frames to a content-addressed blob store (`blob:sha256:<hex>`). This fix introduces a reversible **archived shape v2** for cold entries: heavy leaves ONLY (ImageContent.data, details.images, snapcompact frames, text blocks > threshold) are written to the blob store (`putSync` always runs — content-addressed dedupe makes re-put a no-op — so legacy inline data loaded from old sessions is covered) and swapped in place to refs; everything else (transient fields, small text, structure, object identity) is untouched, so archival is fully invertible via `rehydrateEntries`. (P1) entries behind a compaction point archive after each compaction, and every transition that moves the live-tail boundary backward (rollback restore, uncompact/recompact, branch switch, fork) rehydrates first; (P2) session resume stops eagerly rehydrating blob refs for cold entries and rehydrates only the live tail; (P3) TUI drops heavy payload copies for sealed/committed blocks; (P4) every consumer that can see a cold entry gains an `isBlobRef` resolve-or-placeholder guard (images AND text).

**Tech stack:** Bun + TypeScript, existing `packages/coding-agent/src/session/blob-store.ts` helpers. No new dependencies. No JSONL/wire format changes.

## Global Constraints

- Blob ref contract is LOCKED: `blob:sha256:<hex>`, helpers `isBlobRef`, `parseBlobRef`, `resolveImageData(Sync)`, `resolveImageDataUrl` from `packages/coding-agent/src/session/blob-store.ts`. Do not change them.
- Archived shape v2 (FINAL, as landed): heavy leaves only — `ImageContent.data`, `details.images[].data`, snapcompact `frames[].data`, text blocks and string message/custom-message content > `TEXT_ARCHIVE_THRESHOLD` (16 * 1024 chars), `thinking`/`thinkingSignature` over the same threshold, and custom-entry `image_url` data URLs ≥ 1024 chars — each `putSync` into the blob store and replaced by its ref IN PLACE. Generic custom-entry strings and `providerPayload` replay items stay inline (no safe persisted counterpart / provider-native shape). No transient-field stripping, no truncation, no structural change. Fully invertible: `rehydrateEntries` restores byte-identical inline content; persist-side resolves every text-class ref (including signed thinking) back to full bytes so JSONL never carries text refs.
- INVARIANT (LOCKED, all tasks): no `blob:` ref may ever reach a provider request or crash a renderer. Entries in the LIVE TAIL — at/after the latest compaction's `firstKeptEntryId` on the ACTIVE branch path (the kept prefix emitted into collapsed context per session-context.ts:426-437 is part of the tail; fall back to the compaction entry id when `firstKeptEntryId` is unset) — always hold inline data in RAM. Any operation that moves the tail boundary backward or changes the active path — rollback restore, uncompact/re-compact-from-scratch, branch switch, fork (`forkFrom`), session load — MUST rehydrate the entries entering the tail before they become reachable by context building.
- Persisted JSONL format is UNCHANGED (still `prepareEntryForPersistence`: image/frame refs + oversized-text truncation). Persisting an entry that is currently RAM-archived must not leak TEXT refs to disk: persist-side resolves text refs back to full text (then applies today's truncation) before serializing. Image/frame refs on disk are today's shape and stay.
- Missing blob degradation: resolver returns `""` + logs warning (existing contract) → consumers omit the image / show placeholder; never throw, and never send the raw ref string to a provider.
- Old sessions (inline base64 JSONL) MUST load unchanged. Forward-only compat; no migration.
- Repo rules: `bun check` (never tsc), no `console.*` in coding-agent, ES `#private`, no `mock.module()`, tests full-suite safe, TDD red→green per step, no project-wide suites inside packages.
- Do NOT commit; the parent integrates.

---

### Task P1: Reversible archival behind compaction (owner: heavy_task, self_review)

**Files:**
- Create: `packages/coding-agent/src/session/entry-archival.ts` (`archiveEntries`, `rehydrateEntries`, `TEXT_ARCHIVE_THRESHOLD`)
- Modify: `packages/coding-agent/src/session/session-manager.ts` (archival call after compaction entry recorded+persisted; rehydration on rollback restore, uncompact/boundary-backward paths, branch-switch/active-path change)
- Modify: `packages/coding-agent/src/session/agent-session.ts` (compaction completion hook near the `replaceMessages`/CompactionEntry record path ~:4198; rollback/rewind call sites)
- Modify: `packages/coding-agent/src/session/session-persistence.ts` (persist-side: resolve text refs back to full text before truncation so disk never holds text refs)
- Test: `packages/coding-agent/test/session/session-archive.test.ts` (new)

**Interfaces:**
- Produces (LOCKED for P2/P4): `archiveEntries(entries: SessionEntry[], blobs: BlobStore): void` and `rehydrateEntries(entries: SessionEntry[], blobs: BlobStore): void` from `packages/coding-agent/src/session/entry-archival.ts` — in-place, idempotent, inverse of each other for blob-backed leaves.
- Consumes: `isBlobRef` / `putSync` / `getSync` from `blob-store.ts`.

**Design constraints:**
- MUTATE FIELDS IN PLACE; entry AND message object identity preserved (`#index`, rollback snapshots (`session-manager.ts:960`), collab replication hold references to these objects).
- Idempotent both ways (`isBlobRef` short-circuit on archive; inline content is a no-op on rehydrate). `putSync` ALWAYS runs on archive so legacy inline payloads (old sessions, never blob-persisted) become recoverable before the swap.
- Archive scope (AMENDED per P1 finding): entries STRICTLY BEFORE the triggering compaction's `firstKeptEntryId` on the ACTIVE branch path (fallback: the compaction entry id when unset) — the kept prefix stays inline. Entries shared with other branches may be archived; correctness comes from the rehydrate-on-transition invariant, not from exclusion.
- Boundary-backward transitions owned by P1 (each gets a rehydration call + test): rollback restore across an archival boundary; uncompact/recompact paths rebuilding context from pre-compaction entries; branch switch and `forkFrom` making formerly-cold entries part of the new active tail (rehydrate that path's tail = entries at/after its latest compaction's `firstKeptEntryId`, or all when the path has no compaction).
- Superseded `CompactionEntry.preserveData` frames archive too; the triggering (latest) compaction entry and everything after it stay untouched.

**Steps:**
- [ ] RED: test — record entries (200KB text tool result, 2MB base64 image, snapcompact-shaped compaction with frames), run a second compaction, assert: entries before the new compaction have `isBlobRef(image.data) === true`, text blocks > threshold are refs, superseded compaction frames are refs; entries at/after the new compaction untouched; `rehydrateEntries` restores byte-identical originals. Run → fails.
- [ ] RED: test — after archival, `buildSessionContext()` (collapsed mode) outgoing messages contain zero `blob:sha256:` strings; repeat after a THIRD compaction (archive-of-archived idempotent, still ref-free). Run → fails.
- [ ] RED: test — rollback across the archival boundary: archive → roll back to a pre-compaction snapshot → `buildSessionContext()` ref-free AND full text/image bytes restored byte-identical. Run → fails.
- [ ] RED: test — missing blob: delete a blob file, rehydrate → content omitted/placeholder + warning, no throw, and built context contains no raw ref string. Run → fails.
- [ ] RED: test — persist an archived entry through a rewrite path: serialized JSONL line contains truncated TEXT (never a text ref); image fields keep refs (today's disk shape). Run → fails.
- [ ] GREEN: implement `entry-archival.ts` + hooks (compaction completion after persist; rollback/uncompact/branch-switch/fork rehydration). Run all → pass.
- [ ] Test — content-bytes sum across `#entries` drops after archival and returns after rehydration (revert-sensitive proxy).
- [ ] Run: `bun test packages/coding-agent/test/session/session-archive.test.ts` → green; `bun check` clean.

**Acceptance (run yourself):** tests above green; session suites in `packages/coding-agent/test/session*` not newly failing (run that directory only).

**Done report:** files changed, test output, deviations, inventory of EVERY boundary-backward call site found and hooked (file:line), unresolved risks. STOP AND ESCALATE instead of guessing if: entry/message identity cannot be preserved, the set of boundary-backward paths cannot be enumerated confidently, or the compaction completion hook cannot see the persisted entry id.

---

### Task P2: Lazy resume — stop eager blob rehydration (owner: heavy_task, self_review)

**Files:**
- Modify: `packages/coding-agent/src/session/session-loader.ts` (`resolveBlobRefsInEntries` / `resolvePersistedBlobRefs` — selective, path-aware resolution; extend resolution to text refs so RAM-archived shapes rehydrate fully)
- Modify: `packages/coding-agent/src/session/session-manager.ts` (`setSessionFile` ~:1012; fork/clone path ~:1949; collab `snapshotForReplication` ~:1478 — replication must ship resolvable content: rehydrate the clone or verify peers share the blob store; report which)
- Test: `packages/coding-agent/test/session/session-lazy-resume.test.ts` (new)

**Interfaces:**
- Consumes: `rehydrateEntries` from P1 (LOCKED signature above); latest-compaction detection on the loaded branch path.
- Produces: load semantics — entries strictly BEFORE the latest compaction's `firstKeptEntryId` on the loaded path keep disk shape (image refs + truncated text); entries at/after it (kept prefix + tail) PLUS the latest `CompactionEntry.preserveData` frames are rehydrated at load (bounded working set ≤ frames budget 3MB + tail). Fallback to the compaction entry id when `firstKeptEntryId` is unset. Sessions without any compaction: resolve everything (current behavior).

**Steps:**
- [ ] RED: test — JSONL fixture (entries + compaction + tail) with refs written through real `prepareEntryForPersistence` + a real temp `BlobStore`; load via `setSessionFile`. Assert: pre-compaction entries still hold refs; tail entries + latest compaction frames hold inline base64; `buildSessionContext()` collapsed messages contain no `blob:` refs. Run → fails (today everything inflates).
- [ ] RED: test — old-format fixture (inline base64 only) loads identical to today; missing blob on a tail ref → `""` + warning, no throw, no raw ref in built context. Run → write both, watch the ref case fail.
- [ ] GREEN: implement selective resolution (path-aware filter around the existing resolve pass, reusing `rehydrateEntries`). Run → pass.
- [ ] Verify + test: `forkFrom` and `loadSessionMessagesReadOnly` apply the same selective rule; collab replication ships resolvable content (rehydrated clone or shared blob store — evidence required).
- [ ] Run: `bun test packages/coding-agent/test/session/session-lazy-resume.test.ts` + existing `session-persistence-images.test.ts` → green; `bun check` clean.

**Acceptance:** new tests green; `session-persistence-images.test.ts` and session loader tests green.

**Done report:** files changed, test output, deviations, replication verdict. STOP AND ESCALATE if: the last compaction on the loaded path cannot be determined cheaply, or ACP/SDK resume paths bypass `setSessionFile`.

---

### Task P3: TUI sealed-block payload eviction (owner: task)

**Files:**
- Modify: `packages/coding-agent/src/modes/components/assistant-message.ts` (`#convertedKittyImages`, `#kittyConversionsInFlight` — clear on transcript block finalize/seal; lazy re-convert exists ~:584-591)
- Modify: `packages/coding-agent/src/modes/components/tool-execution.ts` (sealed+committed blocks: drop image block `data` strings from the retained `#result` copy IF the committed-repaint contract holds — see investigation step; text kept)
- Test: new component test beside existing ones under `packages/coding-agent/test/modes/`

**Interfaces:** none shared; component-internal only.

**Steps:**
- [ ] INVESTIGATE (own package): confirm via `packages/tui/src/tui.ts` committed-prefix contract + `interactive-mode.ts:2035-2065` that (a) committed transcript blocks never repaint through their retained component instances (full rebuilds construct NEW components from collapsed context), and (b) expand/interaction is impossible for committed blocks. Record file:line evidence in the report.
- [ ] RED: component test — after seal/finalize, kitty maps are empty; a forced re-render does not throw and lazily re-converts (or renders placeholder). Run → fails.
- [ ] GREEN: clear kitty maps on seal. Run → pass.
- [ ] IF (a)+(b) verified: RED→GREEN — on commit, replace image block `data` in the component's retained `#result` copy with a placeholder sentinel; committed-block render never dereferences dropped data; resize does not crash. IF NOT verified: land ONLY the kitty-map clearing (conservative floor) and report why.
- [ ] Run: new component tests green; `bun check` clean.

**Acceptance:** new tests green; touched modes/tui test directories not newly failing.

**Done report:** repaint-contract evidence, files changed, test output, which tier landed (full drop vs conservative floor) and why.

---

### Task P4: Consumer guards for archived shape (owner: task)

**Files:**
- Modify: `packages/coding-agent/src/modes/image-references.ts` (~:31-35, :52-60 — `Buffer.from(image.data, "base64")` seams)
- Modify: `packages/coding-agent/src/modes/utils/ui-helpers.ts` (~:73-83 — same decode seam)
- Modify: `packages/coding-agent/src/export/html/index.ts` (~:184-187), `packages/coding-agent/src/export/share.ts` (~:183-197), `/dump` paths in `packages/coding-agent/src/modes/controllers/command-controller.ts` (~:137-154)
- Sweep: grep `extensibility/` + hooks for readers decoding `ImageContent.data` or consuming full tool-result text; guard where found (report inventory). Verify ACP replay already resolver-guarded (`acp-agent.ts:1227-1235`, `acp-event-mapper.ts:783-785`) — report only.
- Test: one new test file per guarded seam group, colocated with existing tests.

**Interfaces:**
- Consumes: `isBlobRef` + `resolveImageData(Sync)` from `blob-store.ts` (LOCKED); blob store access via the session manager the seam already reaches (pattern: `input-controller.ts` uses `sessionManager.putBlob`). Guards cover IMAGE refs and TEXT refs (a text block whose entire string is a `blob:sha256:` ref).

**Design constraint:** every guard is a no-op for inline data (today's shape) — safe to land independently of P1/P2. Resolve where the surface needs real bytes (export/share embed, image link materialization, /dump); placeholder (`[image unavailable]` / `[content archived]`) where resolution fails.

**Steps:**
- [ ] RED: per seam — a message containing `blob:sha256:<hash>` with the blob present in a temp store → seam resolves and produces correct output; blob missing → placeholder, no throw. Run → fails.
- [ ] GREEN: add guards. Run → pass.
- [ ] Sweep: report every additional content-reader found (file:line) with guarded / no-op / not-needed verdict.
- [ ] Run: new tests green; `bun check` clean.

**Acceptance:** new tests green; ACP verification reported.

**Done report:** seam inventory, test output, deviations.

---

## Integration & gates (parent)

- `bun check` workspace; targeted suites: `packages/coding-agent/test/session*`, all new test files, touched modes tests. All tests must pass locally before any push.
- All-or-nothing landing rule: the deliverable is shippable ONLY when P1–P4 are ALL green together in this worktree. P4's guards are part of the same integrated diff as P1/P2 archival — no package lands or ships alone, so no runtime state exists where refs are creatable without guards. If any package fails or escalates, the whole change is NOT shippable until resolved.
- Changelog: `packages/coding-agent/CHANGELOG.md` under `[Unreleased] > Fixed`.
- Evidence block per skill://verify-before-done; macOS RSS confirmation raised to the user with `vmmap` instructions (cannot run Darwin here).

## Out of scope (follow-ups)
- TranscriptContainer component-count cap / virtualization.
- Externalizing heavy payloads of LIVE (pre-compaction) entries.
- `/debug heap` command dumping `bun:jsc` heapStats.
