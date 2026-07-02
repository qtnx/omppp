DONE-REVIEW REQUEST

The agent believes it is done and is about to deliver its final answer to the user. Review the transcript since the user's last request with a default-deny stance and verify every completion claim against evidence:

1. Gates/tests the agent claims it ran — actually run, with decisive output shown?
2. Dispatched verification subagents (`qa`, `browser_qa`, reviewers, tests) — verdicts COLLECTED and pass? Dispatched-but-pending is not verified.
3. Every explicit user requirement in this request — addressed, or explicitly deferred with the user's consent?
4. Todos — complete or accounted for?
5. The final message's claims — consistent with what the transcript actually shows?

Call `done_verdict` exactly once: `approve`, or `reject` with `missing` — one concrete, actionable item per unproven claim. Do not reject for out-of-scope improvements.
