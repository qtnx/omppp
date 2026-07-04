Read the durable advisor state stored at `local://advisor-state.md`.

Use this before making oversight decisions that depend on prior requirements, decisions, verification status, dispatched subagents, unresolved watchpoints, or effort history. If no state exists yet, initialize it with `update_advisor_state` after recording the current task.

The state is a ledger, not advice text. Treat it as your durable memory across compaction and re-prime.
