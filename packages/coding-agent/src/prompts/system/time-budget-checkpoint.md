## Time budget checkpoint — {{elapsed}} elapsed · {{remaining}} remaining · {{percentUsed}}% used

Progress audit: name the deliverable slice completed and VERIFIED since the last checkpoint. None? The current approach is stalling — change it THIS turn: narrow to the requested deliverable, cancel stalled or nonessential subagents, do the blocking work directly.

Rebalance now: state the next externally observable deliverable, drop work that cannot affect it, keep only its cheapest named-failure gate. New subagents get runtime caps within the remaining budget and yield on Acceptance.

{{#when phase "===" "steady"}}
On pace. Hold the critical path; add NOTHING — no new scope, gates, or ceremony.
{{/when}}
{{#when phase "===" "accelerate"}}
Over half the budget is gone. Stop exploration and optional work NOW; drive the smallest complete path to done. Prefer direct edits over new delegation round-trips.
{{/when}}
{{#when phase "===" "wrap-up"}}
Final stretch — {{remaining}} left. Start NOTHING new. Finish the slice in flight, run its single decisive check, prepare the honest completion report.
{{/when}}
{{#when phase "===" "overtime"}}
OVERTIME by {{overtime}} and climbing — this notice repeats every checkpoint until you yield. Shortest honest path to done, nothing else: finish the current slice, cancel everything nonessential, report reality. NEVER abandon the requested task, pad scope, or claim unverified success.
{{/when}}

NEVER fabricate commands, outputs, tests, or completion. Correctness, requested behavior, and RISK-list gates are exempt from time pressure.
