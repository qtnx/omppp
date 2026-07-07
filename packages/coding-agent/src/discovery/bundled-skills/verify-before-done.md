---
name: verify-before-done
description: Use when about to claim a coding task is done, fixed, implemented, passing, ready, or complete; when only tests/build/smoke are known; or when missing runtime, services, credentials, browser/device, or run instructions may tempt a lower claim.
---

# Verify Before Done

Evidence before claim. A completion claim is allowed only for behavior you executed in this session through the highest reachable real path. If proof is partial, say exactly what is VERIFIED, what is NOT VERIFIED, why, and the one command or harness that closes the gap.

This skill applies to coding tasks. For BEHAVIOR=no work (docs, comments, changelog, formatting, copy text), runtime rungs are not required; use targeted static, render, link, format, or prompt-template gates and say that no runtime behavior changed.

# No completion claim without fresh evidence

Before saying done, fixed, implemented, passing, ready, complete, or equivalent:

1. Name the user-visible or caller-visible behavior that changed.
2. Pick the highest required rung below.
3. Run the command or scenario fresh after the final edit.
4. Read the full output and check the exit code/state.
5. Claim only what the evidence proves.

Unit tests, component tests, typecheck, build, import, boot, and smoke scripts are useful gates. They are not proof that runtime behavior works unless they drive the real entry point and check the resulting state.
Integration tests count as rung 3 or 4 only when they demonstrably boot the real app entry point and inspect the same store used by that process. A smoke test counts only for the behavior it actually drives; booting, printing --help, or pinging a worker is not feature verification.

# Evidence rungs

1. STATIC: typecheck, lint, build, package manifest checks. Proves only that code compiles or formats.
2. DIRECT INVOCATION: call the changed function/module with realistic inputs. Full proof only for pure logic.
3. REAL ENTRY POINT: drive the running application through the same surface the caller uses: HTTP request, CLI invocation, browser action, worker message, cron entry, queue consumer, mobile wrapper, desktop shell.
4. STATE AND SIDE EFFECTS: inspect the actual store after the entry point runs: database rows, files, cache, events, queues, local/session storage, audit logs, counters, emitted messages.

Required rung follows the change:

- Pure function or parser: rung 2 plus an invalid/boundary case.
- Routing, middleware, serialization, auth, config, dependency injection, packaging, CLI command, UI flow, worker wiring: rung 3.
- Persistence, side effects, money, audit rows, files, cache, queues, external calls: rungs 3 and 4.
- Bug fix: reproduce the original failure first when possible, then show fixed output after the patch.
- Refactor: prove representative behavior before and after, then run contract tests.

# Step 0: find the repo harness first

Before inventing commands, read the repo's own answers:

- package.json, Makefile, justfile, pyproject, cargo, composer, gradle, or scripts directory.
- docker-compose.yml or compose.yaml for databases, brokers, caches, ports, and credentials.
- .env.example, config defaults, dev secrets policy, seed users.
- CI workflow files; CI often contains the clean boot/migrate/seed/test recipe.
- README or CONTRIBUTING run instructions.

Use that recipe literally unless it is broken. If it is broken, report what failed and fix or adapt the smallest missing piece.

Before starting anything new, check for an existing dev server, compose stack, tmux/session, browser tab, or other repo harness:

- Reuse it when the entry point, engine, env, and store match the recipe. Never start a duplicate harness on the same port, database, or store.
- Restart or boot fresh when stale or on the wrong env/store: unresponsive health/port, wrong branch/build/bundle, credentials, or code edits not yet live.
- Prove freshness after edits: with hot/live reload, show a marker, log line, version/hash, or behavior delta from before the edit. A listening process alone is not proof.
- Leave the harness running when useful for user manual testing; always report URL, session name, log path, and the cleanup command (even when cleanup is deferred).
- Remove VERIFY-TEMP probes before completion; a left-running harness is not leftover instrumentation.

A stale or duplicate harness invalidates runtime proof.

# Recipes

## Backend HTTP API

