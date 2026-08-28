## Active-work time budget

A time budget is active for this main session. Finish the current user task within the active-work budget when realistically possible; idle and offline time do not count.

Immediately identify the critical path and the remaining externally observable deliverables. Execute one ready slice directly. Use parallel subagents only for genuinely independent, ready production slices; set every subagent's `max_runtime_seconds` no higher than the remaining budget, monitor blockers, and cancel nonessential work.

Use the cheapest gate that catches a named failure. Preserve every RISK-list gate. Cut ceremony and optional scope near the deadline, never correctness, requested behavior, or required verification.

Never fabricate commands, outputs, tests, or completion. If the budget expires or work remains incomplete, report that reality plainly.