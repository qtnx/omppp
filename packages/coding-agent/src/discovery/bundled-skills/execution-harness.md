---
name: execution-harness
description: Read when the system prompt's EXECUTION HARNESS earns-paragraph selects a full recipe (RISK-list work, L3, persistence/side-effect changes, or a claim whose failure would be invisible locally). Contains the repo-harness discovery order, the rung recipes (pure function, HTTP API, CLI, TUI, worker, UI), the data-realism ladder, the anti-theater rules, the missing-harness raise protocol, and the evidence format.
---

# Execution Harness

Green unit and integration suites are NECESSARY, never SUFFICIENT for RISK/L3 work. "It works" is a runtime claim; runtime claims are proven by executing the change the way its real caller will. This skill is the full procedure; the system prompt decides WHEN it applies (the earns-paragraph). Outside that scope, one run of the changed path plus one named failure path is the whole harness.

## Step 0 — discover the repo's own harness before building one
The repo usually already tells you how to run itself. Read, in order:
1. Manifest scripts — package.json "scripts", Makefile/justfile targets, pyproject/cargo/composer equivalents. `dev`, `start`, `serve`, `migrate`, `seed`, `db:*` are your commands.
2. docker-compose.yml / compose.yaml — the services (db, cache, broker) the app expects, with their ports and credentials.
3. .env.example / config defaults — every variable the app needs; copy to a local env file and fill from the compose values.
4. CI workflow files — a CI job is a WORKING harness recipe written by the team: it boots services, migrates, seeds, and runs in a clean environment. Copy its steps before inventing your own.
5. README / CONTRIBUTING — run instructions, seed users, known ports.
Only if none of these exist do you construct a harness from scratch — and then the harness you write is part of the deliverable, not scratch garbage.

## Recipe — pure function / module (rung 2)
1. Build realistic inputs: pull them from existing tests, fixtures, type definitions, or sample data in the repo; never "foo"/123 placeholders when the domain shape is known.
2. Invoke via the `eval` tool when available, else a Bun/REPL one-liner (`bun -e`, `python -c "from m import f; print(f(X))"`, or `node -e`); when setup is non-trivial, a tmp driver script in scratch space that imports the REAL module (no copy-pasted logic), calls it, prints results, and exits non-zero on mismatch.
3. Cover: the boundary value of every branch you changed, plus one invalid input asserting the designed error is raised.
4. Record command + output verbatim for the claim.

