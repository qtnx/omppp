---
name: repo-runbook
description: Use at the END of the first working session in any unfamiliar repository, after codebase-recon, or whenever you have just verified run/build/test commands, discovered landmines, or built harness pieces that future sessions would otherwise rediscover from scratch. This skill turns session discoveries into a persistent per-repo runbook skill so the archaeology is paid for exactly once.
---

# Repo Runbook

Recon and harness-building are expensive. Their output is knowledge; knowledge that dies with the session gets re-bought every time. Persist it as a small per-repo skill.

## When to write/update
- End of the FIRST session in a repo (after skill://codebase-recon ran).
- After building any harness piece (seed script, compose additions, driver, curl sequence with expected outputs).
- After stepping on a landmine future sessions must not repeat (the flaky suite, the port conflict, the env var that must be set, the package that must build first).
- Whenever a runbook entry proved STALE this session — fix it now; a wrong runbook is worse than none.

## Where
A skill folder named `<repo-name>-runbook/SKILL.md` in the harness's skills directory (project-level skills dir if the harness scopes skills per project; else the user skills dir). One runbook per repo.

## Iron rule: evidence-based entries only
Every command in the runbook was RUN this session and its outcome observed. Never write a command you believe should work — the runbook's entire value is that its contents are verified. Mark anything uncertain explicitly as `UNVERIFIED:` or leave it out.

## Template
```markdown
---
name: <repo>-runbook
description: MANDATORY when working in the <repo> repository — verified run/build/test commands, ports, seed users, environment quirks, conventions to mirror, and known landmines. Read this BEFORE codebase exploration; it replaces most recon.
---

# <repo> Runbook  (verified: <date>)

## Run it
- deps:    docker compose up -d postgres redis        # ports 5433, 6380 (non-default!)
- env:     cp .env.example .env  (must set STRIPE_KEY=sk_test_anything — boot fails without)
- migrate: pnpm db:migrate      seed: pnpm db:seed    # seeds admin@x.y / password123
- dev:     pnpm dev             # :3000, health at /healthz, ready ~8s
- built:   pnpm build && node dist/server.js          # the artifact that ships

## Green (the repo's own gates)
- pnpm typecheck && pnpm lint && pnpm test            # test needs deps UP
- CI mirror: .github/workflows/ci.yml — copy its steps for a clean-env run

## Profile
DISCIPLINED | types: strict TS | tests: covered (vitest, colocated *.test.ts)
Pattern to mirror for new features: src/features/invoices/** (newest, blessed)
Error envelope: src/lib/errors.ts::sendError — never inline error JSON

## Harness pieces built (reusable)
- scripts/seed-orders.ts — seeds an order in each status
- /tmp not used; drivers live in scripts/dev/ by team convention

## Landmines
- test suite is order-dependent in test/billing/** — run whole dir, not single files
- port 3000 often held by stale process: lsof -i :3000 first
- prisma client must regenerate after schema pull: pnpm db:generate

## UNVERIFIED / open questions
- deploy process unknown (no CI deploy job found)
```

## Maintenance discipline
- Append new discoveries at the matching section; correct stale lines the moment a command's behavior changed (include the new verified date).
- Keep it under ~150 lines: a runbook is the distilled essentials, not a wiki — details that matter only once don't belong.
- Never store secrets — placeholder names and where to get values, only.
- Update is part of the session's cleanup phase, not an optional extra: if this session's work changed the run/build/test story (new env var, new migration step), leaving the runbook stale breaks the next session.
