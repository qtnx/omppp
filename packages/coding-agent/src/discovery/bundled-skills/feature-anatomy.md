---
name: feature-anatomy
description: MANDATORY when implementing any new feature, endpoint, page, screen, command, or capability in an existing codebase. Use BEFORE writing the first line — this skill contains the mirror-the-newest-feature method, the full wiring checklist (registration, DI, flags, migrations, i18n, permissions — the pieces that make features "compile but unreachable"), the contract-first state enumeration, and the end-to-end reachability requirement.
---

# Feature Anatomy

A feature is not the happy-path function. It is the FULL anatomy the codebase's existing features have — and the most common failure is shipping something that compiles but is unreachable because one wiring line is missing.

## Step 1 — find the template: the newest similar feature
Don't invent a shape; mirror the team's freshest one:
- `git log --oneline --diff-filter=A -- src/routes src/features | head -20` → recently added feature files.
- Grep the registration point (router file, module index, command registry) for the most recent entry; open EVERY file that feature touches. That set of files IS your checklist for this feature.
- Two competing patterns in the repo → follow the newest-blessed/dominant one; genuinely split → ask which is canonical (interview trigger). NEVER add pattern #3.

## Step 2 — contract first, states enumerated
Before implementation, lock:
- Types / API shape (request, response, error shape — matching the repo's error envelope).
- The full state set, up front: **loading, empty, error, unauthorized/forbidden, boundary inputs** (0 items, 1 item, max, unicode, huge). A feature IS its error paths — an endpoint that 500s on bad input is not done.
- Which existing invariants the feature must not break (authz model, tenancy, audit trail).

## Step 3 — the wiring checklist
Walk EVERY item; mark each "done" or "N/A because the repo's pattern has no such piece":
1. Entry registration — route mounted / command registered / handler subscribed / cron scheduled.
2. DI / container binding — the service actually constructed and injected.
3. Validation at the edge — schema for the input, mapped to the standard 4xx shape.
4. AuthN + AuthZ — permission check per the repo's model, PER OBJECT where relevant (not just "logged in").
5. Data layer — migration written AND run in the harness; indexes for the new query patterns.
6. Events/side effects — emitted per the repo's pattern (outbox, bus) if features here do that.
7. Feature flag — registered, default documented; flag-off path also verified.
8. Config — new vars added to `.env.example` and config schema.
9. i18n — user-facing strings through the repo's i18n system, never hardcoded.
10. Barrel/exports — added to index files if the repo uses them.
11. Tests — per the mirrored feature's test anatomy (unit + the integration level the template has).
12. Telemetry — the log/metric the repo's features emit (see skill://observability-instrumentation).
13. Docs/changelog — in the cleanup phase, per the repo's convention.
Any item silently skipped = the classic "compiles but unreachable" or "works but invisible" failure.

## Step 4 — prove reachability end to end
Per skill://verify-before-done: exercise the USER-reachable path once on the real surface (real HTTP through the router with real auth / real click flow in the browser / real command), assert response fields AND persisted state, then two failure paths (bad input → designed 4xx + store unchanged; bad auth → 401/403).

## Scope discipline
Implement the FULL requested scope (production stance: no MVP, no "phase 1 then stop"). Ideas beyond scope — the adjacent refactor, the extra endpoint — go to `Noticed:`, never silently built.

## Fresher traps
Happy path only; parallel structure #3 beside two existing patterns; the missing registration line; hardcoded strings/config; migration written but never run; flag added but default leaves the feature dark with no note; optimistic UI called "verified" without checking the round trip.
