# irc

> Send and receive short messages between agents in the current process.

## Source
- Entry: `packages/coding-agent/src/tools/irc.ts`
- Prompt: `packages/coding-agent/src/prompts/tools/irc.md`
- Mailbox bus: `packages/coding-agent/src/irc/bus.ts`
- Agent directory: `packages/coding-agent/src/registry/agent-registry.ts`

## Inputs

| Field | Required | Description |
| --- | --- | --- |
| `op` | Yes | `"send"`, `"wait"`, `"inbox"`, or `"list"`. |
| `to` | `send` | Exact recipient agent id, or `"all"` for a broadcast. |
| `message` | `send` | Non-empty message body. |
| `replyTo` | No | Message id being answered. |
| `await` | No | For direct `send`, wait for the recipient's reply. Invalid with `to: "all"`. |
| `awaitReply` | No | Legacy alias for `await`. |
| `from` | No | For `wait`, accept messages only from this agent id. |
| `timeoutMs` | No | For `wait` and awaited sends. `0` means one maximum ten-minute window; re-issue to wait again. |
| `peek` | No | For `inbox`, list messages without consuming them. |

## Operations

### `list`
Lists addressable peers with their ids, kind, status, unread count, and recent activity. The caller itself, aborted agents, and advisor agents are excluded.

### `send`
Sends a direct message or broadcast and returns delivery receipts immediately. Direct sends wake idle peers and can revive parked peers. A broadcast reaches live peers only, avoiding a parked-agent stampede. Sending to oneself, omitting `to` or `message`, and combining `await` with `to: "all"` return errors.

Use exact peer ids from `list`; do not infer names. To answer a message, send direct prose and set `replyTo` to the message id.

### `wait`
Blocks for the next matching incoming message, optionally filtered by `from`. It returns the consumed message or a normal timeout result. Waits are for an answer that blocks current work, not for polling task completion.

### `inbox`
Drains pending messages. With `peek: true`, it lists them without consuming them.

## Delivery and timing

`send` is fire-and-forget: it does not wait for the recipient to respond. Set `await: true` only when work cannot continue without a reply; that operation sends first and then waits for a message from the direct recipient. The default IRC wait is configured by `irc.timeoutMs` (default `120000` milliseconds), and every wait is capped at ten minutes.

Messages are plain prose. Direct recipients can be running, idle, or parked; a running recipient receives a non-interrupting aside at a safe turn boundary. Delivery failures are returned as receipts; a send is an error only when no recipient received it.

## Availability and errors

The tool is enabled when `irc.enabled` is true and the session has an agent registry and caller id. Subagents always have a peer path; a top-level session also needs task-spawn capacity. Missing session prerequisites, unknown operations, invalid send parameters, and invalid broadcast awaiting return text error results rather than thrown tool errors.

## Compatibility

`irc` remains a discoverable standalone built-in tool for existing callers. It is available alongside the newer `hub` and `xd` surfaces; neither replaces this messaging contract.
