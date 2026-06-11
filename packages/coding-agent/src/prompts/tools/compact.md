Archives older conversation history (same pipeline as automatic context maintenance), freeing context space while keeping recent messages intact.

Calling this tool only SCHEDULES compaction: it runs automatically right after the current turn ends. It is NOT immediate. The request is dropped if the turn is aborted. It does not cancel in-flight work — but NEVER call while subagents, workflows, background jobs, or other async results are still pending delivery; their outputs would arrive after the archive and lose their surrounding context. The configured strategy decides the archive form: LLM summary or snapcompact image frames.

Scope: compact is coarse, turn-boundary archival of the whole older history. If `context_unload`/`context_pin`/`context_recall` are available and you only need to drop specific stale tool results while continuing the same task, use those instead; reach for compact at a real boundary where broad older history can be archived wholesale.

<when>
Call when ANY hold:
- You just completed a distinct unit of work (task, phase, milestone, investigation, debug cycle) AND its raw context (file reads, logs, search results, tool output) is not needed for the next steps.
- You are about to switch to a new topic or independent subtask that depends only on conclusions, not raw history.
- Exploration/debugging output dominates context but the decisions/facts are already stated in your replies.
- A long session has accumulated many stale tool results.
- The NEXT turn will start a context-heavy phase (large reads, builds, test sweeps). Call only as the last action of this turn, right before yielding — never call and then continue heavy work in the same turn, since compaction has not run yet.
- The PREVIOUS turn already completed its work and any condition above holds — call immediately; a turn whose only action is scheduling compaction is legitimate.
</when>

<when_not>
- NEVER call mid-task when exact details from earlier messages (line numbers, hashes, diffs, error text) are still needed — state them in a reply first or do not compact.
- NEVER call while unresolved failures/errors under active investigation live only in older context.
- NEVER call in a turn that asks the user a question, requests approval, or leaves a decision pending — wait until the answer is incorporated.
- NEVER call just to probe availability. If little substantial work happened since the last compaction, continue without compacting; the runtime rejects true no-op requests.
- NEVER re-call after a "scheduled" result — at most one call per turn; the request is already recorded.
- NEVER call when the plan for remaining work exists ONLY in old conversation and has not been restated.
</when_not>

`reason` is shown to the user — name the boundary just reached (example: "auth refactor verified; exploration logs no longer needed").
