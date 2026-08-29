---
name: archify
description: Use when presenting architecture visually or spatially, mapping components, services, stores, deployment or trust boundaries, protocols, owners, workflows, sequences, data flows, or lifecycles; make the guidance mandatory whenever an architecture view is requested.
license: MIT
---

# Archify — Truthful Architecture Presentation

Use this skill whenever architecture must be communicated as a visual or spatial
artifact. It adapts the open-source [Archify](https://github.com/tt-a1i/archify)
skill (MIT) to OMPx's available artifact mechanisms. OMPx does not include
Archify's renderer, schemas, examples, CLI, or desktop runtime; never claim that
it does and never use its commands.

## Core principle

A diagram is a source-grounded communication artifact, not a guess about runtime
behavior. Every node, edge, boundary, owner, protocol, and store is supported by
repository evidence or by an explicitly marked inference. Preserve uncertainty
instead of filling gaps with plausible topology.

## Bounded authoring flow

1. **State purpose and audience.** Name the decision or explanation the view
   supports, its audience, and the scope. Prefer one review question per artifact.
2. **Choose one type.** Use the type router below; if the question spans types,
   make separate focused views rather than one crowded map.
3. **Inventory verified facts.** Gather only the nodes, edges, boundaries,
   protocols, owners, and stores needed for the question. Record the evidence
   location or mark each unsupported inference as `INFERENCE — verify <owner>`.
4. **Select the main path.** Make one primary flow obvious. Keep side branches
   few and attach them to the nearest main-path node; move supporting detail into
   cards or prose instead of adding crossing edges.
5. **Choose an available OMPx artifact.** Use a product-preview architecture
   canvas (`.canvas.json`) for spatial review, Mermaid when a text diagram is
   sufficient, or one self-contained HTML mockup when custom interaction/layout
   is the actual question. Follow the selected mechanism's schema and safety
   limits. Do not invent a new renderer or artifact protocol.
6. **Validate before handoff.** Run the factual, readability, and containment
   checks below against the artifact and its source evidence. Repair the facts or
   layout; do not hide errors by clipping, overflow, or decorative noise.
7. **Present.** Hand off the artifact path and type, the scope, evidence boundary,
   marked inferences, and any unresolved validation item. Never call an
   unverified rendering or runtime result successful.

## Type router

| Type | Use for | Show first |
|---|---|---|
| `architecture` | Components, services, infrastructure, cloud/security or deployment boundaries | Containers and one primary relationship path |
| `workflow` | CI/CD, approvals, tool calls, runbooks, operational processes | Ordered steps, decisions, and exceptions |
| `sequence` | API calls, auth, cache fallback, async traces, request lifecycles | Participants, messages, returns, and timing |
| `dataflow` | Pipelines, ETL/ELT, lineage, PII movement, consumers | Sources, transforms, stores, and sensitivity boundaries |
| `lifecycle` | Status/state transitions, waits, retries, cancellation, terminal outcomes | States, events, retry paths, and terminal states |

Do not silently convert a request into a different type. When ambiguous, explain
which type best matches the audience's question and why.

## What an architecture view must make factual

- **Components:** name only real services, modules, clients, workers, or external
  systems in scope; preserve exact product and code identifiers.
- **Deployment and trust boundaries:** show regions, clusters, runtime or network
  boundaries, and security/tenant boundaries only when evidenced. Label every
  crossing and do not imply isolation that is not present.
- **Protocols:** label meaningful edges with the real transport, API, event, or
  storage interaction; distinguish synchronous from asynchronous behavior when
  known.
- **Owners:** identify the team or module responsible for each load-bearing
  component, protocol, and store when that ownership is known. Mark unknown
  ownership instead of assigning it by convention.
- **Stores:** distinguish authoritative stores, caches, queues, and derived data;
  show who writes and what relationship is supported by evidence.
- **Relationships:** an edge means an authored relationship, not merely that two
  things could communicate. Never claim runtime reachability, latency, security,
  delivery, or failure behavior unless the source supports it.

For any unsupported statement, use a visible marker such as
`INFERENCE — verify deployment owner` or `UNVERIFIED — source missing`; include
what would verify it. Never disguise an inference as a solid node or edge.

## Composition rules

- Keep the artifact bounded: one question, one main path, sparse labels, and only
  the nodes that change the reader's decision.
- Place actors and external systems at the boundary; keep internal containers and
  stores grouped by their real ownership or trust boundary.
- Use direction and grouping to communicate hierarchy, not a tangle of arrows.
- Keep labels short but preserve protocol, action, direction, and sync/async
  meaning. Delete only labels that are fully implied by both endpoints.
- Avoid edge crossings over unrelated nodes, ambiguous shared corridors, and
  labels that mask other routes.
- Do not use color, icons, badges, or visual polish to imply facts absent from the
  evidence. Legend entries must explain semantics, not decorate the map.
- Use readable spacing and responsive containment. Do not shrink text until it is
  unreadable, stretch the diagram, clip content, or add a nested scroller to force
  a pass.
- A spatial canvas is a review companion, not a replacement for the architecture
  decision record. Keep rationale, evidence, and unresolved risks in prose when
  the canvas cannot carry them clearly.

## Available OMPx artifact mechanisms

### Product-preview architecture canvas

Use the version-1 product-preview canvas contract when pan/zoom inspection,
spatial hierarchy, or topology review is valuable:

- `version: 1`, `artifactType: "architecture"`.
- Use `group`/`card` nodes for containers and capabilities, `actor` nodes for
  callers, and `decision` nodes for important choices or risks.
- Use only `association`, `dependency`, and `sequence` edges as their meanings
  require. Every endpoint and parent must reference an existing node.
- Positions are all-or-none; omit them to use deterministic client layout unless
  deliberate placement is necessary. Keep IDs unique and refs relative and safe.
- Keep node titles and bodies concise; put long evidence in the source document,
  not in a card.

### Mermaid

Use Mermaid for a readable text-first view. Prefer one `C4Context` or
`C4Container` for context/containers and a `sequenceDiagram` for each load-bearing
flow. Include at least one designed failure branch for a risky flow. Render or
preview Mermaid through an available OMPx product-preview path when one exists;
otherwise present the Mermaid source honestly as a text diagram. Do not claim
that Mermaid was parsed or rendered if it was not.

### Self-contained HTML

Use HTML only when custom interaction or layout fidelity is the question. Keep it
one file with inline CSS/JS and no external fonts, scripts, images, fetches, or
bridge tags. Use only the product-preview bridge exposed by OMPx, if available;
do not invent `postMessage` or other parent APIs. For a plain architecture map,
prefer a canvas or Mermaid instead.

## Validation before presentation

### Factual validation

- [ ] Purpose, audience, scope, and selected type are explicit.
- [ ] Every node and edge has repository/spec evidence or a visible `INFERENCE` /
      `UNVERIFIED` marker with a verification owner or source needed.
- [ ] Components, stores, owners, protocols, and deployment/trust boundaries are
      present where relevant, and absent claims are not implied by styling.
- [ ] The main path is the one the evidence supports; side branches and failure
      behavior are not invented.
- [ ] No edge claims runtime impact, authorization, availability, delivery,
      latency, or ownership beyond the evidence.
- [ ] Artifact refs, if any, use existing relative paths and do not expose unsafe
      absolute paths or URLs in the canvas contract.

### Readability and containment validation

- [ ] One main path is visually obvious at normal viewing size.
- [ ] Labels remain legible, distinct, and semantically complete.
- [ ] No unrelated-node crossings, hidden labels, clipped nodes, or accidental
      boundary crossings obscure the relationships.
- [ ] The artifact remains contained at its intended desktop and narrow widths;
      no overflow, stretched SVG, tiny text, or internal scroll workaround is
      used to counterfeit readability.
- [ ] Reduced-motion and keyboard behavior are respected when the chosen artifact
      has interaction; static artifacts make no unsupported interaction claim.
- [ ] The handoff names the artifact path/type, evidence boundary, inferences, and
      any unresolved check instead of saying only “diagram ready.”

## Common mistakes

| Mistake | Correction |
|---|---|
| Inventing a service, edge, owner, or trust boundary to make the picture complete | Mark it `INFERENCE` with the missing evidence and owner |
| Mixing architecture, sequence, and lifecycle into one overloaded view | Route each question to one type and split the views |
| Treating a possible communication path as observed runtime behavior | Draw only authored relationships and state the evidence boundary |
| Adding detail until the main path disappears | Remove low-value nodes/edges; keep detail in cards or prose |
| Reusing Archify CLI commands, schemas, renderer, or desktop loop | Use only OMPx canvas, Mermaid, or self-contained HTML mechanisms actually available |
| Calling a canvas or Mermaid parse “validated” without running the available check | Name the check performed, or report that validation remains pending |
| Hiding overflow with CSS or a nested diagram scroller | Repair content and spacing; containment must remain truthful |

## Attribution

Adapted from Archify, MIT License. Source note: Archify © 2026 tt-a1i (Archify) and © 2025 Cocoon AI.
https://github.com/tt-a1i/archify