## Recipe — HTTP API (rungs 3+4)
1. Stand up dependencies with the repo's own means: `docker compose up -d <db …>` or equivalent. No compose → data-layer ladder below.
2. Migrate, then seed: run the repo's migration command; seed everything the flow needs — including a user for auth. Prefer the repo's seed script; else write one and KEEP it (it is harness, not garbage).
3. Boot the REAL server with the repo's own run command, in the background, logs redirected to a file. Never re-implement or partially mount the app "for testing".
4. Wait for readiness by POLLING a health endpoint or the port with a timeout — never a blind sleep. If it never comes up, print the log file and fix boot BEFORE testing anything.
5. Authenticate like a real client: log in through the real auth endpoint with the seeded user to obtain a token, or mint one with the app's OWN signing utility and the dev secret from the env file. NEVER disable or bypass auth middleware to ease testing — a bypassed middleware is an untested middleware.
6. Fire the real request with curl/httpie: exact method, path, headers, body. Assert status code AND specific response-body fields — never just "got 200".
7. Rung 4: when the flow persists data, query the database DIRECTLY (psql/mysql/sqlite3 or the repo's db console) and assert: expected rows exist with expected column values; related tables updated (audit rows, counters, join tables); row counts elsewhere UNCHANGED — no accidental writes.
8. Failure paths on the same rung, for applicable boundaries: invalid payload → the DESIGNED 4xx with the documented error shape; missing/invalid auth → 401/403 when auth protects the flow; persistence flows MUST assert the DB unchanged. A 500 on bad input is a bug, not a pass.
9. After ANY code edit, kill and re-boot the server before re-testing — a stale process means you are testing old code.
10. Teardown: kill background processes, keep logs; leave the harness (seed script + curl sequence + expected outputs) intact for the `qa` handoff and the user.

## Recipe — CLI (rung 3)
Run the PRODUCTION-EQUIVALENT entrypoint from a clean shell outside the repo: build/package, install into a clean prefix, then invoke the installed bin with minimal env and real arguments. Dev-tree invocations (`node dist/cli.js`, `tsx src`, workspace links, `bun link`) are below rung 3 for distributed CLI/TUI/agent code. `--help`/`--version` boot checks are smoke only, not verification. Assert stdout/stderr, exit code, and any files/DB state written. Failure path: bad flags/input → designed error + non-zero exit.

## Recipe — TUI / interactive agent (rung 3)
Drive the installed binary non-interactively through the changed path: stdin/flags when supported, else a pty harness (`script`, `expect`, node-pty). Assert transcript/stdout/stderr/exit/state. Routing, orchestrator, tool-wiring, and TUI CODE changes require this installed-entrypoint evidence. Prompt and agent `.md` wording changes earn only the prompt format check plus the focused prompt tests; build and install the binary only when the wording change is inseparable from a wiring change.

## Recipe — worker / consumer / scheduled job (rungs 3+4)
Publish a real message to the local broker, or invoke the consumer/job entry with a well-formed payload exactly as the runtime would deliver it. Assert processed side effects in the store; then the failure path: a poison message follows the designed retry/DLQ behavior, it does not crash the worker.

## Recipe — UI (rung 3)
Run the dev server and drive the actual flow with the browser tool, browser/E2E tooling, or a `browser_qa` subagent. Nothing browser-capable in the environment → verify to the highest reachable rung (component render + the API rungs behind it) and RAISE the gap per the protocol below.

## Data layer — realism ladder
Real engine via the repo's compose service > real engine in a container you start > local install > in-memory/sqlite substitute (ONLY after confirming the code contains no engine-specific SQL — check for dialect features first) > mock. Take the highest reachable rung; every step down MUST be declared in the claim. Direct-insert seeding is allowed for PREREQUISITE data only — the data your flow WRITES must be written by the flow itself, never pre-inserted and then "verified".

## Anti-theater rules
- BANNED: "smoke test passed" when what happened was compiles / imports / boots without crashing. Boot is not verification.
- BANNED: reporting a mocked-everything run as "works end to end". Name every fake in the claim ("mocked-boundary test: payment gateway stubbed").
- BANNED (RISK/L3 claims): calling the handler function directly and claiming the API works. The API works when a real HTTP request through the real router returns the right response AND the store holds the right rows.
- BANNED: testing against a different database/config than the booted app uses, or against a server not confirmed restarted after your edits.
- BANNED: asserting only the response and skipping rung 4 when persistence changed on RISK/L3 work.
- BANNED: claiming a changed path was verified by adjacent output. The run must traverse changed code and be revert-sensitive: reverting the diff must change the asserted output/state.
- Every runtime claim names its command, its observed output, and the state query with its result. No name, no claim.

## Missing harness — the raise protocol
When the required rung is unreachable (no credentials, external-only service, prod-only config, no container runtime):
1. Substitute what is substitutable first — one missing piece does not forfeit the rung: a compatible local engine for the DB; a stub for the ONE unreachable external boundary, recording exactly what your code sent it.
2. Verify everything below the gap at the highest rung reachable.
3. RAISE it to the user explicitly: what could not be executed, why, what it takes — and HAND OVER the ready-to-run harness (driver script, compose file, seed script, curl sequence with expected outputs) so the user closes the gap in ONE command.
4. Downgrade the claim honestly: "VERIFIED to rung N: <command + evidence>. NOT VERIFIED: <flow> — blocked on <gap>; run `<command>` to verify." A lower rung NEVER masquerades as full verification.

## Evidence format — every runtime claim in this shape
```
RUNG 3+4 — POST /users
$ curl -s -X POST localhost:3000/users -H "Authorization: Bearer $TOK" -d '{"email":"a@b.c","name":"An"}'
→ 201 {"id":"u_9f2","email":"a@b.c"}
$ psql "$DB" -c "SELECT email,status FROM users WHERE id='u_9f2'"
→ a@b.c | active   (users count 4→5, audit_log +1)
FAILURE: missing email → 422 {"error":"email_required"}; users count unchanged (5)
```
Anything that cannot be filled into this shape is NOT VERIFIED — say so.
