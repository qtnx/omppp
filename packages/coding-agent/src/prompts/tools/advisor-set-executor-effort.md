Set the executor's thinking effort override.

Use this tool only for duo advisor steering. Accepted levels are `high`, `xhigh`, and `max`; never lower the executor below `high`.

Escalation criteria:
- `xhigh`: use after at least 2 failed attempts at the same problem, architectural ambiguity, or cross-module debugging.
- `max`: use when the executor is still failing under `xhigh`, or when the work is correctness-critical and intricate.
- `high`: return to this level when routine execution resumes and elevated effort is no longer justified.

`reason` MUST cite the transcript evidence or task property that justifies the change.
