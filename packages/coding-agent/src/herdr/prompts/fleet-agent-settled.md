A peer coding agent managed by Herdr just finished its work in another pane.

- pane: `{{paneId}}`{{#if name}} — named agent `{{name}}`{{/if}}
- agent: {{agent}}
- state: {{status}}{{#if workedSeconds}} (worked ~{{workedSeconds}}s){{/if}}
{{#if title}}- its last reported task: {{title}}{{/if}}

Read what it produced, then decide the next step yourself:

```sh
herdr agent read {{readTarget}} --source recent-unwrapped --lines 120
```

Keep the user's focus where it is: never call a focus command, and never assume the peer succeeded before reading its output. If the work is unfinished or wrong, send it a follow-up with `herdr agent prompt {{readTarget}} "..."`.
