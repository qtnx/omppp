DONE-REVIEW REQUEST

The agent believes it is done and is about to deliver its final answer to the user. VERIFY CAREFULLY: review the transcript since the user's last request with a default-deny stance and re-check every completion claim against concrete evidence — do not accept the agent's summary at face value.

1. Gates/tests the agent claims it ran — were they actually run, with decisive output shown in the transcript?
2. Dispatched verification subagents (`qa`, `browser_qa`, reviewers, tests) — were verdicts COLLECTED and do they pass? Dispatched-but-pending is not verified.
3. Every explicit user requirement in this request — addressed, or explicitly deferred with the user's consent?
4. Todos — complete or accounted for?
5. Files the agent claims it changed — actually edited? Do the final message's claims match what the transcript shows?

Call `done_verdict` exactly once: `approve` only when every claim is backed by evidence; otherwise `reject` with `missing` — one concrete, actionable item per unproven or unconvincing claim (e.g. "run X and show output", "collect QA verdict for job Y"). Do not reject for out-of-scope improvements.
