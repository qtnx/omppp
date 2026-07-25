# Upstream v17.1.1 → OMPx 1.6.5 Merge Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `subagents-development`, `git-craft`, and `verify-before-done`. This is an L3 sync because it crosses authentication, provider routing, CI/release, native bindings, prompt/tool contracts, and session persistence.

**Goal:** Merge current `upstream/main` into a branch based on `origin/main`, retain every intentional OMPx fork feature, adopt all clean upstream changes, reconcile overlapping improvements semantically, verify the distributable OMPx binary, then merge through a PR into `origin/main`.

**Recorded refs (2026-07-24):**
- `origin/main`: `49e0fbe912ed11d3d90995bc979f6a99ec83eee1` (`@oh-my-pi/pi-coding-agent` 1.6.5)
- `upstream/main`: `69307261c332a78dc41d5a3e14f5af8edc8a3f51` (v17.1.1 plus `chore(infra): baked cmake and ninja into the omp-kata runner image`)
- merge base: `3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0`
- divergence: 357 fork-only commits / 1,304 upstream-only commits
- upstream surface: 931 files; 824 clean candidates; 107 textual conflicts (105 content, 2 add/add), 329 conflict hunks; 165 additional files changed by both sides but auto-merged
- Runtime amendment (2026-07-24): upstream advanced by one non-conflicting infra commit after plan lock; the pre-baseline-repair synthetic tree was `b268d80f1b46b587c31c478093b070aec01189b1`, while conflict ownership and semantic-auto-merge denominators remained unchanged.
- Runtime amendment (2026-07-24): verified `BASELINE_PARENT` is `3f5e5329a1e95bdba4c66e420e42554eb16d1c45`; its synthetic merge tree is `d7eb16d47270d7070d39746a1b538a233ca9b2fc`. The two-file baseline repair increases the measured conflict-hunk denominator from 326 to 329 without changing the 107 owned conflict paths.
- Runtime amendment (2026-07-25): the frozen feature ledger contains 68 data rows (69 lines including its header), not the earlier 66-feature estimate; Task 5 must close all 68 rows while all other frozen denominators remain unchanged.

**Architecture:** Use a true merge commit, never rebase or cherry-pick the 1,304-commit upstream range. The current harness worktree is already isolated and becomes the one canonical integration workspace owning the real conflicted index. Conflict owners reproduce the merge in separate local scratch clones, resolve a unique file set, and return complete resolved files; they never touch the canonical index. The integration owner applies those results serially, regenerates locks/derived outputs before clearing the index, audits semantic auto-merges, commits a candidate merge, and verifies the exact commit from a clean scratch clone through the built OMPx binary before preparing the PR.

**Tech stack:** Git merge/merge-tree/rerere, Bun 1.3.14 workspace, TypeScript, Rust/Cargo, native N-API bindings, GitHub PR.

## Global constraints

1. `ours` means recorded `BASELINE_PARENT` (frozen OMPx `origin/main` plus the single verified baseline-repair commit); `theirs` means frozen `upstream/main`.
2. Preserve fork tier names `quick_task` / `task` / `heavy_task`. Add upstream `tester` only additively; never replace `quick_task` with `sonic` or remove `oracle`.
3. Preserve OMPx 1.x versioning, `ompx` branding, `qtnx/omppp` self-update source, fork installer behavior, and fork package names.
4. Preserve context-gc-plugin, delegation-reminder-plugin, system-context-reminder-plugin, safe orchestrator mode, duo/advisor, workflow, Herdr state, browser annotation, macOS sandbox, compact tool, goal/tool discovery, idle-memory trim, and fork-only packages.
5. Preserve fork CI shape: GitHub-hosted runners, release security gate, OSV scanner, install-method coverage, and worker smoke tests. Port compatible upstream CI improvements into that shape.
6. Preserve the worker-host re-entry contract in `packages/coding-agent/src/cli.ts`; no new standalone worker entrypoints.
7. Never use global `-Xours`, `-Xtheirs`, `checkout --ours .`, `checkout --theirs .`, or a union merge driver. These silently discard one side. Resolve every conflicted hunk from intent and tests.
8. Never hand-edit `packages/catalog/src/models.json`; reconcile generator/resolver sources, then run `bun run gen:models`.
9. Treat `packages/natives/native/index.js` and `index.d.ts` as generated outputs; reconcile Rust/native source and regenerate with `bun run gen:native`.
10. Do not push directly to `origin/main`. Push `sync/upstream-main-2026-07-24`, open a PR into `origin/main`, and merge only with GitHub’s **merge commit** method after required gates pass; squash and rebase are forbidden.
11. No unrelated modernization. Every edit must be upstream adoption, fork preservation, conflict reconciliation, generated output, or verification repair caused by this merge.
12. The canonical integration worktree has one writer for the Git index, generators, dependency installation, formatters, and tests. Parallel owners use isolated throwaway worktrees and return resolved files; no concurrent process writes shared build/cache outputs.
13. A `defer-blocked` feature-ledger row blocks the PR. Every accepted upstream feature must end as `take`, `reconcile`, or an explicit incompatibility decision approved by the integration owner and reviewer.
14. The exact candidate merge commit tested locally must be the commit reviewed and pushed. Any later target-branch integration invalidates prior evidence and reruns affected audits, build, and runtime gates.

