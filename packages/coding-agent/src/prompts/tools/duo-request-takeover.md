Request planner takeover when executor control is unsafe.

Use this tool when:
- The executor drifts from the approved plan.
- The executor repeats failed attempts on the same problem.
- The executor claims completion without trustworthy evidence.

Purposes:
- `recover`: executor is off-track, looping, or worsening state.
- `verify`: completion claim needs independent planner verification.

Cooldown may convert `recover` into high-severity advice instead of takeover.

`reason` MUST cite transcript evidence. `directive` MUST state the planner's first action after takeover.
