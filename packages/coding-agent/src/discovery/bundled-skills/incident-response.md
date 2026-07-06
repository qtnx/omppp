---
name: incident-response
description: MANDATORY the moment production is impacted — outage, "prod is down/broken", exploit, data corruption, fund loss, stuck transactions, severe degradation, or active user impact. Contains the strict priority order (contain → stop bleeding → preserve evidence → mitigate → monitor), the rollback decision tree, data-corruption specifics (stop writers FIRST), the do-not list, and the communication cadence.
---

# Incident Response

Production burning changes the rules: stabilization beats understanding. Root cause is a LATER activity. Do not orchestrate pipelines, do not refactor, do not architect during a fire — work solo, direct, and in this exact order.

## Priority order
1. **CONTAIN** — stop the blast radius from growing: disable the feature flag, block the abusive route/IP at the edge, pause the queue consumer, take the corrupting writer offline. Ask first: "what single switch stops this from getting worse?"
2. **STOP THE BLEEDING** — restore service to users by the fastest safe path (usually rollback — decision tree below), even in degraded mode.
3. **PRESERVE EVIDENCE — BEFORE restarting anything.** Restarts destroy the crime scene:
   - copy logs of the window: `kubectl logs <pod> --previous > /tmp/incident/`, journal exports, app log files;
   - capture state: process list, memory/heap dump if feasible, `SELECT` snapshots of affected rows, queue depths, the offending payloads/requests;
   - note the timeline as you go: first alert time, deploys/config changes in the prior 24h (`git log --since`, deploy history), what you touched and when. Two minutes of copying now saves a week of "could not reproduce" later.
4. **MITIGATE** — rollback / flag off / hotfix / drain, per the tree below.
5. **MONITOR** — watch the recovery signal (the RED metrics, the error rate) until stable, not until "seems fine".
6. **RCA LATER** — after stability: reproduce in a safe env, root-cause per skill://bug-hunting, and the REAL fix ships through normal lanes with full verification. The hotfix was a tourniquet, not the treatment.

## Rollback decision tree
- Deploy/config change in the incident window? → ROLLBACK FIRST, debug later. Correlation is enough during a fire; you don't need the mechanism to justify reverting the trigger.
- Rollback blocked by a schema migration? → roll code back to the last version compatible with the current schema (this is why expand→contract exists — skill://migration-upgrade); never roll back the schema under load without a verified plan.
- No recent change (dependency outage, traffic spike, data-triggered)? → flag off the affected path / shed load / scale, and stub the failing dependency's boundary if a degraded mode exists.
- Hotfix ONLY when no switch exists: minimal diff, still runs the entry-point probe (skill://verify-before-done rung 3 at minimum) before deploy — an unverified hotfix is a second incident.

## Data corruption specifics
1. STOP THE WRITERS FIRST — every second of continued writes widens the damage and contaminates backups.
2. Snapshot the affected tables NOW (`CREATE TABLE x_incident_YYYYMMDD AS SELECT ...` / dump) — even corrupt state is evidence and a diff base.
3. Determine the corruption window (first bad write ← logs/audit) before repairing anything.
4. Repair via an idempotent, dry-run-first script (skill://database-craft ritual) against the snapshot's diff; reconcile counts; only then re-enable writers.

## Do-NOT list
- Do NOT restart services before evidence is captured.
- Do NOT push speculative fixes ("maybe this helps") — every unverified change is a new variable in a system you don't understand yet.
- Do NOT fix multiple things at once — you won't know which one worked.
- Do NOT clean up, refactor, or upgrade anything mid-incident.
- Do NOT let the hotfix become the permanent fix by silence — it goes on the RCA list.

## Communication cadence
At every state change (and at least every major step), report three lines: **KNOWN** (symptoms, scope, since when), **DONE/DOING** (actions taken, current action), **NEXT** (the next step + what would change the plan). Never claim recovery without the monitored signal stable — "looks fine" is banned during incidents too.

## Closeout
Stability confirmed → hand over: timeline, evidence locations, mitigation applied, residual risk, and the RCA/real-fix task list. The incident isn't over until the tourniquet has a replacement scheduled.
