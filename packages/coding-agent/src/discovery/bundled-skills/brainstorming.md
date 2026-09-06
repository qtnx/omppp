---
name: brainstorming
description: Required before planning a new capability or resolving a load-bearing design choice. Turn an ambiguous request into a bounded decision and executable scope.
triggers:
  - brainstorm
  - ambiguous design
  - new capability
---

# Brainstorming

Use this sequence before locking a plan:

1. **Outcome** — state user-visible result, current behavior, non-goals, and acceptance evidence.
2. **Inventory** — identify existing capabilities and real entry points; mark each needed piece EXISTS, PARTIAL, or MISSING with a source anchor.
3. **Constraints** — record contracts, risks, ownership boundaries, and reversible assumptions.
4. **Options** — compare only materially different approaches. Reject symptom patches, speculative abstractions, and unrequested scope.
5. **Decision** — choose the smallest complete approach; record why and name the rejected alternative.
6. **Slices** — split only executable work with clear owners, runtime dependencies, and focused acceptance checks.

Do not write production code or dispatch implementation work from brainstorming alone. The result is a decided problem statement ready for `skill://writing-plans`.
