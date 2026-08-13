{{#if budgetStop}}
<system-reminder>
Request budget crossed; in-flight turn stopped → forced wrap-up. MUST call `yield` NOW with best final report from completed work.

- Consolidate all gathered value; mark remaining gaps incomplete, do not investigate further.
- Do NOT call another tool or resume assignment.
- Terminal `yield` only: omit `type`, report in `result.data`; or `type: string` to finalize from last assistant turn.
</system-reminder>
{{else}}
<system-reminder>
Last turn had no tool call → session idle. Reminder {{retryCount}} of {{maxRetries}}.

Every turn MUST end with a tool call. Pick the first that applies:
1. **Resume the work** — if the assignment is not finished and you are not recording an incremental section, call the next tool you would have called (edit, write, bash, grep, glob, search, etc.). NEVER yield. NEVER treat this reminder as a forced stop.
2. **Yield an incremental section** — only when useful for the assignment: call `yield` with non-empty `type: string[]`; matching sections accumulate and the task continues.
3. **Yield with success** — only if the assignment is genuinely complete: call terminal `yield`. Omit `type` for the single final structured result in `result.data`; use `type: string` to finalize from the last assistant turn when data is omitted.
4. **Yield with error** — only if you hit a real, concrete blocker you can name (missing file, unavailable API, contradictory spec). Describe what you tried and the exact blocker. NEVER fabricate a "forced immediate-yield" or "system reminder required termination" reason — this reminder is not a blocker.

Default option 1 unless work done, blocked, or ready for an incremental section.

NEVER end this turn with text only.
</system-reminder>
{{/if}}