## Resolution policy

| Case | Required action |
|---|---|
| Upstream-only file/change | Take automatically; do not rewrite it merely to match fork style. |
| Fork-only file/change | Preserve unchanged unless an upstream API change requires adaptation. |
| Both sides implement complementary behavior | Reconstruct one combined implementation; keep both tests or replace duplicates with one stronger contract test. |
| Upstream implementation is clearly newer/safer | Port upstream structure, then reapply the fork invariant at the new seam; do not keep parallel old/new paths. |
| Same feature exists twice | Compare observable contracts and keep the stronger single implementation; migrate fork callsites, remove the superseded duplicate. |
| Branding/version/update source | Fork wins; upstream functional fixes are manually ported without upstream names or 17.x versions. |
| Prompt/tool/agent contract | Fork orchestration and tier policy wins; merge upstream clarity, error handling, and new capabilities only where compatible. |
| Manifest/lock/generated conflict | Combine source dependencies and package membership, keep 1.x versions, regenerate; never hand-union lock/generated bytes. |
| Test conflict | Preserve every still-valid observable contract from both sides; update stale setup only after production behavior is settled. |
| Ambiguous or high-risk hunk | Stop that package, cite both introducing commits with `git log -L`/`git blame`, and escalate to integration owner; never guess. |

## Upstream feature disposition

**Take:** native Codex computer use; native audio/WebRTC/device-check; experimental Codex Live UI; account selection/pinning; usage-aware fallback; prompt-cache improvements; Alibaba Token Plan and new catalog/provider support; bash approval rules; MCP Markdown rendering; ARIA browser refs; worktree isolation fixes; session/TUI performance and reliability fixes; secret-redaction hardening; RPC framing/reaping; Windows/native build fixes.

**Reconcile with fork implementation:** Meta provider, model fallback/routing, task model selection, auth/OAuth account pools, advisor/task/session lifecycle, compaction, stats, provider usage accounting, browser tooling, prompts, and CI. “Reconcile” means one final path with both required contracts—not two implementations behind fallbacks.

**Fork wins at boundary:** OMPx identity and updater, 1.x versions, implementer tier names, safe orchestration/duo/advisor behavior, fork plugins/packages, release/security CI topology, browser annotation and sandbox behavior.

---

### Task 1: Freeze refs, baseline, and create the sync branch

**Files:** no source edits.

- [ ] Confirm the current workspace is already a linked harness worktree (`git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`) and is not a submodule. Do not create a nested worktree.
- [ ] Fetch both remotes. SSH may be unavailable; use explicit HTTPS fetches if needed:

```bash
git fetch https://github.com/qtnx/omppp.git main:refs/remotes/origin/main
git fetch https://github.com/can1357/oh-my-pi.git main:refs/remotes/upstream/main
```

- [ ] Record `git rev-parse origin/main upstream/main` and compare with the recorded SHAs. If either moved, rerun `git merge-tree --write-tree origin/main upstream/main`, refresh counts/ownership, and amend this plan before merging.
- [ ] Read upstream changelogs/release notes for the exact post-base span (v17.0.5 through v17.1.1), then create `/tmp/ompx-upstream-2026-07-24/migration-map.tsv` with columns `category`, `upstream_ref`, `old_contract`, `new_contract`, `usage_count`, `owned_paths`, `disposition`, `evidence`, and `status`. Inventory dependency, persisted-session/DB shape, provider API, CLI contract, and removed-symbol changes. Every changed contract gets a denominator; `status=closed` requires migrated count equals inventoried count and zero remaining removed-API callsites.
- [ ] Freeze `/tmp/ompx-upstream-2026-07-24/ci-contract-before.json` from `origin/main`: workflow triggers, permissions, job keys/names, `runs-on`, matrices, `needs`/`if` gates, required commands, native artifact inputs, install variants, release/security/OSV steps, worker smoke steps, and required-status mapping. This is the semantic CI baseline; job names alone are insufficient.
- [ ] Freeze `/tmp/ompx-upstream-2026-07-24/fork-reachability.tsv` from `origin/main` with one row per fork-only package/feature and columns `component`, `manifest_or_source`, `registration_entrypoint`, `public_surface`, `final_sha_evidence`, and `status`. Required rows include Context GC, delegation reminder, system-context reminder, safe orchestrator mode, duo/advisor, workflow, Herdr state, macOS sandbox, browser annotate, agent `compact`, idle-memory trim, OMPx branding/updater, and tier-name/tester/oracle routing. Any newly discovered fork-only component is appended before merge.
- [ ] Print and record `bun --version`, `rustc --version`, and `cargo --version`. Bun must match the repository’s 1.3.14 contract.
- [ ] Protect unrelated user work: inspect status before branch creation. Stop on any unrecognized change. The plan artifact is merge-owned; switch the already-isolated worktree to a branch created from the refreshed `origin/main`:

