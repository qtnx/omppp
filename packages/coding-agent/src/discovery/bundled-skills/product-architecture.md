---
name: product-architecture
description: Use when a validated spec or design needs system architecture before implementation planning — system design, C4 context/container diagrams, technology and stack choices, data model and ownership, scale/NFR envelope, build-vs-buy, integration topology, or reviewing a proposed architecture. Not needed when the change fits the existing architecture without a new service, store, or boundary.
---

# Product Architecture

Architecture is the set of decisions that are expensive to reverse: boundaries, stores, protocols, and the couplings between them. Everything else is implementation detail that refactoring fixes cheaply. Act as the CTO across every technical domain — frontend, backend, data, infra, security, cost — and spend design effort ONLY on the expensive-to-reverse set. The most common failure is not a wrong diagram; it is solving an imagined scale while missing a real constraint.

## Routing

- Runs AFTER skill://product-spec (and skill://product-design when there is UI), BEFORE implementation planning (skill://writing-plans, wave planning, skill://parallel-fanout).
- SKIP when the work fits the existing architecture: no new service, store, queue, external integration, tenancy change, or NFR jump — then follow the repo's existing patterns (skill://codebase-recon) and go straight to planning. Producing a C4 diagram for a CRUD endpoint is theater.
- REVISIT (not full redo) when a new integration, a named NFR change, or a scale jump invalidates a recorded decision — amend the affected ADR, not the whole document.

## Inputs

The spec's stories/states/metrics, the design doc when UI exists, constraints from the brief (compliance, budget, team size/skills, deadline), and the CURRENT system: in a brownfield repo the existing architecture is a constraint, not a suggestion — map what exists before drawing what should exist.

## Step 1 — system context (C4 level 1)

One mermaid `C4Context`: the system, its human actors, every external system it talks to. If an external dependency appears here that the spec never mentioned, the spec has a gap — go fix the spec first.

## Step 2 — containers (C4 level 2)

One mermaid `C4Container`: deployable units, stores, queues, and the protocols between them.

- FEWEST MOVING PARTS rule: start from one deployable + one store; every additional container MUST be justified by a NAMED constraint (isolation, scale, team ownership, compliance) written next to it. "We might need it later" is not a constraint.
- Monolith-first is the default; a split earns its place only when the NFR envelope or a compliance boundary demands it.
- Every container names its owner store and its authz boundary. A container with no clear data ownership is a distributed-monolith seed.
- Every protocol edge between containers (and every public surface) gets a contract-first shape per skill://api-design: ONE error envelope repo-wide, pagination per its rules (cursor for growing/unstable lists; offset only as a named exception), `Idempotency-Key` on effectful POSTs, compatibility laws stated. Locking the contract here is what lets implementation fan out in parallel.

## Step 3 — critical flows (sequence diagrams)

One mermaid `sequenceDiagram` per load-bearing or risky flow — auth, money movement, primary write path, the flow with the tightest latency budget. Each MUST include at least one failure branch (timeout, retry, partial failure) showing the designed behavior: what retries, what compensates, what surfaces to the user. A sequence diagram with only the happy path is a brochure.

## Step 4 — data model & ownership

- Entities, relationships, and for EACH: the single source of truth, who may write it, retention/deletion rules.
- Brownfield: the migration path from the current schema per skill://migration-upgrade (expand → backfill → contract); an architecture that requires a big-bang migration is a defect.
- Name what is cached vs authoritative; every cache names its invalidation trigger.

## Step 5 — NFR envelope (numbers, not adjectives)

State the envelope the design must satisfy, each with an evidence grade (`measured|reported|assumed`):

- SCALE — users, peak RPS, data volume growth/month.
- LATENCY — p95 budget for the critical flows from Step 3.
- AVAILABILITY — target and the blast radius of each container failing.
- COST — monthly ceiling; the top 2 cost drivers (per-request pricing, egress, storage growth) estimated.

Design to roughly 10x the `measured` numbers, NEVER to 1000x an `assumed` one. If every number is assumed, the architecture's first job is making one of them measurable.

## Step 6 — build vs buy

Per non-core capability (auth, payments, search, email, analytics): buy/adopt when it is not the product's differentiator and a boring, proven option exists; build when it IS the differentiator or the integration cost exceeds the build cost. Adopting a dependency = owning its maintenance (skill://dependency-doctor). Record the exit path for anything with lock-in.

## Step 7 — common-mistakes gate

Walk EVERY row; mark `mitigated (how)` or `N/A (why)`. An unmarked row blocks presentation:

