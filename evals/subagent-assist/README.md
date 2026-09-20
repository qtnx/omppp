# Subagent assist and autonomous completion

The production corrections are implemented. The main-stream completion backstop and the concrete confidence/context/agent-precedence regressions pass the focused package checks. This does **not** establish perfect classifier accuracy or a general speed improvement.

## Reproduce

From the repository root:

```sh
bun evals/subagent-assist/run.ts --repeat 3
bun evals/subagent-assist/run.ts --held-out --repeat 3
bun evals/subagent-assist/stop.ts
bun --cwd=packages/coding-agent run build
bun evals/subagent-assist/runtime.ts
bun evals/subagent-assist/ab.ts --repeat 2 --timeout 300
```

`run.ts` supports `--suite all|brief|route|context|triage|evidence|findings`, `--held-out`, repeated `--task <id>`, `--repeat`, `--list`, and `--json`. `ab.ts` supports repeated `--case <id>`, `--arm on|off|both`, `--repeat`, `--timeout`, and `--json`.

The old `invariants.test.ts` failure was moved into `packages/coding-agent/test/task/jev-findings.test.ts` and now passes. It is not skipped or duplicated.

## Runtime contract

`autonomy.stopGate` defaults to true and is independent of `advisor.doneGate` and `task.jevAssist`. It applies to the main stream, including the duo executor, before the expensive advisor review. It uses one bounded, redacted TypeSafe request with four judgments: stop kind, outcome satisfaction, external blocker, and required user decision.

A high-confidence premature question, partial report, or locally resolvable blocker schedules scoped continuation. Open todo/goal obligations cannot be erased by a complete verdict. Repeated non-progress changes the reminder to require a different strategy; there is no arbitrary two-rejections-then-quit exemption. Existing user/platform limits and loop controls remain binding.

Cancellation, queued user control, stale generations, successful terminal yield, pending asynchronous work, enforced budgets and mode restrictions take precedence. A required decision does not grant permission to execute. Plan/report-only tasks keep their own artifacts; a negative report is not automatically a request to edit.

Unavailable or inconclusive classification receives one primary-context audit per genuine request; an outage never becomes claimed approval. Disabling signals does not itself add a model turn, but open local obligations still require completion even without classification or after the audit allowance is exhausted. Disabling `autonomy.stopGate` disables this backstop. The service timeout and failure budget remain bounded. A classifier is advisory, not proof that arbitrary commands ran.

Outbound state contains bounded user requests/candidate text, open-item descriptions and structural tool receipts, not raw tool output, source-file bodies or stdout/stderr. Exact session-secret replacement and credential-pattern redaction run before transport. Malformed, null, array, inconsistent and out-of-range answers are unavailable. Stop assessment does not overwrite the existing turn-signal `latest` value.

Subagent context selection now considers chronological relationships, deduplicates identical normalized sections at their latest position, and resolves required/supporting/superseded/irrelevant decisions. Required sections are never truncated into misleading fragments. Incomplete coverage explicitly requires reading the full available snapshot; shared assignment/context are never filtered. Explicit item and batch agent choices both beat automatic routing. Uncertain drop judgments retain original findings and priorities.

## Verified package and installed entrypoints

The locked package command was run from `packages/coding-agent`:

```sh
bun test test/agent-session-completion-gate.test.ts test/agent-session-done-gate.test.ts test/agent-session-session-stop-will-continue.test.ts test/agent-session-concurrent.test.ts test/agent-session-yield-empty-stop-suppression.test.ts test/tools/yield.test.ts test/tools/yield-extraction.test.ts test/signals/turn-signal-service.test.ts test/task/jev-findings.test.ts test/task/jev-context.test.ts test/task/jev-brief.test.ts test/tools/task-agent-capabilities.test.ts test/system-prompt.test.ts
bun run check
```

Observed after final lifecycle corrections: **200 pass, 0 fail, 683 assertions across 13 files**. Package check exits 0 with 97 existing warnings. Completion-specific tests drive real session calls, file writes, cancellation, queued user control, a genuine hard budget and exact request serialization. Print-mode coverage restores the required public JSON sequence **`isTerminal: false`, then `true`**: suspended ends are emitted immediately, and only terminal ends wait for prompts to unwind. A clipping regression proves that prior requests exceeding the outgoing bound cannot produce a trusted approval; the controller performs its single full-context audit instead. Four RPC/print consumer suites additionally pass **25 tests**.

Independent QA reran the corrected four lifecycle/privacy/yield suites: **37 pass, 0 fail, 121 assertions**. It also ran `runtime.ts` against the rebuilt binary from a clean temporary installation. The success case exited 0 and produced the exact artifact. The first external-blocker attempt preserved the no-write boundary but exited 1, so it was not accepted as a pass. A failed-case-only rerun (`runtime.ts --external-only`) exited 0 with one `stop` reply, no artifact, no error, `harnessTimeout:false`, and `cleanup:true`. The earlier exit 1 remains a recorded failed attempt; its cause was not established by the original aggregate output.

Canonical binary: `packages/coding-agent/dist/ompx`; `--version` reports `ompx/1.10.1`, and `--smoke-test` reports `smoke-test: ok`. No renamed alias or global installation was made.