```bash
git switch -c sync/upstream-main-2026-07-24 origin/main
```

- [ ] Run the pre-merge baseline from this exact branch: `bun check`, `bun run ci:test:full`, `bun run test:scripts`, and the native sentinel smoke selected by current CI. Record any existing failure before the merge; do not proceed through an unexplained red baseline.
- Runtime baseline amendment (2026-07-24): `bun run test:scripts` exposed a pre-existing fork contract split—`scripts/ci-release-build-binaries.test.ts` still expects upstream `omp`/Windows baseline while the fork script emits `ompx`/Windows modern. Before Task 2, land one focused baseline-repair commit that preserves OMPx asset naming and adopts the upstream-required `bun-windows-x64-baseline`; verify the existing release test red→green and rerun the entire baseline. Record that commit as `BASELINE_PARENT`; it must have frozen `origin/main` as its sole parent.

**Acceptance:** `git rev-parse HEAD` equals recorded `BASELINE_PARENT`; `BASELINE_PARENT^` equals refreshed `origin/main`; branch is `sync/upstream-main-2026-07-24`; toolchains and exact upstream migration span are recorded; baseline gates are green; no unrelated user change moved branches.

### Task 2: Start the full merge and freeze machine-readable inventories

**Files:** canonical conflicted index plus untracked evidence under `/tmp/ompx-upstream-2026-07-24/`; no tracked ledger yet.

- [ ] Capture `BASE=$(git merge-base BASELINE_PARENT upstream/main)`, run `git merge-tree --write-tree BASELINE_PARENT upstream/main` into `merge-tree.txt`, parse the first full 40-hex tree OID into `auto-tree.txt`, and require `git cat-file -t "$(cat auto-tree.txt)"` to print `tree`. Diagnostics remain separate from the OID.
- [ ] Start the merge without persistent repository config:

```bash
git -c merge.conflictStyle=zdiff3 -c rerere.enabled=true -c rerere.autoupdate=false merge --no-ff --no-commit upstream/main
```

- [ ] Freeze sorted path denominators:

```bash
git diff --name-only "$BASE"..BASELINE_PARENT | sort > /tmp/ompx-upstream-2026-07-24/ours-paths.txt
git diff --name-only "$BASE"..upstream/main | sort > /tmp/ompx-upstream-2026-07-24/upstream-paths.txt
git diff --name-only --diff-filter=U | sort > /tmp/ompx-upstream-2026-07-24/conflict-paths.txt
comm -12 /tmp/ompx-upstream-2026-07-24/ours-paths.txt /tmp/ompx-upstream-2026-07-24/upstream-paths.txt > /tmp/ompx-upstream-2026-07-24/both-changed-paths.txt
comm -23 /tmp/ompx-upstream-2026-07-24/both-changed-paths.txt /tmp/ompx-upstream-2026-07-24/conflict-paths.txt > /tmp/ompx-upstream-2026-07-24/semantic-auto-merge-paths.txt
comm -23 /tmp/ompx-upstream-2026-07-24/upstream-paths.txt /tmp/ompx-upstream-2026-07-24/conflict-paths.txt > /tmp/ompx-upstream-2026-07-24/clean-paths.txt
```

- [ ] Recount after the refreshed merge. Current expectations: 931 upstream paths, 107 unique textual-conflict paths, 272 both-changed paths, 165 semantic auto-merges, 824 clean paths, and 329 conflict hunks. Do not infer file count from `git ls-files -u`, which emits multiple index stages per file.
- [ ] Hash `auto-tree.txt` and every path-list artifact. Build a feature ledger with one row per upstream `feat` group: `take`, `reconcile`, `fork-boundary`, or `defer-blocked`; cite upstream commits and final owner. Fixes may be grouped by subsystem, but the separate migration map closes every changed contract.

**Acceptance:** merge remains in progress; all machine-readable denominators and hashes are frozen and reconcile to the refreshed counts; every upstream feature group and migration row has an owner; no global ours/theirs strategy was used.

### Task 3: Isolated parallel conflict-resolution wave

The canonical integration worktree is read-only to P1–P6. For each package, create a separate local scratch clone from the common repository using shared objects but an independent index/worktree; check out the recorded `BASELINE_PARENT` (the sole child baseline-repair commit of frozen `origin/main`), run the same `git merge --no-ff --no-commit <frozen-upstream-sha>`, resolve only its exact appendix paths, and `git add` only those paths in that clone. Do not fetch moving remote refs inside owner clones. Export the complete resolved files as an archive preserving repository-relative paths; never export a combined diff from an unresolved index. Delete the scratch clone only after the canonical owner verifies the archive checksum and paths.

