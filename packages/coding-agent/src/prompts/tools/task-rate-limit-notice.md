<system-notification>
Subagent `{{agentId}}` {{#if retrying}}is provider-rate-limited and waiting to retry{{else}}exhausted provider retries because of a rate limit{{/if}}. Task delegation is paused{{#if retryIn}} for at least {{retryIn}}{{/if}}.
NEVER wait on or spawn more subagents while delegation is paused. Existing jobs remain live and deliver automatically. Continue the blocked work in the current agent or report the provider limit.
</system-notification>
