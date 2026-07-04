---
# PLAN v2: Robust dual-window (5h/weekly) rate-limit headroom for subagent Fable routing

## User-locked requirements (non-negotiable, approved by user)
- Threshold to use Fable: utilization < 50% (strict), default 0.5, configurable.
- Feature toggle ON/OFF with DEFAULT OFF: `task.limitAwareModelRouting` default changes true -> false.
- 5-hour AND weekly windows explicit: per-window evaluation and reporting.
- Kept from v1: heavy_task/plan/qa default chains anthropic/claude-fable-5:low -> openai-codex/gpt-5.5:high -> prior roles; model-scoped tier isolation; optimism-on-missing; fail-open stable partition; per-spawn re-evaluation; NO commit (AGENTS.md, unasked).

## Locked decisions
D1 Combinator: default 'all' - Fable qualifies only while EVERY classified gating window (5h AND weekly) is below threshold. Rationale: user's bar '<50% de dung fable' + burn-protection ('>=95% thi de no burn het cua tao a'); OR would let one window burn to exhaustion while the other is low. Hedge knob: `task.modelRoutingWindowMode: 'all'|'any'` default 'all' ('any' = one window under threshold suffices).
D2 Threshold: strict less-than. usedFraction < threshold = room on that window; >= threshold blocks it. packages/ai HEADROOM_UTILIZATION_MAX 0.95 -> 0.5. New setting `task.modelRoutingUtilizationMax` (number 0..1, default 0.5) forwarded as opts.utilizationMax.
D3 Toggle default: `task.limitAwareModelRouting` -> false.
D4 Window classification per scoped limit: durationMs ~= 18_000_000ms (+/-20%) => '5h'; ~= 604_800_000ms (+/-20%) => 'weekly'; id-substring fallback: '5h' or ':primary' => 5h; '7d' or 'week' or ':secondary' => weekly (mirrors codex-auto-reset.ts conventions); else 'other'. 'other' windows block in 'all' mode (conservative); in 'any' mode they count only when no 5h/weekly windows exist.
D5 Hard gates independent of combinator/threshold: (i) all credentials blocked => reason 'credential-blocked'; (ii) any NON-STALE scoped window exhausted => reason 'window-exhausted' (provider 429s regardless of the other window).
D6 Stale-window guard: a window whose window.resetsAt <= now is treated as already reset - never blocks, utilization ignored.
D7 Observability: UsageHeadroom gains `window?: '5h'|'weekly'|'other'` (decisive blocker) and `windows?: Array<{ kind: '5h'|'weekly'|'other'; usedFraction?: number; resetsAt?: number; exhausted: boolean }>`; keep reason enum ('credential-blocked'|'window-exhausted'|'window-utilization') and resetAtMs. getUsageHeadroom signature: (model, opts?: { utilizationMax?: number; windowMode?: 'all'|'any' }).
D8 Unchanged: model-scoping via #getScopedUsageLimits, optimistic on missing report/creds/limits, credential-block precedence, cache-first with allowed deduped background refresh, sync, no token minting.
D9 No commit.

## File-level changes
packages/ai:
- src/auth-storage.ts: rework getUsageHeadroom per D1-D8 (window classification helper, per-window eval, hard gates, stale guard, windows[] reporting, HEADROOM_UTILIZATION_MAX=0.5, opts.windowMode).
- src/usage.ts: extend UsageHeadroom per D7; export window-kind type.
- test/auth-storage-usage-headroom.test.ts: rework per Acceptance below.
- CHANGELOG.md: amend existing Unreleased entry (ours, unreleased).
packages/coding-agent:
- src/config/settings-schema.ts: limitAwareModelRouting default false; add task.modelRoutingUtilizationMax (number, default 0.5, clamp 0..1) and task.modelRoutingWindowMode (enum 'all'|'any', default 'all'), same tab/group Subagents.
- src/config/model-resolver.ts: selectHeadroomAwareModelPatterns reads both settings and forwards { utilizationMax, windowMode } to getUsageHeadroom.
- test/model-resolver.test.ts: update describe block per Acceptance.
- CHANGELOG.md: amend Unreleased entry (default off, <50% dual-window criterion, knobs).

## Sequencing (executor, Safe orchestrator mode)
Wave 1 parallel disjoint: [A] heavy_task self_review=true: packages/ai rework + tests. [B] task: coding-agent settings + forwarding + tests (stubs getUsageHeadroom in tests; only contract dependency is the opts shape locked in D7).
Wave 2: focused suites; feature-file-only bun check classification; qa agent re-verification.
Wave 3: report. NO commit.

## Acceptance checks
ai suite:
1. 5h=10%, weekly=90%, none exhausted, non-stale, thr 0.5: mode 'all' => hasRoom false, window 'weekly', windows[] has both; mode 'any' => true.
2. 5h=60%, weekly=10%: 'all' => false window '5h'; 'any' => true.
3. 49%/49% => true (strict boundary); 50% exact on one window in 'all' => false.
4. weekly EXHAUSTED + 5h=10% => false 'window-exhausted' even in 'any' (hard gate).
5. stale window (resetsAt in past) at 99% + other 10% => true (stale guard).
6. default threshold now 0.5 (0.6-window blocks with no opts); custom utilizationMax honored.
7. model-scoped isolation preserved (opposite tier exhausted => true).
8. optimism paths preserved (no creds / null report / no scoped limits => true).
coding-agent suite:
9. default state (toggle unset=false) => routing INERT: array unchanged even when stub reports no-room.
10. toggle on => partition works; forwarding assertion: getUsageHeadroom receives { utilizationMax: 0.5, windowMode: 'all' } by default and configured values when set.
11. all prior guard/partition/fail-open cases stay green.
Gates: both suites 0 fail; lsp clean on touched files; feature files absent from repo bun check error set (pre-existing failures out of scope); qa verdict pass covering cases 1-5 and 9-10 minimum.
---