Owners must not install dependencies, run formatters/generators, run tests that write caches/snapshots/build products, commit, or touch another package’s paths. They may run read-only inspection and parse/type reasoning. The canonical integration owner runs all executable gates after applying archives. Local scratch clones—not nested linked worktrees—avoid shared-index and harness-worktree collisions.
- Execution amendment (2026-07-24): P1's `agent-session.ts` conflict crosses upstream's session-module extraction. Use frozen upstream `agent-session.ts` as the composition root; it keeps only cross-controller host wiring, session-global state, event bridges, and public compatibility delegates. Large inline advisor, compaction, handoff, tool-registration, model-selection, and Duo state-machine bodies are forbidden.
- Create `packages/coding-agent/src/session/session-duo-orchestrator.ts` as the sole owner of fork Duo/safe-orchestrator/goal lifecycle policy. It wraps the existing `duo/controller.ts` state machine through a host interface: advisor start/stop/pause/resume, temporary model/thinking changes, plan readiness/mode, brief injection, persisted snapshots, orchestrator state/tool snapshot, and agent continuation. `AgentSession` constructs it and exposes only the existing public delegate surface.
- P1 may modify `agent-session-types.ts`, `agent-session-events.ts`, `irc-bridge.ts`, `model-controls.ts`, `session-tools.ts`, `session-memory.ts`, `session-provider-boundary.ts`, `session-advisors.ts`, `session-maintenance.ts`, and `session-handoff.ts`. Ownership is strict: `agent-session-events.ts` retains fork events through the upstream bridge; `irc-bridge.ts` retains one typed wake-failure route; `SessionAdvisors` runs advisor runtimes and tools; `SessionMaintenance` owns compaction/Context-GC accounting; `SessionHandoff` owns transcript/session-switch cleanup; `SessionTools` owns registration/prompt rebuild/permission wrappers; `ModelControls` owns model/thinking mechanics. `AgentSessionConfig` retains `contextGcDbPath?: string` from `sdk.ts`. Any changed split/type/event/bridge module remains in the frozen 165-path semantic ledger and requires parser, integrated typecheck, and focused lifecycle tests; side-selection, shims, and duplicate monolithic/module paths are forbidden.

| Package | Unique ownership | Conflict files | Primary invariants |
|---|---|---:|---|
| P1 Core session/duo/advisor | exact P1 appendix paths | 12 | fork duo/advisor/orchestrator + Context GC survive; upstream session persistence, RPC and teardown fixes land; no duplicate lifecycle |
| P2 Task/prompts/tool contracts | exact P2 appendix paths | 10 | tier names stay; tester additive; tool schemas and prompt runtime agree; workflow/orchestrator remain reachable |
| P3 AI/auth/catalog | exact P3 appendix paths | 14 | fork credential routing and TNX/Meta behavior survive; upstream OAuth/cache/provider fixes land; one Meta implementation |
| P4 CLI/config/controllers/tools/TUI | exact P4 appendix paths | 39 | `ompx` routing, sandbox, annotate, compact, Herdr, CLI arg handling survive; upstream UI/tool fixes land |
| P5 Runtime packages | exact P5 appendix paths | 9 | stats DB remains compatible; native/Rust exports and compaction invariants preserve both sides |
| P6 Root/CI/installer/manifests | exact P6 appendix paths | 18 | 1.x versions, OMPx branding/update, fork CI/security gates retained; upstream dependencies/jobs added compatibly |
| P7 Generated integration | canonical owner only | 5 | regenerate from resolved sources; never select or hand-merge generated sides |

**P1 high-density stop condition:** `packages/coding-agent/src/session/agent-session.ts` has 72 predicted hunks. Reconstruct its state machine from base/ours/theirs and introducing commits. If both lifecycle transition sets cannot coexist without changing a public session contract, return BLOCKED with the exact transition.

**P3 add/add stop condition:** `packages/ai/src/registry/meta.ts` and `packages/ai/test/meta-provider.test.ts` are add/add conflicts. Choose one final Meta provider API, migrate callers/tests in owned scope, and remove the duplicate implementation. Fork TNX/Meta contracts must not regress.

**Acceptance per owner:** archive contains exactly the package’s owned resolved files, no conflict markers, and no generated/foreign paths; report file-by-file semantic decisions, archive checksum, assumptions, and unexercised paths. The seven ownership counts sum to exactly 107.

### Task 4: Apply source resolutions, regenerate derived files, and clear the index

**Files:** all 107 conflict paths; canonical integration owner is the only writer.

