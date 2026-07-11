---
name: codebase-recon
description: MANDATORY for unfamiliar non-trivial areas, but bounded to signals that can change the current slice. Contains a recon menu, stop conditions, codebase buckets, and cleanup-time runbook persistence; recon never becomes a Foundation phase.
---

# Codebase Recon

Measured, not exhaustive. Recon only the touched area and only until route, current contract, production owner, and acceptance are known. Then implement; future-phase questions remain future work.

## The 10 signals — with the command to measure each
This is a menu, NOT a checklist. L1 uses 0–1 signals, L2 normally ≤3, L3 normally ≤5; exceed only for ONE named blocker. A second lookup that cannot change the next production action is a stall.
1. TEST POSTURE — `find <target-dir> -name "*test*" -o -name "*spec*" | head`; CI presence: `ls .github/workflows *.gitlab-ci.yml 2>/dev/null`. → covered / partial / none. None = no net: characterize before restructuring (skill://refactoring-safely).
2. TYPE SAFETY — `cat tsconfig.json | grep -A5 compilerOptions` (strict?); `cat mypy.ini setup.cfg pyproject.toml 2>/dev/null | grep -i strict`; Go/Rust = strong by default. → strong types let you refactor by "break and follow errors"; weak types mean grep lies — verify at runtime.
3. GATES — `cat package.json | jq .scripts`; `grep -E '^[a-z-]+:' Makefile`; CI steps. The repo's OWN definition of green — run THOSE, never invent parallel gates.
4. CONVENTIONS — open 2–3 sibling modules of the same kind as your target; note the dominant pattern for naming, error handling, DI, test layout. Fragmented with no dominant → interview trigger.
5. BLAST RADIUS — LSP `references` on every symbol you'll change. The count is your migration denominator and a lane input.
6. CHURN — `git log --oneline -n 100 -- <path> | wc -l` and `git log -n 5 --format='%ar %s' -- <path>`. Hot = load-bearing, someone depends on every quirk. Cold + untested = archaeology: characterize first.
7. DEBT DENSITY — `grep -rn "TODO\|FIXME\|HACK" <target-dir> | wc -l`; commented-out blocks nearby. Context, not license — match conventions, don't extend debt.
8. SOURCE OF TRUTH — README, ADRs (`docs/adr`, `docs/decisions`), OpenAPI/proto/schema files. Docs contradict code → interview trigger, not a coin flip.
9. OBSERVABILITY — `grep -rn "logger\.\|log\.\|metrics\." <target-dir> | head` — what do features here emit? Weighs into risk-lane rollout design.
10. DEPENDENCY FRESHNESS — lockfile version of libs you'll touch vs manifest range; a lib 3 majors behind means online docs describe an API you don't have — read the INSTALLED version (skill://dependency-doctor).

## Buckets → strategy
- GREENFIELD — nothing exists. Your choices become law: boring dominant-ecosystem defaults, one pattern per concern; README/run/test instructions and the first tests ARE deliverables (the template everyone copies).
- DISCIPLINED — tests + CI + consistent conventions. Move fast, the harness is your net; conform exactly — the diff should read as if the team wrote it.
- LEGACY-UNTESTED — no net. Characterization tests around the change area BEFORE restructuring; smaller verified steps; no drive-by modernization.
- FRAGMENTED — competing patterns. Follow the dominant/newest-blessed one; genuinely 50/50 → ask which is canonical. NEVER add pattern #3.

## Recon report — the output shape
```
PROFILE: <bucket>  (target: <area>)
green = <exact commands>            tests: <covered|partial|none>
types: <strong|weak|none>           churn: <hot|warm|cold> (<n> commits/100)
pattern to mirror: <file of the newest sibling feature>
blast radius: <symbol → n references>
landmines: <anything surprising, with file:line>
open questions: <docs-vs-code conflicts, fragmented patterns → interview items>
```

## Persist during cleanup
After the first executable slice works, persist verified run/build/test facts via skill://repo-runbook. Runbook writing NEVER blocks production dispatch.
