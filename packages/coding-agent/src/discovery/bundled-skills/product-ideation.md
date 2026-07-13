---
name: product-ideation
description: Use when brainstorming product solutions or feature directions — "give me options", "how should we solve this", comparing approaches, or stress-testing a chosen direction before committing to spec or implementation. Run product-discovery first when the underlying problem is not yet framed.
---

# Product Ideation

The first idea is rarely the best; it is merely the most available. Senior ideation is three moves: diverge WIDE (genuinely different directions), converge HONESTLY (scores argue, dealbreakers veto), and attack the winner BEFORE committing (premortem). An unexamined favorite is how teams ship six months of the wrong thing.

## Preconditions

- A problem brief exists (skill://product-discovery). No brief → run discovery first; ideation against an unframed problem produces plausible noise.
- The user's original embedded solution (parked in the brief) enters as candidate #1. It competes on equal footing — NEVER silently dropped, NEVER auto-crowned.

## Step 1 — diverge: ≥3 genuinely distinct directions

Distinct = different MECHANISM or different JOB APPROACH. Litmus: if two options share the same data model and differ only in UI skin or copy, they are ONE option. Generate with at least 3 of these lenses:

- INVERSION — what would make the problem disappear entirely? (change a default, kill a step, prevent the state — often a process fix, not a feature)
- ZERO-BUILD — config, docs, template, or manual service that solves it TODAY. The do-nothing/operational option is a legitimate candidate and often wins on cost.
- ANALOGY — how do 2 named real products in adjacent domains solve the same job-to-be-done? Steal the pattern, not the pixels.
- CONSTRAINT FLIP — with 10x budget? With 1/10? If it had to ship with no UI at all?
- SCAMPER pass over the current workflow — substitute / combine / adapt / magnify / eliminate / reverse.
- EXTREME USER — design for the power user, then for the first-run user; the tension exposes middle-ground options.

Anti-slop rules:

- NEVER pad with a strawman to make a favorite look good. Every option must be one a competent PM would genuinely argue for.
- NEVER offer generic listicle ideas ("add AI", "gamify it", "make it social") unless tied to the brief's JTBD with a concrete mechanism.
- Each option gets a mechanism one-liner: WHAT changes in the user's workflow and HOW. If you cannot write the mechanism, it is not an option yet.

## Step 2 — converge: scorecard with veto rights

Score every direction 1-5 on four axes:

- IMPACT — expected movement of the brief's success signal.
- EFFORT — wall-clock to FULL production scope (not to a demo; demos are banned as delivery tiers).
- RISK — technical + adoption + data risk, taken together.
- DIFFERENTIATION — vs today's alternative and vs the market (pull from skill://competitive-recon when it ran).

Rules: scores are ARGUMENTS, not arithmetic — a 1 on any axis that is a dealbreaker for this context kills the option regardless of total. Ties break toward the boring option (lowest risk, most reversible). State every score's one-line justification; unexplained numbers are scoring theater.

## Step 3 — premortem the winner BEFORE presenting

Run this on the recommended direction; if it survives, present — if it dies, fold the learning back into Step 1:

- RISKIEST ASSUMPTION — the single belief that, if false, kills the direction. Label it explicitly with its evidence grade from the brief.
- FAILURE HEADLINES — "It is 6 months later and this flopped." Write the 3 most plausible headlines across: user (didn't adopt / kept the workaround), market (competitor response / pricing), tech (couldn't scale / data quality), ops (support load / abuse vector).
- CHEAPEST FALSIFICATION — the fastest observation that would disprove the riskiest assumption: an analytics query, a 5-user ask, a fake-door, a spike behind a flag. Name it even if the user may skip it.
- KILL CRITERIA — the observable post-ship condition that means stop or pivot (e.g. "<10% of weekly actives touch it within 30 days").

## Expected output — Direction Memo

Present in the conversation; the chosen direction and its premortem carry into skill://product-spec:

```markdown
## Direction Memo — <topic>

| # | Direction | Mechanism (one line) | Impact | Effort | Risk | Diff | Dealbreaker? |
|---|-----------|----------------------|--------|--------|------|------|--------------|
| 1 | <user's original ask> | ... | 4 | 3 | 2 | 2 | — |
| 2 | ... | ... | ... | ... | ... | ... | <axis or —> |

**Recommendation**: <direction + 2-3 sentences tied to the brief's success signal>
**Riskiest assumption**: <belief> [measured|reported|assumed]
**Cheapest falsification**: <test, cost, what result kills it>
**Kill criteria**: <observable post-ship condition>
**Declined options**: <one line each — direction + the reason it lost>
```

STOP after presenting. The USER picks the direction — NEVER auto-proceed to spec on your own recommendation unless the user pre-delegated the choice in this conversation.

## Self-check rubric — before presenting

- ≥3 directions, each with a distinct mechanism (litmus applied).
- Candidate #1 is the user's original ask, scored honestly.
- A zero-build/do-nothing option was considered (present or explicitly ruled out with reason).
- Every score has a one-line justification; dealbreakers named per option.
- Premortem complete: riskiest assumption + falsification + kill criteria all filled.
- No option is a strawman; no generic listicle entries.

## Fresher traps

Three skins of one idea; strawman padding; scoring arithmetic that buries a dealbreaker; skipping premortem because the winner is "obvious"; dropping the user's original ask without naming it in declined options; converging on the novel option when the boring one scores higher; presenting a wall of ideas with no recommendation.