- [ ] Verify each archive checksum and path allowlist, then extract P1–P6 serially into the canonical merge worktree. Inspect each result against base/ours/theirs and stage only its owned paths.
- [ ] Confirm only the five P7 paths remain unresolved: `Cargo.lock`, `bun.lock`, `packages/catalog/src/models.json`, `packages/natives/native/index.js`, and `packages/natives/native/index.d.ts`.
- [ ] Print and pin toolchains again. Remove only the unresolved working-tree copies of `bun.lock` and `Cargo.lock`; leave their index stages unresolved until freshly generated. Never seed either lock from ours or theirs.
- [ ] Regenerate and stage in dependency order:
  1. `bun install --lockfile-only` from the reconciled manifests → inspect direct/transitive lock delta against both parents, reject unrelated refreshes, then stage `bun.lock`.
  2. `cargo generate-lockfile --manifest-path Cargo.toml` → inspect resolution delta against reconciled manifests and both parents, then `cargo metadata --locked --no-deps`, then stage `Cargo.lock`.
  3. `bun install --frozen-lockfile` → require no tracked-tree delta.
  4. `bun run gen:models` → stage `packages/catalog/src/models.json`.
  5. `bun run gen:native` with the freshly generated Cargo lock → stage native JS/DTS outputs and generator-declared siblings.
  6. `bun run fix:changelogs` → stage only merge-owned changelog normalization.
- [ ] Run model/native/changelog generators a second time and require no output delta. Re-run `bun install --frozen-lockfile` and `cargo metadata --locked --no-deps`; neither may modify tracked files.
- [ ] Run `git diff --name-only --diff-filter=U`; expected output is empty. `git ls-files -u` must also be empty.

**Acceptance:** all 107 conflicts are resolved; locks and generated outputs are source-derived, reviewed, locked, and idempotent; no hand-merged/side-selected generated bytes; package versions remain on OMPx 1.x.

### Task 5: Close migrations, audit semantic auto-merges, and retain clean upstream paths

**Files:** the frozen 165-path semantic-auto-merge set plus any clean path modified during adaptation.

- [ ] Audit every path in `semantic-auto-merge-paths.txt`; require exactly one ledger decision for each frozen path and no decision outside the denominator. Prioritize coding-agent and AI, then agent/TUI/catalog/stats/native/CI. Check moved signatures and fork hooks that compile but no longer execute.
- [ ] Close the baseline release-binary repair across the semantic merge: final `scripts/ci-release-build-binaries.ts` must emit `packages/coding-agent/binaries/ompx-windows-x64.exe` using `bun-windows-x64-baseline`; `scripts/ci-release-build-binaries.test.ts` must assert that exact fork-branded baseline contract and reject `bun-windows-x64-modern`.
- [ ] Treat the verified synthetic tree OID from Task 2 as the baseline for `clean-paths.txt`. Intersect candidate-vs-synthetic differences with that list and require a ledger row for every clean upstream path altered after Git’s merge. Each exception cites incompatibility, owning fork invariant, and verification.
- [ ] Close every `migration-map.tsv` row: migrated usage count equals inventoried count; persisted schema/session rows include compatibility and data/state validation; removed symbols have zero remaining callsites; dependency rows cite the reviewed lock delta and focused evidence. Any open/deferred row blocks commit.
- [ ] Generate `ci-contract-after.json` from the staged candidate and compare it semantically with `ci-contract-before.json`. PR/main/tag triggers, GitHub-hosted runner/matrix coverage, permissions, `needs`/security gates, OSV steps, install variants, worker-smoke commands, native artifact inputs, release separation, and required statuses must be preserved or strengthened. Every difference needs an approved ledger row; same-name no-op jobs fail.
- [ ] Close every `fork-reachability.tsv` row against the final staged tree: manifest package retained, runtime registration/entrypoint reachable, public surface unchanged unless explicitly reconciled, and a final-SHA test or installed-artifact probe named. Any missing or unverified row blocks commit.
- [ ] Verify clean-path accounting: all 824 paths are byte-equivalent to the synthetic merge result or have an approved exception. Verify fork registrations/callsites; remove duplicate implementations, stale aliases, upstream `omp` branding at fork-owned boundaries, 17.x package versions, and dead compatibility paths.
- [ ] Stage all reviewed changes. Run `git diff --cached --check`, inspect the complete staged diff, and require no unstaged or unexpected untracked source changes.

**Acceptance:** all 165 semantic rows, 824 clean paths, migration-map rows, and CI-contract fields close against frozen denominators; staged tree is complete and clean.

### Task 6: Commit candidate and verify the exact merge tree

- [ ] Create the local candidate merge commit `Merge upstream/main v17.1.1 into OMPx`. Verify exactly two parents: recorded `BASELINE_PARENT` first and frozen `upstream/main` second; verify `BASELINE_PARENT` has frozen `origin/main` as its sole parent.
- [ ] Create a clean local scratch clone with an independent index, fetch the candidate branch from the canonical path, and detach at the candidate SHA. Run `bun install --frozen-lockfile`, then require `git diff --exit-code` and no unexpected untracked files. All later commands run in this clone.
- [ ] Run structural/type gates: `git diff-tree -r --check <candidate>^1 <candidate>` and `bun check`.
- [ ] Run focused high-risk suites:
  - AI auth/provider/cache tests, including `packages/ai/test/auth-storage-codex-selection.test.ts`, Meta/TNX provider coverage, and credential pin/rotation/fallback coverage.
  - coding-agent session/compaction/duo/advisor/task/orchestrator/workflow/config/CLI tests.
  - stats DB/parser tests and native binding tests.
