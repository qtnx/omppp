---
name: feature-anatomy
description: MANDATORY for new capabilities in existing code. Mirrors the newest feature, identifies full reachability, and drives one executable vertical slice at a time; the anatomy checklist never becomes a serial Foundation program.
---

# Feature Anatomy

A feature is not the happy-path function. It is the FULL anatomy the codebase's existing features have — and the most common failure is shipping something that compiles but is unreachable because one wiring line is missing.

## Step 1 — find the template: the newest similar feature
Don't invent a shape; mirror the team's freshest one:
- `git log --oneline --diff-filter=A -- src/routes src/features | head -20` → recently added feature files.
- Map the newest feature's files as a checklist, but read only the files needed by the CURRENT vertical slice before coding. Later wiring stays in its owning slice.
- Two competing patterns in the repo → follow the newest-blessed/dominant one; genuinely split → ask which is canonical (interview trigger). NEVER add pattern #3.

## Step 2 — contract first, states enumerated
Before the current vertical slice:
- Lock only the public/shared shape that its production owner needs.
- Enumerate states owned by this slice: success plus reachable empty/error/unauthorized/boundary cases.
- Preserve invariants directly touched by this slice. Unrelated future invariants remain later-phase work.

## Step 3 — the wiring checklist
Walk applicable items inside the SAME full-cycle feature owner; mark each done or N/A. NEVER split checklist rows into prerequisite Foundation packages unless a real runtime dependency requires it:
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
Skipped applicable wiring is a defect; N/A or later-slice items are not blockers for the current executable slice.

## Step 4 — prove reachability end to end
Per skill://verify-before-done: exercise the USER-reachable path once on the real surface (real HTTP through the router with real auth / real click flow in the browser / real command), assert response fields AND persisted state, then two failure paths (bad input → designed 4xx + store unchanged; bad auth → 401/403).

## Scope discipline
Implement the FULL requested scope through back-to-back executable vertical slices. This is sequencing, not MVP delivery: each slice runs before the next, and no phase stops at contracts/tests/scaffolding alone. Ideas beyond scope go to `Noticed:`.

## Fresher traps
Happy path only; parallel structure #3 beside two existing patterns; the missing registration line; hardcoded strings/config; migration written but never run; flag added but default leaves the feature dark with no note; optimistic UI called "verified" without checking the round trip.
