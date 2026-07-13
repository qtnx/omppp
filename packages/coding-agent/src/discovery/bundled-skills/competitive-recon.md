---
name: competitive-recon
description: Use when positioning or differentiation questions arise — "how do competitors/others solve this", market or competitor teardown, alternatives analysis, table-stakes vs differentiators, pricing/packaging references, or validating that a proposed product direction is differentiated.
---

# Competitive Recon

You are never the first to face a job-to-be-done. Recon steals the market's lessons at zero R&D cost — what users already assume (table stakes), what they already hate (your opening), and where being different actually pays. Recon that doesn't feed a decision is procrastination with tabs open.

## Step 0 — name the decision

Before gathering anything, write one line: "This recon informs <decision>" — direction choice (feeds skill://product-ideation's differentiation axis), state enumeration (feeds skill://product-spec table stakes), pricing/packaging, or a differentiation claim someone wants validated. No nameable decision → stop, no recon.

Scope: 3-5 alternatives MAX. The alternative set MUST include the non-obvious competitors: the incumbent tool users already pay for, the spreadsheet/manual process, and "do nothing". The spreadsheet frequently owns the market.

## Step 1 — gather

WITH web access (web_search / read):

- PRIMARY: official docs, changelogs, pricing pages — what the product actually does today.
- FLOWS: docs/screenshots of the real steps, not marketing claims. Feature EXISTS ≠ feature is GOOD.
- COMPLAINTS: reviews, forums, HN/Reddit threads — gold; unmet needs stated by real users, ready-made edge cases for your spec.
- VELOCITY: public roadmaps/release notes — where they're heading and how fast.
- Cross-check any load-bearing claim across 2 sources; comparison articles are secondary sources with affiliate bias.

DEGRADED MODE (no web access): NEVER present training-memory as current market fact — it is stale and hallucination-prone. Instead: (a) label any memory-based claim "as of training data, unverified"; (b) ask the user a structured batch: which alternatives do your users come from or mention? what do they praise/complain about? any sales/support comparison notes? (c) mine the repo — integration adapters, "import from X" features, and migration docs name the real competitors.

## Step 2 — teardown per alternative

One table row each:

- JTBD COVERAGE — which jobs from the brief it solves and HOW (mechanism, not marketing adjective).
- FLOW FRICTION — count the steps to complete the core job. Counted steps are comparable; "easy to use" is not.
- MODEL — pricing, packaging, limits, gates.
- STEAL — strengths worth copying (the pattern, not the pixels).
- EXPLOIT — weaknesses with user complaints as evidence.
- EVIDENCE — source link + grade: `verified` (saw docs/product), `reported` (review/article), `assumed` (inference/memory).

## Step 3 — synthesize

- TABLE STAKES — what EVERY alternative has. Users assume it; its absence in your product is a DEFECT, not a scope cut. Feeds skill://product-spec as hard requirements.
- DIFFERENTIATION CANDIDATES — gaps nobody covers + complaints nobody fixes. For each, answer WHY it is open: hard? unprofitable? overlooked? "Overlooked" is rare — assume hard until evidence says otherwise.
- DELIBERATE SAMENESS — where to copy the market standard on purpose: UX conventions users already know are free onboarding; differentiating on them is a tax.

## Expected output — Recon Memo

```markdown
## Recon Memo — <topic>

**Decision this informs**: <one line>

| Alternative | JTBD coverage | Flow friction | Model | Steal | Exploit | Evidence |
|-------------|---------------|---------------|-------|-------|---------|----------|
| <incl. spreadsheet / do-nothing> | ... | <N steps> | ... | ... | ... | <link> [verified|reported|assumed] |

**Table stakes** (→ spec requirements): <list>
**Differentiation angle** (1-2 max): <angle + why this gap is open + what makes it defensible>
**Deliberately same**: <conventions to copy>
**Sources**: <links / "degraded mode: user-reported">
```

## Self-check rubric — before presenting

- The informed decision is named; every section feeds it.
- Alternative set includes the incumbent AND the manual/do-nothing path.
- Every claim carries an evidence grade; zero unlabeled memory-facts.
- Each differentiation candidate has a why-is-this-open answer.
- Flow friction is counted, not adjectived.

## Fresher traps

Marketing-page recon (claims ≠ quality); tearing down 10 competitors when no decision needs them; differentiating on table stakes; copying a competitor's flow without their context (their constraints are not yours); training-memory presented as current fact; ignoring the spreadsheet that actually owns the market; recon memo with no decision attached.