- [ ] Run full repository gates: `bun run ci:test:full`, `CI=1 bun run test:rs` (explicitly forces `cargo nextest run --workspace` in a clean commit), `bun run test:scripts`, and `bun run ci:test:smoke`.
- [ ] Native changes are guaranteed. Run `bun --cwd=packages/natives run build`; derive the merged native package version from `packages/natives/package.json`, clear only that version’s extraction directory inside an isolated verification HOME, then run `bun --cwd=packages/coding-agent run build`.
- [ ] Copy `packages/coding-agent/dist/ompx` to a clean temporary prefix outside the repo. Record checksum/path. With a bounded timeout and isolated `HOME`/`PI_CODING_AGENT_DIR`, run installed `--version`, `--smoke-test`, and the noninteractive prompt/tool/session harness.
- [ ] Required failure oracle: installed `ompx config set providers.maxInFlightRequests '{"openai":"2","anthropic":0}' --json` must finish within 10 seconds, exit 1, include `Provider request limits must be positive numbers: openai, anthropic` on stderr, and leave the isolated config state unchanged.
- [ ] Drive explicit high-risk probes:
  - worker-host re-entry: installed `ompx --smoke-test` spawns and pings stats and tiny-model workers;
  - session: create, persist, resume, compact, and teardown a temporary session through the installed entrypoint; assert transcript/state and clean exit;
  - auth: focused account selection/pinning/rotation/fallback suites plus installed profile/model-resolution using isolated non-secret fixtures;
  - native: load and invoke reconciled local-platform exports via native tests and installed smoke;
  - updater/CLI: `packages/coding-agent/src/cli/update-cli.test.ts` must intercept the request and assert exactly `https://api.github.com/repos/qtnx/omppp/releases?per_page=100`; installed `ompx update --help` must exit 0 within 10 seconds, print OMPx update usage, leave binary/config checksums unchanged, and return without starting chat. Do not claim live updater-network isolation from the help probe.
- [ ] Fork-preservation matrix:

| Fork guardrail | Required evidence |
|---|---|
| Complete fork reachability inventory | every frozen `fork-reachability.tsv` row closed against final SHA; package/registration/public surface/evidence all present |
| Context GC plugin | `bun test packages/context-gc-plugin/test` |
| Delegation reminder | `bun test packages/delegation-reminder-plugin/test/extension.test.ts` |
| System context reminder | `bun test packages/system-context-reminder-plugin/test/extension.test.ts` |
| Safe orchestrator / workflow / duo / goals | relevant `interactive-mode-orchestrator-mode.test.ts`, `modes/workflow.test.ts`, `agent-session-duo-live-tools.test.ts`, and `goals/goal-mode-integration.test.ts` |
| Herdr state | `bun test packages/coding-agent/test/herdr-agent-state-extension.test.ts` |
| Idle-memory trim | `bun test packages/coding-agent/test/memory/idle-trim.test.ts packages/coding-agent/test/memory/idle-trim-wiring.test.ts packages/coding-agent/test/config/memory-idle-trim-settings.test.ts` |
| Browser annotate | `bun test packages/coding-agent/test/slash-commands/annotate.test.ts` plus browser package tests selected by CI |
| Agent `compact` tool | `bun test packages/coding-agent/test/slash-commands/compact.test.ts packages/coding-agent/test/compact-modes.test.ts`; add/reuse an installed `--smoke-test` subprobe that loads real runtime tool schemas, requires `compact`, invokes it on a seeded temporary compactable session, asserts the resulting compaction state/event, and exits nonzero on any mismatch |
| macOS sandbox | portable sandbox suites locally; PASS from `native_cross_platform_macos` and install-method CI for platform behavior |
| Tier names / tester additive / oracle retained | focused task/discovery tests and installed tool listing |
| OMPx branding/updater/version | installed `--version`, exact updater URL unit contract, update-help entrypoint probe, manifest checks |
| CI/security/install topology | semantic before/after contract plus PASS from `check`, native matrices, TS shards, `test_smoke`, `install_methods`, and `security` |

- [ ] After the last test/build/runtime probe, run `git diff --exit-code` and require `git status --porcelain --untracked-files=all` to print nothing. Any tracked or untracked output invalidates evidence; recreate the clean clone and rerun the complete Task 6 gate set.
- [ ] Repairs before first push are staged in the canonical worktree and folded into the local merge commit with `git commit --amend`. Every amended SHA revalidates and recloses all Task 5 feature/migration/semantic/clean/CI/fork artifacts against the new tree, reruns the **complete Task 6 gate set**, fork matrix, installed-binary harness, and adversarial completion review in a recreated clean clone. Record final candidate SHA only after the last full pass.

**Acceptance:** evidence is tied to one exact clean candidate SHA; dependency install is frozen; complete TS/Rust/static/smoke/script gates pass on that SHA; installed success/failure oracles pass; every frozen fork-reachability row and guardrail has final-SHA proof; unsupported platforms stay NOT VERIFIED until CI passes.

