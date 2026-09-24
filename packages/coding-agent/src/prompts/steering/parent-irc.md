[Wait interrupted by message]
<irc from="parent" agent="{{from}}">
{{message}}

{{#if triage}}{{#if triageStatus}}Triage: status — no reply needed.{{else}}Triage: {{triage}} — answer with the fact/decision now; never tell the child to look it up.{{/if}}{{/if}}
</irc>
