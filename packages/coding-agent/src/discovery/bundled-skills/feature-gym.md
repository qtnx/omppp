---
name: feature-gym
description: Use when a feature cannot be exercised directly and a test rig must be imagined and built first — complex UI with many effects or service calls, microservice endpoints, cross-service flows, workers, or data changes.
---

# Feature Gym

A Feature Gym is the exercise rig you build for one feature. Before implementing, answer: "when this feature is done, what exact action shows it working, and what must exist for me to take that action?" Everything missing from that answer — sandbox page, scenario driver, fake service layer, seeded store, running dependency — is Gym work you own and build. The EXECUTION HARNESS supplies the proof rungs inside the rig.

## When to Use

- Pure logic, isolated tests, non-mutating one-command probes → no Gym.
- Feature has no direct way to be driven and observed → imagine the rig, then build it. NEVER stop because "there is no way to test this".
- A faithful rig already exists → invoke or parameterize it; do not duplicate.

## Build the Rig per Surface

| Feature surface | Rig to build |
|---|---|
| Complex FE (effects, many service calls) | sandbox route/story/harness page rendering the REAL component with a controllable service layer (MSW/fakes/DI stubs); switches for loading, empty, error, slow, and success data; drive it in a real browser |
| Backend endpoint / microservice | boot the real service with its own store (matched engine, migrations, seeds); contract fakes only at OTHER services' boundaries; scripted scenario driver (curl/script) for success + failure; state inspection queries |
| Cross-service flow / worker / queue | message injector at the real entry point; real broker semantics when implicated; state inspector on the owning store |
| CLI / TUI | built artifact in a clean prefix; scripted inputs; transcript, exit-code, and written-state assertions |
| Data / migration | disposable engine + snapshot fixture; run the migration; count/checksum comparison script |

Reproduce boundaries that can change the result; fake only what the feature does not exercise, and name every fake in the claim. An in-memory substitute cannot prove an engine- or broker-specific path.

## Rules

- The rig is repository-owned and reusable: harness pages, drivers, fixtures, and setup scripts are deliverables, not scratch.
- Idempotent and run-scoped: parameterize ports, databases, and IDs; safe to rerun after success, failure, or interruption.
- Real ingress: drive the feature through its actual surface (browser action, HTTP request, message, CLI invocation), never by calling internals and claiming the surface works.
- NEVER exercise against shared developer state, production services, ambient credentials, or inherited secrets.
- Tear down owned runtime state after the run; keep the reusable rig artifacts.

## Evidence and Claims

Record the rig artifact/command, driven action, observed output, inspected state, fakes/substitutions, and teardown. Sanitize secrets, cookies, PII, and payloads.

Claim end-to-end only when every result-relevant boundary was real; otherwise name the exact gap.

## Common Mistakes

| Mistake | Correction |
|---|---|
| "No way to test this" → stop | Imagining and building the rig IS the task. |
| Unit-testing hooks/handlers only for a complex feature | Render/boot the real thing and drive its surface. |
| Faking the boundary under test | Fake only boundaries the feature does not exercise. |
| One-off manual setup | Capture the rig as a reusable script/page/fixture. |
| Shared dev stack or production data | Own, disposable, synthetic. |
| Isolation alone called a Gym | The Gym is the rig that lets the feature be driven. |