### Task 7: Independent review, QA, drift loops, and PR

- [ ] One independent reviewer inspects the exact candidate SHA, focusing on `agent-session.ts`, auth/account routing, task/orchestrator prompts/runtime, CI/release/installer, version/branding, migration closure, and all clean-path exceptions. Findings require file:line and a concrete failure scenario.
- [ ] One independent QA owner recreates the clean clone and reruns the installed-binary harness plus critical fork matrix. After its last probe, QA must run `git diff --exit-code` and require empty `git status --porcelain --untracked-files=all`; any output invalidates the run and requires a fresh clone/full QA rerun. L3 completion requires QA PASS on the exact final SHA.
- [ ] Challenge completion evidence with `super_review`; if unavailable, record the failure and use an independent slow-model adversarial review with complete plan/diff/evidence. No missing feature row, migration row, fork guardrail, semantic auto-merge, clean-path exception, CI contract, or distributable probe may remain.
- [ ] Immediately before first push, fetch `origin/main`. If it moved, merge new `origin/main` into the sync branch without rebasing; recompute drift conflict/semantic/clean denominators; fully reclose Task 5 feature/migration/CI/fork ledgers against the new tree; then rerun the complete Task 6 gate set, fork matrix, installed-binary harness, reviewer, QA, and adversarial completion review on the exact new tip.
- [ ] Push the exact verified tip to `origin/sync/upstream-main-2026-07-24`. Open a PR targeting `origin/main` with the upstream-merge template if present. Include refs/SHAs, feature and migration ledgers, conflict/semantic/clean decisions, CI contract diff, fork matrix, gates, platform gaps, and rollback.
- [ ] Any reviewer, QA, or CI repair after push lands as a normal fix commit on the sync branch—never a force rewrite. Each new head invalidates all old completion evidence: revalidate and reclose Task 5 artifacts against the new tree; recreate the clean clone; rerun the complete Task 6 gate set, fork matrix, installed-binary harness, reviewer, QA, and adversarial completion review; push; and wait for required CI again.
- [ ] Immediately before GitHub merge, query the PR’s immutable `headRefOid` and current `baseRefOid`; require head equals the last fully tested/reviewed/QA/adversarially approved SHA, base equals the last integrated `origin/main`, and `git merge-base --is-ancestor <baseRefOid> <headRefOid>` succeeds. If any check fails, do not merge: integrate base drift or investigate head drift, then fully reclose Task 5 and rerun Task 6/reviewer/QA/adversarial review/CI before rechecking.
- [ ] Require GitHub’s merge-commit method; squash/rebase are forbidden. Merge only after the head/base check and all required jobs pass.
- [ ] Fetch `origin/main`, record the PR merge SHA, and verify parent 1 is the checked pre-merge base, parent 2 is the checked verified sync head, the upstream integration merge remains in ancestry, and `<pr-merge-sha>^{tree}` exactly equals `<verified-head-sha>^{tree}`. Any tree mismatch fails completion and triggers immediate rollback of the outer PR merge.

**Rollback:** before PR merge, close the PR and delete only the sync branch. After PR merge, revert the **outer PR merge SHA** with `git revert -m 1 <pr-merge-sha>` after verifying parent 1 is the checked pre-PR main tip; never rewrite shared history. The inner upstream integration merge is evidence, not the normal rollback target. Publication/release is outside this plan.

**Observability after merge:** watch required smoke/install/native/security jobs, CLI startup/native sentinel failures, auth credential-selection regressions, session persistence/compaction errors, stats worker failures, and updater source/version output. Any regression blocks release; revert the PR merge if a safe forward fix is not immediate.

## Conflict ownership appendix

**107 predicted conflict files; every path has exactly one owner:**

### P1 session-advisor (12)

- `packages/coding-agent/src/advisor/__tests__/advisor.test.ts`
- `packages/coding-agent/src/advisor/advise-tool.ts`
- `packages/coding-agent/src/advisor/runtime.ts`
- `packages/coding-agent/src/async/job-manager.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/session/session-history-format.ts`
- `packages/coding-agent/src/session/session-loader.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/test/agent-session-acp-permission.test.ts`
- `packages/coding-agent/test/sdk-session-isolation.test.ts`

### P2 task-prompts (10)

- `packages/coding-agent/src/prompts/system/project-prompt.md`
- `packages/coding-agent/src/prompts/system/system-prompt.md`
- `packages/coding-agent/src/prompts/system/workflow-notice.md`
- `packages/coding-agent/src/prompts/tools/browser.md`
- `packages/coding-agent/src/prompts/tools/task.md`
- `packages/coding-agent/src/task/executor.ts`
- `packages/coding-agent/src/task/index.ts`
- `packages/coding-agent/src/task/types.ts`
- `packages/coding-agent/test/modes/workflow.test.ts`
- `packages/coding-agent/test/task/task-batch.test.ts`

