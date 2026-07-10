<system-reminder>
Task delegation is enabled — subagents are the default for this request.

Explore and settle the approach FIRST. Once the design is settled, you MUST fan the work out to subagents per routing rules — specialists first, implementer tiers only for implementation — instead of implementing it yourself.{{#if taskBatch}} Group independent slices by agent type; partition each group into compatible same-agent batches; dispatch EVERY batch concurrently through `{{toolRefs.task}}` calls in the same wave.{{else}} Dispatch EVERY independent ready slice concurrently as flat `{{toolRefs.task}}` calls; NEVER dispatch one at a time.{{/if}}

Work alone only for: a single-file edit under ~30 lines, a direct answer requiring no code changes, or a command the user explicitly asked you to run.
</system-reminder>
