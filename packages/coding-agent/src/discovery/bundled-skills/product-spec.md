---
name: product-spec
description: Use when a chosen product direction needs a written contract — PRD, product spec, requirements doc, user stories, acceptance criteria, edge-case/state enumeration, now-vs-later scoping, cut-lines, or success metrics for a feature — before implementation planning begins.
---

# Product Spec

The spec is the contract between product intent and engineering execution. A spec that describes only the happy path specifies about one third of the product: the other two thirds are states (empty/error/permission/concurrent), scope boundaries, and the definition of success. Downstream planning inherits every ambiguity you leave — numbers over adjectives, tables over prose.

## Preconditions

- A direction was chosen: user-approved from skill://product-ideation, or a genuinely constrained space with a validated brief (skill://product-discovery). Direction still ambiguous → back to ideation, not a vaguer spec.

## Step 1 — frame

- Problem summary: compress the brief to 3-4 lines (link/embed the full brief).
- Chosen direction + why: one paragraph, citing the scorecard rationale.
- Non-goals: from the brief PLUS every declined ideation option — the spec's fence against scope creep.

## Step 2 — users & stories with acceptance criteria

- Story form: "As [persona], when [trigger], I can [capability], so that [outcome]."
- Every story carries testable acceptance criteria (Given/When/Then or a checklist).
- Criteria MUST be externally observable — a QA engineer could verify without reading source. BANNED as criteria: "works correctly", "is fast", "user-friendly", "intuitive". Use numbers and observable behaviors: "list of 10k rows renders first page < 1s", "duplicate submit returns the original receipt, creates no second charge".

## Step 3 — journey & state enumeration

This is the two thirds freshers skip. Walk the journey — entry → first use → habitual use → edge → exit — and for EVERY screen/step/interaction enumerate:

- EMPTY — first run, no data yet, everything deleted.
- LOADING — slow dependency, partial data.
- ERROR — per failure class: validation, permission, network/dependency down, conflict.
- SUCCESS — including the "what now" next action.
- PARTIAL — mid-flow abandon, retry, refresh, back button, duplicate submit.

Cross-cutting sweeps (each is a table or an explicit N/A with reason):

- PERMISSIONS — role × action matrix, per OBJECT where relevant (owner vs member vs anonymous).
- I18N/LOCALE — text expansion, RTL, date/number/currency formats.
- ABUSE/MISUSE — spam, injection-shaped input, rate limits, incentive gaming.
- CONCURRENCY — two tabs, two users on one object, stale-data writes.
- PLAN/PRICING GATES — free-vs-paid limits, mid-use upgrade/downgrade, quota exhaustion.
- DATA LIFECYCLE — export, deletion, retention, account close.

Each enumerated state gets DESIGNED behavior + copy direction ("show error" is not designed; "inline error under field: 'Email already registered — sign in instead?' with sign-in link" is). "Won't handle" is legal ONLY as a named limitation with a reason.

## Step 4 — scope & sequencing (cut-lines)

- Slice the direction into executable vertical slices — each user-visible and independently verifiable.
- RICE-lite per slice: Reach × Impact vs Effort → order by leverage, then dependency.
- Cut-lines table: NOW (this delivery) / NEXT (with the named trigger that starts it) / NOT (declined + why).
- Sequencing is ORDERING, never delivery tiers: every NOW slice ships at full production grade. NEVER write "MVP", "phase 1 (basic version)", or a slice whose definition is "like slice 2 but worse".

## Step 5 — success metrics & guardrails

- Hypothesis: "Shipping [capability] to [segment] moves [metric] by [expected direction/size] because [mechanism]."
- PRIMARY metric = the brief's success signal, made precise (exact event/query, time window).
- GUARDRAILS — what must NOT degrade: latency, error rate, support volume, adjacent-feature usage.
- KILL/ITERATE criteria carried over from the ideation premortem.
- Instrumentation plan: the named events at named journey points that make the metrics computable — implementation per skill://observability-instrumentation. A metric with no event mapping is decoration.

## Step 6 — open questions & risks

- Each open question: owner + proposed default + the date/trigger it must resolve by.
- Each risk: impact one-liner + mitigation owner.

## Expected output — the spec artifact

Save to `docs/product/specs/YYYY-MM-DD-<topic>.md` (kebab-case topic; user preference for location overrides). This path is the CONTRACT: downstream design, planning, and implementation (skill://product-design for UI surfaces, skill://feature-anatomy, plan agents, skill://writing-plans where available) read product specs from here.

```markdown
# <Topic> — Product Spec (<YYYY-MM-DD>)

## Problem (from brief)          <- Step 1
## Direction & why               <- Step 1
## Non-goals                     <- Step 1
## Stories & acceptance criteria <- Step 2
## Journey & states              <- Step 3 (tables per screen/step + cross-cutting sweeps)
## Scope & cut-lines             <- Step 4 (NOW / NEXT / NOT table)
## Metrics & guardrails          <- Step 5 (hypothesis, primary, guardrails, kill criteria, event map)
## Open questions & risks        <- Step 6
```

## Canvas companion (optional, spatial only)

When the journey, story backbone, or cut-line hierarchy is easier to review as a spatial map than as tables alone, ALSO emit a review-only canvas companion:

- Path: `docs/product/canvases/<topic>-spec.canvas.json` (exact `.canvas.json` suffix).
- `artifactType`: `spec` for capability/AC hierarchy; `story-map` when activities × stories are the review focus; `journey-map` when phase × swimlane states dominate.
- Schema, limits, safe `refs`, and recipes: skill://preview-templates (or delegate `$agent:presenter`).
- Markdown remains the prose contract. Canvas MUST NOT replace the `.md` spec.
- Prose-only specs with no spatial structure? SKIP the canvas — NEVER invent a mandatory duplicate.

Refs in canvas nodes SHOULD point at this spec path + section anchors so reviewers jump back to acceptance criteria.

## Self-check rubric — run BEFORE presenting, fix inline

- Zero inline TBD/TODO — unknowns live in Open Questions with owner + default.
- Every story has ≥1 failure-class state enumerated (validation + permission minimum).
- Permissions matrix present when >1 role or per-object access exists.
- Every acceptance criterion passes the observability test (QA could verify black-box).
- Primary metric + ≥1 guardrail defined; every metric maps to a named event.
- Non-goals section is non-empty (empty = scope not thought through).
- No requirement readable two ways — replace adjectives with numbers.
- Tables agree with each other: states ↔ stories ↔ cut-lines contain no contradictions.

Then: present to the user for review and incorporate feedback. Spec has a UI surface → skill://product-design next (wireframes before any planning or code). New service, store, queue, external integration, or NFR jump → skill://product-architecture before planning. Otherwise hand off to planning/implementation directly.

## Fresher traps

Happy-path spec; adjectives as requirements; acceptance criteria that restate the story ("user can export" → "verify user can export"); states listed but behavior undefined; metrics section as decoration (no event mapping, no query); spec as essay — walls of prose where tables belong; silent scope shrink between spec and plan; skipping user review because the spec "looks complete".
