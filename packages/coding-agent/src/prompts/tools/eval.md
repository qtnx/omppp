One cell per call; top-level state persists, including across compaction.{{#if spawns}} Subagents have separate kernels.{{/if}}
{{#if spawns}}{{#if eagerDelegation}}For 2+ independent items, use a named `workpool()`; results auto-deliver.{{#if waitTool}} If blocked, leave `eval` and call `wait`.{{/if}}{{/if}}{{/if}}
{{#if py}}Python: top-level `await` works; `asyncio.run(…)` fails.{{/if}}
{{#if js}}JS: Bun (`Bun.file`, `Bun.write`, `Bun.$`); top-level `await`/`return` work.{{/if}}
On error, retry only the failed step; earlier steps may have taken effect.

<prelude>
{{#ifAll py js}}Python helpers: sync, kwargs; JS helpers: async, ONE trailing options object.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing options object.{{/if}}{{/ifAll}}
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
{{#if js}}await {{/if}}tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.{{#if py}} Async: `await tool.read({...})`.{{/if}}
wait(handles, timeout?=None, raise_errors?=True) — agent/completion barrier, ordered results{{#if js}}; JS: wait(handles, { timeout, raiseErrors }){{/if}}; `raise_errors=False` retains failures.
```
</prelude>

{{#if inlineTopics}}
{{{inlineTopics}}}
{{else}}
<namespaces>
More globals; `read` the linked docs before first use:
- `judge`, `{{#if py}}judge_batch{{else}}judgeBatch{{/if}}`, `completion`: classification, bulk judgment, model calls → `xd://eval/judge`
- `%load`{{#if py}}, `%pip`{{/if}}{{#if js}}, `%bun add`{{/if}}, `budget`{{#if evalTools}}, `@tool`/`tool(fn)`{{/if}}: setup, installs, utilities → `xd://eval/helpers`
{{#if spawns}}
- `agent`, `workpool`: background subagents, DAG waves → `xd://eval/agents`
{{/if}}
{{#each preludes}}
- `{{name}}`: {{summary}} → `xd://eval/{{name}}`
{{/each}}
</namespaces>
{{/if}}
{{#if spawns}}
# Agent Handoff
`agent()` prompts carry the same `H` handoff and `follow(repoSpec)` contract as the `task` tool: decisive excerpts and exact `skill://`/context-file paths inline, so the child acts without repo-wide rediscovery; a missing or stale fact justifies only a narrow lookup and a reported rediscovery.
{{/if}}

<critical>
NEVER repeat successful setup. Kernel-loss notice means reload setup.
</critical>

{{#if autoBackgroundEnabled}}Long cells may auto-background and deliver later; the kernel stays busy. `timeout: 0` disables the cell deadline, not the foreground wait.{{/if}}
