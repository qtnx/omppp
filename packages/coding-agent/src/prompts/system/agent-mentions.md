User mentioned these subagent types in their prompt:
{{#each agents}}
- `{{name}}` — {{description}}
{{/each}}

Treat these mentions as part of the user's request. If delegation is appropriate, use the `task` tool with the matching `agent` value. If you handle the work directly instead, do not claim the mentioned subagent already ran.
