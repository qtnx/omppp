---
name: product-discovery
description: MANDATORY when a new product/feature idea, feature request, "can we build X", or product brainstorm arrives and the underlying problem is not yet validated — BEFORE choosing a solution or loading implementation skills such as feature-anatomy. User demand alone ("users keep asking for X") is NOT validation. Also use when a request is solution-shaped, scope is vague, or the user asks "is this worth building".
---

# Product Discovery

Users bring solutions, not problems. A feature request is a hypothesis wearing a spec's clothes: "add X" encodes an unvalidated belief that X fixes a pain worth fixing. Senior product engineers validate the problem before pricing any solution — the most expensive failure in product work is building the wrong thing well.

## Routing — when this skill wins

- This skill runs BEFORE skill://feature-anatomy, design, planning, or any implementation skill. Feature-anatomy owns HOW to build; discovery owns WHETHER and WHAT. When both seem to apply, discovery goes first.
- SKIP discovery when: the problem is already validated (an existing problem brief or spec covers it, or the user demonstrates evidence), the request is a bug fix / refactor / mechanical change, or the user explicitly says the problem is validated — then proceed to skill://product-ideation or implementation.
- Timebox: discovery is MINUTES of structured extraction, never a research program. One pass through the steps, one batched question round maximum, then output the brief.

## Step 1 — de-solution the request

- Extract the embedded solution and set it aside verbatim. It is NEVER discarded: it enters skill://product-ideation as candidate #1.
- Walk 5-whys from the request toward an outcome someone pays for: "add CSV export" → why? → "get data into Excel" → why? → "build monthly reports by hand" → the problem is REPORTING, not file formats.
- Classify the request: symptom-request (asks for a painkiller at the point of pain) vs root-need. Symptom-requests get reframed; the reframe MUST be stated to the user, never silently substituted.

## Step 2 — collect problem facts

Tools before questions: mine the repo, analytics, support tickets, existing docs, and issue trackers FIRST; ask the user only what no tool can answer. Collect:

- WHO hurts — persona/segment, and roughly how many (5 power users ≠ 80% of signups).
- WHEN/WHERE — the trigger moment in their workflow or journey.
- HOW OFTEN — frequency and volume (daily friction ≠ annual annoyance).
- COST — time lost, money lost, churn/support risk, or risk exposure per occurrence.
- TODAY'S ALTERNATIVE — the current workaround. A messy workaround is PROOF of demand; no workaround at all is an adoption red flag (the pain may not clear the effort bar).

Grade EVERY fact: `measured` (data you or the user actually looked at), `reported` (someone said so), `assumed` (nobody checked). Grades are load-bearing: they decide how much validation the direction needs later.

## Step 3 — frame the job-to-be-done

- One sentence: "When [situation], I want to [motivation], so I can [outcome]."
- The job is stable; solutions churn. A good JTBD contains zero implementation nouns.

## Step 4 — bound the problem

- Non-goals: adjacent pains explicitly NOT being solved now.
- Constraints: platform, compliance, budget, deadline, team, tech ceiling.
- Success signal: the observable change that means the problem is solved — a metric or a behavior, never "users are happier".

## Interview protocol

When facts are missing after tool research: ONE batched round, max 4 questions, each with your proposed default so "go with defaults" is a complete answer. NEVER drip questions across turns. NEVER ask what analytics, the repo, or a ticket search can answer.

## Expected output — Problem Brief

Present this brief in the conversation for user confirmation (it later becomes the header of the spec artifact — see skill://product-spec). Keep it under one page:

```markdown
## Problem Brief — <topic>

**Problem statement**: <1-2 sentences; zero solution words>
**Who + how many**: <segment, rough size> [measured|reported|assumed]
**Trigger & frequency**: <when it bites, how often> [grade]
**Cost of pain**: <time/money/churn/risk per occurrence> [grade]
**Today's alternative**: <current workaround, or "none — adoption risk"> [grade]
**Job-to-be-done**: When <situation>, I want to <motivation>, so I can <outcome>.
**Success signal**: <observable metric/behavior change>
**Non-goals**: <explicitly out>
**Constraints**: <platform/compliance/deadline/budget>
**Original request (verbatim)**: <the user's solution, parked for ideation>
**Open questions**: <what remains unknown + proposed default>
```

## Self-check rubric — run before presenting, fix inline

- Problem statement contains ZERO solution nouns (no feature names, no UI elements, no technologies).
- Every fact carries an evidence grade; at least one WHO/COST fact is `measured` or `reported`.
- 3+ core facts still `assumed` → do NOT present as validated; present as hypothesis and ask the batched round instead.
- Today's alternative is named, or its absence is flagged as adoption risk.
- Success signal is observable by a third party.
- The user's original solution is parked verbatim, not lost.

## Handoff

- User confirms the brief → skill://product-ideation for direction generation.
- Solution space genuinely constrained (compliance mandate, single possible mechanic) → skip ideation, go to skill://product-spec and say why.
- Brief reveals the problem is not worth solving (low frequency × low cost, nobody would switch from the workaround) → recommend NOT building, with the evidence. "Don't build it" is a senior deliverable.

## Fresher traps

Refining the solution during discovery; asking the user what analytics can answer; treating the loudest requester as the largest segment; discovery-as-filibuster (endless questions while evidence sits in reach); silently reframing the request without telling the user; accepting "everyone needs this" as a WHO.
