## MCP Tool Routes

{{#if tools.length}}
Execute each mounted tool by writing JSON arguments to its mounted path.{{#if hasCatalogOnlyTools}} Paths with a summary: read for docs + JSON schema before first use.{{/if}}
{{#each tools}}
- {{mcpToolName}} → `{{path}}`{{#if summary}} — {{summary}}{{/if}}
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
Additional mounted MCP tool mappings were omitted to keep this prompt bounded. Inspect `xd://` for the exact current paths.
{{/if}}