`runtime.ts` copies that built binary into a clean temporary installation, runs outside the repository with only read/write tools, and removes the installation afterward. Final observations:

| Scenario | Exit | State | Model replies |
| --- | ---: | --- | ---: |
| Authorized local file creation | 0 | `delivery.txt` exactly `verified-completion` | 3 |
| User-held approval missing | 0 | No `approval.txt` written | 1 |

Both scenarios had no surfaced model error; cleanup completed. These two live scenarios supplement scripted-boundary tests, not a universal autonomy guarantee.

## Classifier measurements and provenance

Original six-capability corpus: 40 synthetic labeled cases, three attempts each. Labels were frozen before production prompt corrections; no finding fixture claims a real vulnerability exists in this repository.

- Historical baseline: `results/all-2026-09-20T06-56-25-004Z.json`, **93/120 (77.5%)**.
- After confidence/context fixes, before policy clarification: `results/all-2026-09-20T13-46-02-781Z.json`, **93/120**.
- Final corrected policies: `results/all-2026-09-20T13-51-56-159Z.json`, **120/120**, no abstentions. Capability medians were 348–374 ms; p95 394–470 ms.
- Untuned holdout: `results/all-2026-09-20T13-54-32-893Z.json`, **15/18 (83.3%)**. The brief-scope case missed in all three attempts. It was retained, not relabeled or used for another tuning round.
- New stop corpus: `results/stop-2026-09-20T13-46-11-344Z.json`, **15/24 exact probability-band matches**, zero unavailable responses. Misses concern report-only/approval cases with intermediate satisfaction probabilities; required-decision scores remained high on approval cases. No false high-confidence completion or false low-satisfaction continuation was observed in this small corpus. Runtime decisions and hard guards are tested separately.

The final 120/120 is an **in-sample** result: generic scope, severity/exclusion, context-ID and research-routing rules were clarified against observed policy ambiguities. The holdout is small and shows generalization is not perfect. Thresholds were not lowered to manufacture hits.

Transport controls still fail honestly. `TYPESAFE_SYSTEMONE_URL=http://127.0.0.1:1 bun evals/subagent-assist/run.ts --suite brief --task brief-good-context --repeat 1` returned **0/1, one abstention, exit 1** (`results/brief-2026-09-20T13-49-42-871Z.json`). A clean brief returning `[]` remains valid; missing transport answers cannot be mistaken for clean success.

Artifacts record corpus/runner hashes, model, endpoint origin, attempted counts, abstentions and latency. Selected context uses source-section IDs, not captured private transcripts. Changed corpus or harness hashes must not be presented as directly comparable measurements.

## Paired runtime measurement rules

The current A/B runner uses the canonical built binary rather than importing a mutable source checkout at every invocation. It records its binary hash, source-anchor hash, configured model roles, observed parent model, child ID/agent/status and completed-child duration. A temporary cwd and isolated `.omp/config.yml` are created per arm; settings are checked before launch and removed afterward. No credentials are copied.

Runtime task envelopes, not parent prose, determine results. Cancelled/failed children never become successes. Child timing comes from completed result metadata; whole-flow elapsed time is separate. Duplicate child receipts are coalesced by ID. `harness_timeout` requires the harness's own termination timer to fire; other nonzero exits are CLI errors. Failed attempts remain in denominators, and bounded redacted result text is retained for diagnosing factual mismatches.

Historical `results/ab-2026-09-20T06-41-39-646Z.json`: lookup OFF **4/4**, ON **3/4**; whole-flow medians 108.42s/84.96s. This was not a speed win because ON reliability fell. One separate ON evidence run exited 1 without a task result. Its raw stderr/session evidence was not retained, so that historical exit cannot honestly be reconstructed from elapsed time; it is distinct from the recorded exit-143 termination.

Subsequent source-based runs and retries remain in `results/`. One OFF compaction lookup missed and passed on a diagnostic rerun (`ab-2026-09-20T13-51-56-419Z.json`, child 58.2s, whole flow 190.29s). A later source run (`ab-2026-09-20T13-58-59-838Z.json`) contained several fast CLI startup errors; those are not timeouts or successes and are not removed from denominators.

Final canonical-binary run (`results/ab-2026-09-20T14-02-17-637Z.json`), six invocations, counterbalanced arms, 300s deadline:

| Arm | Lookup correct | Median whole flow | Median completed child |
| --- | --- | ---: | ---: |
| assist OFF | 2/2 | 66.81 s | 20.45 s |
| assist ON | 2/2 | 78.45 s | 25.35 s |

The evidence-signal case completed in both arms (OFF 59.37s n/a, ON 54.13s with the expected weak-evidence signal). No final binary run was cancelled or lost a lookup. This is **not** a speed claim: whole-flow time includes parent/provider latency, the sample is two pairs, and ON was slower here. An earlier source-based 12-invocation run recorded OFF 3/4 and ON 4/4 with whole-flow medians 112.39s/76.19s and completed-child medians 45.7s/23.75s. One ON evidence run exited 1 at 305.71s without the harness timer firing, so it is `cli_error`, not `harness_timeout`. Its precise cause cannot be reconstructed from elapsed time and the retained aggregate metadata; the application deadline is not a proven explanation.
