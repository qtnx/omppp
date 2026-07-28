# Telegram Bot Bridge — Product Spec (2026-07-27)

## Problem

When the operator leaves the terminal, they still need to monitor and redirect the active OMPx coding session from a phone without maintaining an SSH/TUI connection. The current alternatives—SSH, the collab browser, and live voice—do not provide a private, text-first bot workflow.

## Direction & why

Run a Telegram Bot API long-polling bridge inside the active interactive OMPx session. The bridge reuses `AgentSession` user-message queues and event subscription, so Telegram text has the same steering/follow-up semantics as local input and assistant output is mirrored without introducing a daemon, relay service, store, or Telegram SDK dependency.

## Non-goals

- No webhook server or hosted gateway.
- No standalone `ompx telegram` daemon or cross-process session discovery.
- No group, channel, public-chat, or multi-user operation.
- No multi-session picker or one bot controlling concurrent OMPx processes.
- No voice, photo, file, location, edited-message, reaction, or callback-query handling.
- No Markdown/HTML parsing in outbound Telegram messages.
- No token/thinking/tool-output stream; only terminal assistant answers and lifecycle/error status.
- No delivery of updates received before the bridge reports itself connected.

## Stories & acceptance criteria

### Enable and inspect the bridge

As the active TUI operator, I can enable, inspect, and disable the Telegram bridge so that one private Telegram chat controls this session only.

- Given `OMP_TELEGRAM_BOT_TOKEN` and `OMP_TELEGRAM_ALLOWED_CHAT_ID` are loaded from environment overlays, when `/telegram on` succeeds, the TUI reports the bot username and connected status and the allowed chat receives one connection message naming the OMPx session and workspace.
- `OMP_TELEGRAM_ALLOWED_CHAT_ID` must match the exact decimal grammar `^[1-9][0-9]*$` and parse to a positive safe integer; exponent, sign, decimal, trailing text, whitespace-only, zero, negative, and unsafe values are rejected without coercion.
- Calling `/telegram on` again is serialized and idempotent: it waits for any in-flight lifecycle operation, reports already connected, and does not create a second poller or subscription.
- `/telegram status` reports disconnected, connecting, connected, retrying, stopping, or failed without printing the token, Bot API URL, chat ID, or content.
- `/telegram off` fences the current generation, synchronously unsubscribes from session events, aborts the active poll/send/backoff work, clears unsent outbound chunks, waits until no new HTTP operation can start, and reports disconnected.
- Interactive-session switch/shutdown performs the same awaited stop operation before replacing or tearing down the session. A later `/telegram on` creates a new generation; callbacks from older generations cannot mutate the session, status, or outbound queue.

### Steer and queue work from Telegram

As the authorized private-chat operator, I can steer the running turn or queue a follow-up so that I can redirect work without reopening the terminal.

- Authorized plain text and `/steer <text>` are delivered as an `AgentSession` steer.
- Authorized `/queue <text>` is delivered as an `AgentSession` follow-up.
- `/start` and `/help` return concise command usage without mutating the agent session.
- Empty `/steer` or `/queue` returns usage and does not mutate the session.
- A message from any other chat ID or a non-private chat is ignored, produces no Telegram response, and does not mutate the agent session.
- Media, edited messages, unsupported commands, and updates without text are ignored and acknowledged at the update-offset level so they do not replay forever.
- Updates are processed serially in increasing `update_id` order. The same `update_id` is delivered at most once while the bridge process remains alive.

### Receive assistant answers in Telegram

As the authorized operator, I receive terminal assistant answers so that Telegram mirrors the active session even when the initiating prompt came from the TUI.

- The bridge mirrors a terminal `agent_end` only when its generation observed the corresponding `agent_start`; enabling mid-turn never leaks that pre-activation turn's result. It sends the last non-empty assistant answer to the allowed chat exactly once per observed terminal event.
- Non-terminal `agent_end`, thinking deltas, tool calls/results, custom notices, intermediate tool-use assistant messages, and old-generation callbacks do not produce Telegram messages.
- Outbound text is sent as plain text with no `parse_mode` and is split on paragraph/line boundaries into ordered chunks of at most 4,000 Unicode code points without splitting surrogate pairs.
- The complete final answer is chunked before queue mutation. Its chunks are enqueued atomically and contiguously into a FIFO bounded to 32 chunks; if the full answer cannot fit, the bridge fails closed before enqueuing any of it, so no answer is truncated, interleaved, dropped, or reordered.

## Journey & states

| State | Trigger | Designed behavior |
|---|---|---|
| Disconnected | Initial state or `/telegram off` | No poller/subscription; Telegram updates are not consumed. |
| Connecting | `/telegram on` | Validate env, call `getMe`, inspect webhook, establish update watermark, then send connection message. |
| Connected | Validation succeeds | One long poll and one session-event subscription are active. |
| Retrying | Idempotent `getUpdates` timeout, network error, 429, or 5xx | Retry with capped exponential backoff plus jitter; honor `retry_after`; status remains observable locally. |
| Failed: configuration | Missing/invalid token or chat ID | No network loop starts; exact corrective variable is named without echoing its value. |
| Failed: authorization | Telegram 401/403 | Stop bridge; report token/access failure locally without logging request URL or token. |
| Failed: webhook/poller conflict | Active webhook or Telegram 409 | Stop bridge; explain that webhook/another poller must be disabled; never mutate webhook configuration automatically. |
| Failed: outbound ambiguity | `sendMessage` timeout/5xx | Do not retry because Telegram has no idempotency key; report locally to avoid duplicate final answers. |
| Failed: outbound rate limit | `sendMessage` 429 | Retain the FIFO head and honor validated `retry_after`; after 5 attempts or 5 cumulative minutes, whichever comes first, fail the bridge closed instead of blocking forever. |
| Stopping | `/telegram off`, session switch, or shutdown | Fence generation first; unsubscribe synchronously; abort poll/send/backoff; await quiescence; clear queue; settle stop idempotently. |

