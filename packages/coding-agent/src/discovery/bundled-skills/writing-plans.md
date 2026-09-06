---
name: writing-plans
description: Required when a decided request needs an executable multi-step plan. Capture ownership, runtime order, assumptions, and checks without turning planning into implementation.
triggers:
  - write a plan
  - implementation plan
  - multi-step plan
---

# Writing Plans

Write complete plan with following sections:

- **Inventory** — start with existing-code inventory. For every capability the request needs, cite an opened `file:line` anchor and mark it EXISTS, PARTIAL, or MISSING.
- **Summary** — requested outcome, why it matters, and explicit non-goals.
- **Changes** — full requested scope, production packages, owned files or symbols, and minimum shared contracts.
- **Sequence** — current ready horizon, dependencies, and the order executable slices land. Ready-horizon limits dispatch order, never plan completeness.
- **Assumptions** — local unknowns owners may resolve; surface contradictions instead of hiding them.
- **Verification** — failure-matched checks for each slice and final entry-point evidence.
- **Next dispatch** — name an exact production owner only when implementation is authorized; for plan-only requests, state that no dispatch occurs.
- **Review delta** — on revision, map each blocker or user comment to its material resolution.

Keep plan-only requests plan-only: describe code and verification, but do not edit production files or dispatch implementation. Lock only when requirements, ownership, sequence, acceptance, and decisions are complete.
