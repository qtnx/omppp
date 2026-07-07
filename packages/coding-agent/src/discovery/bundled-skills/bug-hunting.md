---
name: bug-hunting
description: MANDATORY for any bug fix, error, crash, exception, regression, flaky test, stack trace, or "it doesn't work" report. Use BEFORE editing any code to fix a defect — this skill contains the reproduce-first protocol, the hypothesis-driven debug loop (never shotgun-edit), stack-trace forensics per ecosystem, a decoder for common cryptic errors, and the fix-the-class rule. If you catch yourself about to add a null-check at the crash site or a try/catch to silence an error, STOP and read this skill.
---

# Bug Hunting

## The protocol — in order, no skipping

### 1. Reproduce FIRST. No reproduction, no fix.
Materialize the failure as something re-runnable: a failing test, or an exact command with observed wrong output.
- Reproduce on the REAL entry point (the same curl/click/command the reporter would use), not a synthetic inner call.
- Capture the broken output verbatim — it becomes the BEFORE half of your evidence.
- Flaky? Make it reliable before debugging: `for i in $(seq 50); do <cmd> || echo "FAIL $i"; done` — a 1/50 failure is now a repro. Flakiness itself points at time, ordering, or concurrency.
- Cannot reproduce after honest effort → that IS the finding. Report: exact versions, env, what you tried, what extra info would discriminate (logs, payload, timing). Do not "fix" what you cannot see fail.

### 2. Read the trace correctly (forensics)
The TOP of the stack is where it HURT, rarely where it BROKE. Find the first frame in YOUR code, then walk down to the frame that violated the invariant.
- **Node**: async traces lose frames across `await` — run with `--enable-source-maps`; `ERR_UNHANDLED_REJECTION` means the real trace was at the promise creation site, add a `.catch` log there (VERIFY-TEMP).
- **Go**: a panic dump lists ALL goroutines — find the one marked `[running]` that panicked, not the first printed. `-race` output: read both stacks, the bug is the unsynchronized pair.
- **Rust**: `RUST_BACKTRACE=full`; an `unwrap()` line in the trace is the symptom — the cause is why the value was None/Err.
- **Python**: "During handling of the above exception, another exception occurred" → the FIRST traceback is the real one; the second is collateral.

### 3. Hypothesis loop — the only legal debug method
Repeat until root cause:
1. State ONE hypothesis: "X is wrong because Y."
2. Design the CHEAPEST experiment that can DISCRIMINATE it (prove or kill it): a `VERIFY-TEMP` log at the exact suspicious line, a REPL call with the suspect input, a debugger breakpoint, a bisected input.
3. Run. Observe. Update: hypothesis dead → next hypothesis; alive → drill one level deeper.
4. ONE variable per experiment.
BANNED: shotgun edits ("change 3 things and rerun hoping"), rerunning unchanged code hoping for a different result, "fixing" before the hypothesis is confirmed by observation.

### 4. Localize by bisection when lost
- Regression with a known-good past → `git bisect start; git bisect bad; git bisect good <sha>; git bisect run <repro-cmd>`.
- Big failing input → cut it in half until minimal (delta debugging by hand).
- Layered system → probe each boundary with the same data: is the value already wrong at the DB? after the service? after serialization? The bug lives between the last-good and first-bad probe.

### 5. Root cause, not crash site
Walk 5-whys down: the null-deref frame is level 1; WHY was it null; WHY did the producer emit null; WHY did validation admit it. The fix belongs at the deepest level that is yours to own. A null-check at the crash site treats level 1 and ships the bug for the next caller.

### 6. Ask: "why did no test catch this?"
The answer names exactly where the regression test belongs. Write it BEFORE the fix so you watch it go red→green.

### 7. Fix the CLASS
Same defect pattern usually has siblings: search for it (`grep`/ast-grep the pattern, not the symptom). In-scope siblings: fix now. Out-of-scope: report in `Noticed:` with file:line.

### 8. Verify per skill://verify-before-done
Original reproduction re-run on the real entry point; paste BEFORE (broken) and AFTER (fixed) outputs; run the failure path; regression test in the suite.

## Cryptic-error decoder
- `EADDRINUSE` → stale process holds the port: `lsof -i :3000`, kill it; your last "test run" may have been against that stale process.
- `ECONNREFUSED` → the dependency isn't up/ready — go poll it; not a code bug yet.
- `ERR_REQUIRE_ESM` / `Cannot use import statement` → ESM/CJS boundary: check `"type"` in package.json, the importing file's extension, and the dep's exports map.
- Process killed / exit 137 → OOM: `dmesg | grep -i -E "kill|oom"`; reduce batch size or raise limit, don't "retry".
- Segfault after dependency change → native module built for another ABI: rebuild (`npm rebuild`, reinstall).
- CORS error in browser → server response headers problem; fix the server, never "disable CORS" client-side.
- Works locally, fails in CI → env diff: versions, timezone, locale, missing service, ordering. Read the CI workflow as the source of truth.

## Fresher traps — all BANNED as fixes
Null-check at the crash site; try/catch that swallows; `sleep()` for a race; special-casing the failing input; retry-until-passes; deleting the failing assertion; upgrading random dependencies "to see".