### Permissions matrix

| Actor | Read status | Steer | Queue | Receive answer |
|---|---:|---:|---:|---:|
| Local TUI operator | Yes | Yes | Yes | TUI |
| Configured private `chat_id` | Via `/start` or `/help` usage only | Yes | Yes | Yes |
| Any other Telegram chat/user | No | No | No | No |

Authorization requires both exact numeric `chat.id` equality and `chat.type === "private"`. Bot-token possession alone is not treated as authorization.

### Concurrency and misuse

- Exactly one poller may run per bridge instance; duplicate `on` calls share the existing instance.
- A Telegram 409 conflict is terminal because another process or webhook owns the bot update stream.
- Inbound updates are handled sequentially; no parallel `AgentSession` queue mutations.
- Long polling uses `allowed_updates=["message"]`, a 30-second server timeout, and an abortable client timeout greater than the server timeout.
- At activation, the bridge calls `getUpdates(offset=-1, limit=1, timeout=0)` and discards the returned tail update. Telegram defines a negative offset as retrieving from the end while forgetting all previous updates, so the next poll starts after the entire pre-enable backlog. The bridge reports connected only after this validated boundary is established.
- Telegram update transport is at-least-once. The in-memory `update_id` watermark prevents runtime duplicates; a process crash at the enqueue/ack boundary cannot provide transactional exactly-once delivery across Telegram and the in-memory agent queue.
- User-controlled text is passed only to `AgentSession`; it is never interpreted as a shell command, file path, URL, log field, or Telegram formatting markup by the bridge.
- Only the explicit `update.message` shape is eligible. Its `update_id`, `message.chat.id`, and message fields are runtime-validated before authorization or command parsing; malformed IDs are a provider-protocol failure, while every well-formed unsupported update is silently acknowledged and ignored.
- Production HTTP requests use the pinned `https://api.telegram.org` origin, an allowlisted method name, `redirect: "error"`, and sanitized boundary errors with no raw `cause`, response body, headers, request object, URL, or provider description.

### Data lifecycle

- Bot token and allowed chat ID remain environment values; neither is persisted by the bridge.
- The bridge retains only the current update offset, active bot metadata, bounded outbound chunks, and retry state in memory.
- `/telegram off` or session shutdown clears all bridge-owned in-memory data.
- Logs contain event class, HTTP status, retry delay, and redacted bot/chat identifiers only; never token, Bot API URL, message text, model output, or raw Telegram payload.

## Scope & cut-lines

| Scope | Capability | Rationale |
|---|---|---|
| NOW | `/telegram on|off|status` in interactive TUI | User-reachable lifecycle for the active session. |
| NOW | Private-chat allowlist and long-polling Bot API client | Minimum secure ingress behind NAT. |
| NOW | Plain text steer, `/steer`, `/queue`, `/start`, `/help` | Complete requested input semantics and recoverable usage. |
| NOW | Terminal final-answer mirroring with bounded chunk queue | Complete requested output semantics without rate-limit-heavy streaming. |
| NOW | Focused tests plus installed CLI/TUI harness against a local Bot API stub | Proves command reachability, auth rejection, queue semantics, output, and shutdown. |
| NEXT | Media input/output | Trigger: explicit request with attachment-size and model-image semantics. |
| NEXT | Multiple active sessions or bot-side session selection | Trigger: a second concurrent OMPx session must share one bot token. |
| NOT | Hosted gateway/webhook/daemon | Rejected architecture: adds infrastructure and trust boundaries without a current requirement. |
| NOT | Group/public chat | Violates the approved single-controller security model. |

## Metrics & guardrails

**Hypothesis:** A session-scoped private Telegram bridge reduces the need to reopen SSH/TUI for remote session interventions because an authorized phone message reaches the same steering/follow-up queues and final answers return to the same chat.

**Primary operational signal:** In a manual session probe, an authorized steer and queued follow-up both reach the intended session and the corresponding terminal assistant answer returns to Telegram without terminal interaction.

**Guardrails:**

- Unauthorized session mutations: exactly 0.
- Duplicate delivery of one Telegram `update_id` within one bridge runtime: exactly 0.
- Concurrent pollers created by repeated `/telegram on`: exactly 0.
- Unbounded memory growth: outbound queue never exceeds 32 chunks.
- Secret/content leakage in bridge logs and status: exactly 0 token/message/output bytes.

**Observability events:** structured debug/info/warn/error records for `telegram_bridge_enabled`, `telegram_bridge_disabled`, `telegram_poll_retry`, `telegram_update_accepted`, `telegram_update_rejected`, `telegram_send_failed`, and `telegram_bridge_failed`. Fields are limited to redacted bot/chat identifiers, update ID, mode, status code, retry delay, and queue depth.

**Kill criteria:** Any unauthorized message delivery or reproducible duplicate execution blocks release. After dogfooding, retire or redesign the bridge if remote interventions still require SSH/TUI in more than 80% of attempted Telegram sessions.

## Open questions & risks

There are no unresolved product-contract questions. Implementation must preserve these acknowledged risks:

- Telegram provides no idempotency key for `sendMessage`; ambiguous outbound failures are not retried.
- Exactly-once inbound delivery cannot be transactional with an in-memory agent queue; runtime dedupe and activation watermark bound the risk.
- The same bot token cannot safely be long-polled by multiple OMPx processes; Telegram 409 fails closed rather than selecting a winner.
- Telegram may retain updates for at most 24 hours, but this bridge intentionally discards all pre-activation backlog.
