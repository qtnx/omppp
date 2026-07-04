Request planner takeover when executor control is unsafe or fresh planning is required.

Use `purpose: "recover"` (the default) when:
- The executor drifts from the approved plan.
- The executor repeats failed attempts on the same problem.
- The executor is off-track, looping, or worsening state.

Use `purpose: "plan"` when:
- A user prompt introduces scope, architecture, or product ambiguity that needs the planner before execution digs in.
- The current request is plan-shaped and should return the Fable model to planning rather than recover from executor failure.
- The executor should stop before implementation calcifies around a wrong structure.

Recover cooldown may convert a recover request into high-severity advice instead of takeover. Planning takeover does not use recover cooldown.

`reason` MUST cite transcript evidence. For `purpose: "recover"`, `directive` MUST state the planner's first action after takeover. For `purpose: "plan"`, `directive` is ignored.