| # | Mistake | Check |
|---|---------|-------|
| 1 | Premature microservices / distributed monolith | every split justified by a named constraint; shared-DB-across-services = one system pretending |
| 2 | Sync call chain where a queue belongs | chain of 3+ sync hops on a critical flow → break with async + designed failure mode |
| 3 | Unbounded queue / no backpressure | every queue names its overflow behavior + DLQ + consumer lag alarm |
| 4 | Missing idempotency on money/retry paths | every retried or at-least-once operation carries an idempotency key (skill://concurrency-correctness) |
| 5 | No rollback / migration path | schema + deploy both reversible; expand-contract planned (skill://migration-upgrade) |
| 6 | Single point of failure | each container's failure blast radius stated; the unacceptable ones get isolation/redundancy |
| 7 | Missing authz boundary | per-object authorization placed at a named layer; tenant isolation stated where multi-tenant (skill://security-review) |
| 8 | Cost blowup | per-request-priced dependencies and egress/storage growth estimated against the cost ceiling |
| 9 | Resume-driven technology | every non-boring choice beats the boring option on a NAMED requirement, not on novelty |
| 10 | No observability at boundaries | each container boundary emits the log/metric/trace needed to answer "which side is broken" (skill://observability-instrumentation) |
| 11 | Chatty inter-service calls / N+1 topology | critical-flow hop count stated; fan-out per user action bounded |
| 12 | Greenfield fantasy in a brownfield repo | design starts from the CURRENT system and names the incremental path to the target |

## Step 8 — ADR-lite records

One record per expensive-to-reverse decision (store choice, boundary split, protocol, vendor):

```markdown
### ADR-<n>: <decision>
**Context**: <the forcing constraint, 1-2 lines>
**Options**: <A — one-line + cost/risk> / <B — one-line + cost/risk> (>=2 REAL options; a strawman is not an option)
**Choice**: <option + the 2-3 sentence why, tied to the NFR envelope or a named constraint>
**Consequences**: <what gets harder, what we accept>
**Revisit when**: <observable trigger, e.g. "RPS > 500 sustained" or "second tenant tier ships">
```

## Expected output — architecture doc

Save to `docs/product/architecture/YYYY-MM-DD-<topic>.md` (user preference for location overrides). Downstream planning reads it from here alongside the spec.

```markdown
# <Topic> — Architecture (<YYYY-MM-DD>)

**Spec**: docs/product/specs/<date>-<topic>.md   **Design**: <link or N/A>
## Current system (brownfield map)   <- what exists today
## System context                    <- Step 1 (C4Context)
## Containers                        <- Step 2 (C4Container + per-container justification)
## Critical flows                    <- Step 3 (sequenceDiagram x N, failure branches)
## Data model & ownership            <- Step 4 (+ migration path)
## NFR envelope                      <- Step 5 (numbers + evidence grades)
## Build vs buy                      <- Step 6
## Mistakes gate                     <- Step 7 (all 12 rows marked)
## Decisions                         <- Step 8 (ADR-lite list)
## Open questions & risks            <- owner + default each
```

## Canvas companion (optional, spatial only)

When containers, actors, and critical-flow topology are clearer as a review canvas than as mermaid alone, ALSO emit:

- Path: `docs/product/canvases/<topic>-architecture.canvas.json`.
- `artifactType: "architecture"`.
- Groups/cards for containers; `actor` nodes; `decision` for ADRs; `dependency` / `sequence` / `association` edges for topology and load-bearing flows.
- Architecture Markdown + ADR list remain the decision record. Canvas is a spatial companion for review feedback, not a replacement ADR store.
- SKIP for tiny brownfield tweaks with no new boundary graph worth mapping.

Schema/limits/safe refs/recipes: skill://preview-templates (or `$agent:presenter`). Refs SHOULD target this architecture doc and related specs.

## Present & refine

Present the doc and STOP for approval before implementation planning. Render diagrams where the user can actually read them: the product preview webUI when available (mermaid + C4 render in the browser; feedback arrives via the annotate overlay and side-ask), otherwise mermaid blocks in the terminal. Walk the user through: context → containers → the riskiest flow → the ADRs. Batch open questions (max 4, each with your recommended default). Fold feedback into the SAME doc; amend ADRs rather than appending contradicting prose.

## Self-check rubric — before presenting

- Every container carries a written justification; zero "might need it later" splits.
- Every critical flow has >=1 failure branch with designed behavior.
- Every entity has exactly one source of truth and a named writer.
- NFR envelope is numbers with evidence grades; no "fast/scalable/highly available" adjectives.
- All 12 mistakes-gate rows marked `mitigated` or `N/A` with substance.
- Every ADR has >=2 real options and an observable revisit trigger.
- Every mermaid block parses (render it once before presenting).
- Brownfield: the doc starts from the current system and shows the incremental path.

## Fresher traps

Designing for imagined 1000x scale while the real constraint is a 2-person team; diagram theater (beautiful C4, zero decisions); resume-driven stack choices; ADRs with one real option and a strawman; skipping the current-system map in a brownfield repo; big-bang migration as step 1; "we'll add auth/observability later"; treating the cloud bill as someone else's problem; presenting 40 pages when the decisions fit in 6.