1. Reuse running dependencies from an existing compose stack or local services when fresh and on the correct env/store; otherwise boot dependencies with the repo's own recipe. Use the real database engine when available.
2. Run migrations and seed prerequisite data through the repo's seed path.
3. Reuse an existing dev server or session when fresh and on the correct env/store; otherwise boot the real server in the background with logs to a file (tmux, nohup, repo dev command, or process manager). After any code edit without proven hot/live reload, restart before re-testing. Report URL, session name, log path, and cleanup command; leave running for user manual testing when useful.
4. Wait for readiness by polling a port or health endpoint; never sleep blindly.
5. Authenticate like a real client. Do not disable auth middleware.
6. Send the real request with curl/httpie/fetch using exact method, path, headers, and body.
7. Query the actual database or store for changed rows, audit rows, counters, and unchanged unrelated counts.
8. Run at least one failure path on the same boot: invalid input, missing auth, insufficient scope, or downstream failure.

## Microservices, workers, consumers, scheduled jobs

1. Map the service boundary and downstreams from code/config.
2. Boot the minimal real set: service under test plus its DB/broker/cache dependency.
3. Publish the real message or invoke the actual worker/cron entry with a payload shaped exactly like production.
4. Verify side effects in the service's own store and emitted events/messages.
5. For a changed message/API shape, verify both producer and consumer, or explicitly report the compatibility gap.
6. Failure path: poison message, retry, DLQ, timeout, or duplicate delivery behaves as designed.

## CLI, binary, package, or path-resolution fix

1. Build the distributable artifact that users receive: tarball, wheel, binary, npm package, container, or app bundle.
2. Install or unpack that built artifact into a clean temp environment with no repo path on PATH, NODE_PATH, PYTHONPATH, or cwd lookup.
3. Prove resolution uses the installed artifact: which/command -v, package manager output, binary path, version, checksum, or archive contents.
4. Run the installed artifact from outside the repo with realistic arguments. Source-tree --help, a shallow smoke test, or an in-repo `dist/` path is not enough for a feature claim.
5. For interactive CLI/TUI/REPL behavior, start the built artifact under tmux, nohup, the repo's process manager, or an equivalent persistent session; record command, log path, readiness signal, PID/session name, and cleanup command.
6. Drive the changed behavior through that running artifact: key sequence, command, prompt, API call, worker trigger, config file, or user flow exactly as a real caller would.
7. Check state and side effects when the feature writes anything: files, config, session DB, logs, cache, spawned process state, or emitted events.
8. Failure path: unknown flag, missing input file, malformed config, missing packaged resource, invalid state transition, or permission error returns the designed stderr/UI message and non-zero exit when applicable.
9. Handoff: always remove VERIFY-TEMP probes and prove no markers remain. Leave tmux/nohup/session processes, temp installs, or test data running when useful for user manual testing; report URL/session/log path and cleanup command either way.

## Frontend web

1. Reuse an existing dev server or preview when fresh (correct env, bundle, and hot/live-reload proof after edits); otherwise build the real bundle and serve it when users receive a bundle. Do not start a duplicate server on the same port. A dev server is acceptable only when the claim says dev mode was tested. Report URL, session, log path, and cleanup command; leave running for user manual testing when useful.
2. Drive the actual user flow with the browser tool or project E2E tool.
3. Assert visible output, route/state, relevant DOM text, and browser console free of new errors.
4. Close the state loop: inspect API response-derived state, local/session storage, cache, or backend/store data that backs the UI.
5. Failure path: invalid input/error state displays as designed and does not leave stale success data or disabled controls.
6. If a bug report names multiple affected shells, a full fixed/done claim requires verification on every named shell; proving one browser path does not prove mobile or desktop.

## Mobile wrapper and desktop app

Responsive browser width is not mobile wrapper verification. For mobile, run the app through the device/emulator/simulator or accepted wrapper harness so the bridge/webview path executes. Record device/emulator identity and app/build identity.

For desktop, run the packaged desktop artifact or Electron/Tauri shell when that is what users receive. Record app/window identity, renderer URL or bundle version, and visible post-action state.

## Browser/device unavailable

If browser, mobile, or desktop tooling is unavailable, verify the highest reachable rung below the gap, then mark the browser/device path NOT VERIFIED and hand over the exact command or manual script needed to close it. A session not currently open is not unavailable when the browser/device tool exists; open or provision it unless a higher-priority constraint forbids commands.

# SELF-RESCUE for missing environment

Never stop at "Docker is not running", "DB credentials missing", "no browser open", or "service unavailable" without trying this ladder in order:

1. SEARCH: use repo scripts, CI, README, compose, test fixtures, and config defaults.
2. PROVISION: start the local service, install the pinned toolchain, copy .env.example to a local env file, generate dev-only secrets, run migrations/seeds.
3. SUBSTITUTE: replace only the smallest unreachable boundary, and only after verifying the substitution does not intersect the changed behavior. Examples: local DB engine for DB, localhost HTTP stub for one external API, in-memory broker only when broker semantics are not under test.
4. INSTRUMENT: add temporary probes only when needed. Mark every temporary line with VERIFY-TEMP, keep it out of production logic, and remove it before completion. Prove cleanup by searching for VERIFY-TEMP before yielding.
5. RAISE: if still blocked, deliver everything verified below the gap plus a one-command harness: script, compose file, seed data, curl sequence, expected output, and cleanup command.

A lower rung never masquerades as full verification.

# Temporary instrumentation rules

- Add the smallest probe at the exact boundary: caller input, outbound request body, DB write, emitted event, or cache key.
- Never fake the behavior under test.
- Never commit or yield with VERIFY-TEMP still present.
- Always remove VERIFY-TEMP probes before completion. Leave temp files/data/processes only when they are explicit harness artifacts for user manual testing, and report the cleanup command.
- If using tmux/nohup/background processes, record the command, log path, readiness check, process id/session name, URL when applicable, and cleanup command (even when leaving the harness running).

# Red flags

These phrases mean stop and gather better evidence or downgrade the claim:

- "Tests pass, so it works."
- "Build passed, so the feature is done."
- "Smoke test passed" when it only booted or printed --help.
- "Should work" or "probably fixed".
- "Could not run Docker/DB/browser, so I skipped it".
- "I mocked the DB/API/browser and verified end to end".
- "The handler function returned OK, so the HTTP endpoint works".
- "The responsive viewport worked, so mobile is verified".
- "Source --help works, so the installed CLI works".

# Common mistakes

- Testing a handler directly when routing/middleware/auth changed.
- Testing against a different database/config than the booted app uses.
- Forgetting to restart the server after edits.
- Checking only the HTTP response when persistence changed.
- Checking only the UI text when state/store/cache changed.
- Running only success path; every runtime proof needs at least one failure path.
- Trusting cached/global/source-tree artifacts for packaging bugs.
- Leaving VERIFY-TEMP probes, fake data, or duplicate harnesses behind. Leaving one fresh harness, temp install, or test dataset for manual testing is fine when reported with cleanup.

# Evidence block

Use this shape in the final answer for runtime claims:

    VERIFIED - <behavior>
    rung: <2|3|4>
    command: <exact command or browser/device action>
    output: <decisive observed output, route, text, status, or screenshot reference>
    state: <store/cache/file/event query and result, or N/A with reason>
    failure: <bad input/error path and observed result>
    cleanup: <removed VERIFY-TEMP probes/temp data; URL/session/log; cleanup command; harness left running for manual testing or stopped>

    NOT VERIFIED: <gap or none>
    close with: <one command/manual script, or none>

# Strong example

For an endpoint that writes audit rows, this is sufficient shape:

    VERIFIED - POST /users creates a user and audit row
    rung: 3+4
    command: curl -s -X POST localhost:3000/users -H "Authorization: Bearer $TOK" -d '{"email":"a@b.c","name":"An"}'
    output: 201 {"id":"u_9f2","email":"a@b.c"}
    state: psql "$DB" -c "SELECT email,status FROM users WHERE id='u_9f2'" -> a@b.c | active; users count 4->5; audit_log +1
    failure: missing email -> 422 {"error":"email_required"}; users count unchanged at 5
    cleanup: removed VERIFY-TEMP probes; dev server left running for manual testing at localhost:3000; cleanup command: kill $(cat /tmp/users-api.pid); test user u_9f2 intentionally kept

If Docker/DB cannot be reached after SELF-RESCUE, the honest claim is:

    VERIFIED - endpoint unit/integration contract tests pass
    rung: 1/available tests only
    NOT VERIFIED: real HTTP route, auth middleware, and audit-row persistence; blocked on DB runtime
    close with: ./scripts/verify-users-endpoint.sh
