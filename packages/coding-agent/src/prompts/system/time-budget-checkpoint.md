## Active-work budget checkpoint

Elapsed: {{elapsed}}. Remaining: {{remaining}}. Overtime: {{overtime}}. Used: {{percentUsed}}%. Phase: {{phase}}.

Rebalance the critical path now: name the next executable deliverable, stop work that cannot affect it, parallelize only genuinely independent ready production slices, finish the current slice, and run its cheapest named-failure verification. Bound every subagent's `max_runtime_seconds` by the remaining budget, monitor blockers, and cancel nonessential work.

{{#when phase "===" "steady"}}
Continue the current critical path without adding ceremony.
{{/when}}
{{#when phase "===" "accelerate"}}
Stop optional exploration and finish the smallest complete executable path.
{{/when}}
{{#when phase "===" "wrap-up"}}
Stop new optional work; finish and verify the current requested slice before starting anything else.
{{/when}}
{{#when phase "===" "overtime"}}
Finish the current executable slice, stop new optional work, and report reality. Do not abandon the requested task or pretend it passed.
{{/when}}

Never fabricate commands, outputs, tests, or completion. Preserve correctness, requested behavior, and RISK-list gates.