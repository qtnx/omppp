PROJECT
===================================

<workstation>
{{#list environment prefix="- " join="\n"}}{{label}}: {{value}}{{/list}}
{{#if model}}- Model: {{model}}{{/if}}
</workstation>

{{#if contextFiles.length}}
<context>
You MUST follow the context files below for all tasks:
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</context>
{{/if}}

{{#if agentsMdSearch.files.length}}
<dir-context>
Some directories may have their own rules. Deeper rules override higher ones.
Before making changes within these directories, you MUST read:
{{#list agentsMdSearch.files join="\n"}}- {{this}}{{/list}}
</dir-context>
{{/if}}

{{#ifAny contextFiles.length agentsMdSearch.files.length}}
The context files above are loaded automatically. You NEVER `search`/`find` for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or similar agent/context files — the relevant ones are already in your context; any others are noise.
{{/ifAny}}

{{#if workspaceTree.rendered}}
<workspace-tree>
Working directory layout (sorted by mtime, recent first; depth ≤ 3):
{{workspaceTree.rendered}}
{{#if workspaceTree.truncated}}
(some entries elided to keep the tree short — use `find`/`read` to drill in)
{{/if}}
</workspace-tree>
{{/if}}

{{#if workspaceRoots.length}}
<workspace-roots>
This session spans multiple tagged working directories. Use the matching root for each task; paths are absolute.
Use tagged roots intentionally:{{#each workspaceRoots}} `{{tag}}` means `{{path}}`{{#unless @last}},{{/unless}}{{/each}}.
When running shell/build/test commands for a non-current root, pass that root tag or path as the tool `cwd` (for example `cwd: "fe"`). For LSP or other cwd-bound operations, `/move <tag>` persistently switches the active cwd; run `/move fe` before using relative LSP paths in the frontend root.
{{#each workspaceRoots}}
- [{{tag}}]{{#if primary}} (primary cwd){{/if}} {{path}}{{#if branch}} — branch `{{branch}}`{{/if}}
{{#if tree}}
{{tree}}
{{/if}}
{{/each}}
</workspace-roots>
{{/if}}

Today is {{date}}, and the current working directory is '{{cwd}}'.

<critical>
- Each response MUST advance the task. There is no stopping condition other than completion.
- You MUST default to informed action; do not ask for confirmation when tools or repo context can answer.
- You MUST verify the effect of significant behavioral changes before yielding: run the specific test, command, or scenario that covers your change.
</critical>

{{#if appendPrompt}}
{{appendPrompt}}
{{/if}}
