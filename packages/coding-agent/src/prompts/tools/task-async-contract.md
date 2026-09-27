Results auto-deliver; `read proc://` snapshots do not consume delivery. NEVER busy-poll.{{#if waitTool}} Completely blocked? Call `wait` to receive the first settled job{{#if ircEnabled}} or peer message{{/if}}.{{/if}}
{{#if ircEnabled}}Coordinate while peers run via `write agent://<id>` (or `agent://all` to broadcast); peer messaging is never subagent completion.{{/if}}

`read proc://<id>` inspects job status/output without consuming delivery. `write proc://<id>/kill` cancels; omit `content`.

Job IDs are process-local; delivered results expire shortly (~30s), unconsumed results within ~5min. Agent output/transcripts remain readable at `agent://<id>` / `history://<id>`.
`read proc://` lists jobs/services; `read proc://<id>` inspects status/output without consuming delivery. `write proc://<id>/kill` cancels/stops; omit `content`.
Job IDs are process-local; after delivery expiry use `agent://<id>` or `history://<id>`. `completed` means yielded successfully, not verified artifacts.

`completed`: subagent yielded successfully; claimed artifacts unverified.