### P3 ai-catalog (14)

- `packages/ai/src/auth-broker/remote-store.ts`
- `packages/ai/src/auth-storage.ts`
- `packages/ai/src/providers/google-shared.ts`
- `packages/ai/src/providers/openai-codex-responses.ts`
- `packages/ai/src/providers/openai-responses.ts`
- `packages/ai/src/providers/openai-shared.ts`
- `packages/ai/src/registry/meta.ts`
- `packages/ai/src/stream.ts`
- `packages/ai/src/utils.ts`
- `packages/ai/test/auth-storage-codex-selection.test.ts`
- `packages/ai/test/meta-provider.test.ts`
- `packages/ai/test/pi-native-client.test.ts`
- `packages/catalog/scripts/generate-models.ts`
- `packages/catalog/src/compat/openai.ts`

### P4 cli-ui-tools (39)

- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/src/cli/auth-gateway-cli.ts`
- `packages/coding-agent/src/cli/setup-cli.ts`
- `packages/coding-agent/src/config/model-resolver.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/modes/acp/acp-agent.ts`
- `packages/coding-agent/src/modes/components/status-line/component.ts`
- `packages/coding-agent/src/modes/components/transcript-container.ts`
- `packages/coding-agent/src/modes/controllers/event-controller.ts`
- `packages/coding-agent/src/modes/controllers/input-controller.ts`
- `packages/coding-agent/src/modes/controllers/selector-controller.ts`
- `packages/coding-agent/src/modes/interactive-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `packages/coding-agent/src/modes/types.ts`
- `packages/coding-agent/src/slash-commands/builtin-registry.ts`
- `packages/coding-agent/src/system-prompt.ts`
- `packages/coding-agent/src/tools/bash-interactive.ts`
- `packages/coding-agent/src/tools/bash.ts`
- `packages/coding-agent/src/tools/browser.ts`
- `packages/coding-agent/src/tools/browser/launch.ts`
- `packages/coding-agent/src/tools/image-gen.ts`
- `packages/coding-agent/src/tools/index.ts`
- `packages/coding-agent/src/tools/renderers.ts`
- `packages/coding-agent/src/tools/report-tool-issue.ts`
- `packages/coding-agent/src/tools/xdev.ts`
- `packages/coding-agent/src/utils/changelog.ts`
- `packages/coding-agent/src/utils/clipboard.ts`
- `packages/coding-agent/test/acp-agent.test.ts`
- `packages/coding-agent/test/agent-session-magic-keywords.test.ts`
- `packages/coding-agent/test/agent-session-skill-keywords.test.ts`
- `packages/coding-agent/test/bash-acp-terminal.test.ts`
- `packages/coding-agent/test/config-cli.test.ts`
- `packages/coding-agent/test/interactive-mode-loop.test.ts`
- `packages/coding-agent/test/modes/components/tool-execution-spinner.test.ts`
- `packages/coding-agent/test/modes/controllers/move-command.test.ts`
- `packages/coding-agent/test/modes/utils/render-initial-messages.test.ts`
- `packages/coding-agent/test/tools/lsp-regressions.test.ts`

### P5 runtime-packages (9)

- `crates/pi-natives/src/lib.rs`
- `docs/task-agent-discovery.md`
- `docs/tools/task.md`
- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/stats/src/aggregator.ts`
- `packages/stats/src/db.ts`
- `packages/stats/src/server.ts`
- `packages/utils/test/logger-multiprocess.test.ts`

### P6 manifests-ci (18)

- `.github/workflows/ci.yml`
- `Cargo.toml`
- `package.json`
- `packages/agent/package.json`
- `packages/ai/package.json`
- `packages/catalog/package.json`
- `packages/coding-agent/package.json`
- `packages/hashline/package.json`
- `packages/mnemopi/package.json`
- `packages/natives/package.json`
- `packages/snapcompact/package.json`
- `packages/stats/package.json`
- `packages/swarm-extension/package.json`
- `packages/tui/package.json`
- `packages/utils/package.json`
- `packages/wire/package.json`
- `scripts/ci-test-ts.ts`
- `scripts/install.sh`

### P7 generated (5)

- `Cargo.lock`
- `bun.lock`
- `packages/catalog/src/models.json`
- `packages/natives/native/index.d.ts`
- `packages/natives/native/index.js`

## Definition of done

- Full upstream merge history retained; no cherry-pick subset and no direct push to main.
- 824 clean upstream candidates retained unless a documented incompatibility requires adaptation.
- 107 textual conflicts and 165 semantic auto-merges reviewed with owner evidence.
- All intentional OMPx guardrails and fork-only features verified reachable.
- Upstream feature ledger complete; every major new feature taken or reconciled into one production path.
- Generated files regenerated; OMPx 1.x versions and branding intact.
- Focused tests, full TS/Rust suites, security/install gates, built binary, success path, and failure path verified.
- Independent reviewer and QA return PASS; PR CI green; PR merged into `origin/main`; merge parents verified.
