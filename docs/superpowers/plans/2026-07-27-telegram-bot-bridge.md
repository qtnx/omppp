# Telegram Bot Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagents-development` and execute each owned package test-first. Leave all edits uncommitted; the repository forbids commits unless the user explicitly requests one.

**Goal:** Add `/telegram on|off|status` to an interactive OMPx session so one configured private Telegram chat can steer or queue user text and receive terminal assistant answers.

**Architecture:** An in-process `TelegramCommandController` owns a `TelegramBridge` for the active `InteractiveMode`. The bridge maps Telegram updates into existing `AgentSession.sendUserMessage` queues and maps terminal session events into a bounded FIFO of Bot API `sendMessage` calls. A narrow Bun-fetch client owns Telegram JSON/error contracts; no SDK, store, webhook, worker, daemon, or new deployable is introduced.

**Tech Stack:** TypeScript, Bun `fetch`, Bun test, existing `AgentSession`, existing `InteractiveMode` controller/slash-command patterns.

**Product contract:** `docs/product/specs/2026-07-27-telegram-bot-bridge.md`

**Architecture contract:** `docs/product/architecture/2026-07-27-telegram-bot-bridge.md`

## Global Constraints

- Environment keys are exactly `OMP_TELEGRAM_BOT_TOKEN` and `OMP_TELEGRAM_ALLOWED_CHAT_ID`, consumed through `$env` from `@oh-my-pi/pi-utils`; never read `.env` files directly.
- Authorization requires `message.chat.type === "private"` and exact numeric equality to the configured positive safe-integer chat ID. All other chats are silently ignored.
- Token, Bot API URL, raw Telegram payload, inbound text, and assistant output MUST NOT enter logs or rendered errors.
- Production Bot API origin is pinned to `https://api.telegram.org`; a base URL is injectable only through TypeScript constructors for tests, never from environment/config.
- `getUpdates` is retried with capped jittered backoff; `sendMessage` is retried only for explicit 429 `retry_after`. Ambiguous timeout/5xx send outcomes are not retried.
- Backlog present before `/telegram on` reports connected is discarded with Telegram's documented `getUpdates(offset=-1, timeout=0)` tail read, which forgets all previous updates. Runtime updates are processed serially by increasing `update_id`.
- Outbound content is plain text, no `parse_mode`, split into <=4,000 Unicode code points, FIFO bound 32 chunks.
- New tests must assert observable behavior, must be observed RED before production implementation, and must not use `mock.module()` or source-text assertions.
- No project-wide formatter or full suite inside implementation packages. Parent runs final cross-cutting gates once.

---

## Locked shared contract prefix

Create this file before parallel production packages and do not redesign the names/shapes without a concrete compile contradiction:

**File:** `packages/coding-agent/src/telegram/types.ts`

```ts
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../session/agent-session";

export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
export const TELEGRAM_LONG_POLL_SECONDS = 30;
export const TELEGRAM_REQUEST_TIMEOUT_MS = 35_000;
export const TELEGRAM_MESSAGE_CHUNK_CODE_POINTS = 4_000;
export const TELEGRAM_MAX_OUTBOUND_CHUNKS = 32;
export const TELEGRAM_MAX_SEND_RATE_LIMIT_ATTEMPTS = 5;
export const TELEGRAM_MAX_SEND_RATE_LIMIT_WAIT_MS = 300_000;

export type TelegramBridgePhase =
	| "disconnected"
	| "connecting"
	| "connected"
	| "retrying"
	| "stopping"
	| "failed";
export type TelegramMethod = "getMe" | "getWebhookInfo" | "getUpdates" | "sendMessage";

export interface TelegramApiFailure {
	readonly name: "TelegramApiError";
	readonly method: TelegramMethod;
	readonly httpStatus?: number;
	readonly errorCode?: number;
	readonly retryAfterMs?: number;
	readonly ambiguous: boolean;
}

export interface TelegramBridgeStatus {
	phase: TelegramBridgePhase;
	botUsername?: string;
	message?: string;
	retryAfterMs?: number;
}

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	username?: string;
}

export interface TelegramWebhookInfo {
	url: string;
}

export interface TelegramMessage {
	message_id: number;
	text?: string;
	chat: { id: number; type: string };
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface TelegramBotClientContract {
	getMe(signal?: AbortSignal): Promise<TelegramUser>;
	getWebhookInfo(signal?: AbortSignal): Promise<TelegramWebhookInfo>;
	getUpdates(options: {
		offset?: number;
		limit?: number;
		timeoutSeconds: number;
		allowedUpdates: readonly string[];
		signal?: AbortSignal;
	}): Promise<TelegramUpdate[]>;
	sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<void>;
}

export interface TelegramSessionContract {
	readonly sessionId: string;
	/** Resolves true once queued, false when preflight rejects; rejection also guarantees no queue mutation. */
	enqueueUserMessage(content: string, deliverAs: "steer" | "followUp"): Promise<boolean>;
	subscribe(listener: Parameters<AgentSession["subscribe"]>[0]): () => void;
}

export interface TelegramBridgeOptions {
	client: TelegramBotClientContract;
	session: TelegramSessionContract;
	allowedChatId: number;
	extractAssistantText(message: AssistantMessage): string;
	onStatus(status: TelegramBridgeStatus): void;
	delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	random?: () => number;
}

export interface TelegramBridgeHandle {
	readonly status: TelegramBridgeStatus;
	start(): Promise<void>;
	stop(): Promise<void>;
	dispose(): void;
}

export interface TelegramBridgeFactoryOptions extends Omit<TelegramBridgeOptions, "client"> {
	token: string;
}

export type CreateTelegramBridge = (options: TelegramBridgeFactoryOptions) => TelegramBridgeHandle;
```

The prefix contains shared constants, the sanitized provider-error value object, and type contracts. The first execution wave immediately creates production acceptance, client, bridge, and controller owners.

---
### Task 0: Explicit AgentSession queue-acceptance result

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts:6211-6259`
- Modify test: `packages/coding-agent/test/agent-session-message-pipeline.test.ts:590-615`
- Forbidden: extension API return types and existing `sendUserMessage(...): Promise<void>` behavior.

**Interfaces:**

```ts
enqueueUserMessage(
	content: string | (TextContent | ImageContent)[],
	deliverAs: "steer" | "followUp",
): Promise<boolean>;
```

Fulfillment `true` means the user message was placed in the selected core queue. Fulfillment `false` means usage-aware preflight rejected before image normalization or any queue mutation. The promise settles on queue acceptance, never on model completion. Existing `sendUserMessage` keeps returning `Promise<void>` and delegates its explicit `deliverAs` branches to this method while discarding the boolean.

- [ ] **Step 1: Write RED acceptance tests**

Add behavior tests proving successful steer/follow-up return `true` with exactly one queued user message, and a rejected usage preflight returns `false` with both queues unchanged. Preserve the existing `sendUserMessage` test that resolves `undefined`.

- [ ] **Step 2: Verify RED**

```bash
bun test test/agent-session-message-pipeline.test.ts
```

Expected: FAIL because `enqueueUserMessage` does not exist.

- [ ] **Step 3: Implement the acceptance seam**

Reuse the existing normalization and `#queueUserMessage` path; do not duplicate it. Run preflight once, return `false` immediately on rejection, otherwise await queue mutation and return `true`. Refactor only the explicit steer/follow-up branches of `sendUserMessage` to call the new method.

- [ ] **Step 4: Verify GREEN**

```bash
bun test test/agent-session-message-pipeline.test.ts
```

Expected: new acceptance tests and all existing message-pipeline tests pass.

---


### Task 1: Telegram Bot API transport

**Files:**
- Create: `packages/coding-agent/src/telegram/client.ts`
- Test: `packages/coding-agent/test/telegram/telegram-client.test.ts`
- May consume only: `packages/coding-agent/src/telegram/types.ts`

**Interfaces:**
- Produces `TelegramBotClient implements TelegramBotClientContract`.
- Produces a local `TelegramApiError extends Error implements TelegramApiFailure`; every thrown boundary error has only those sanitized own fields and no raw `cause`.
- Production factory:

```ts
export function createTelegramBotClient(token: string): TelegramBotClient;
```

`createTelegramBotClient` pins `TELEGRAM_API_ORIGIN`, the default fetch, and the production timeout. The class constructor accepts injected `fetch`, `origin`, and timeout only for direct module tests and cross-owner harness composition; no environment/config path exposes them.

```ts
export interface TelegramBotClientOptions {
	token: string;
	fetch?: typeof globalThis.fetch;
	origin?: string;
	requestTimeoutMs?: number;
}

export class TelegramBotClient implements TelegramBotClientContract {
	constructor(options: TelegramBotClientOptions);
}
```

- [ ] **Step 1: Write RED transport contract tests**

Create table-driven tests using an injected fetch fake. Required mutations caught:

```ts
it("sends Bot API requests without exposing the token in returned errors", async () => {
	const client = new TelegramBotClient({ token: "123:secret", fetch: failingFetch });
	await expect(client.getMe()).rejects.toMatchObject({ method: "getMe", httpStatus: 401, ambiguous: false });
	await expect(client.getMe()).rejects.not.toThrow("123:secret");
});

it("maps retry_after seconds to milliseconds", async () => {
	// Bot API {ok:false,error_code:429,parameters:{retry_after:3}}
	await expect(client.getUpdates({ timeoutSeconds: 30, allowedUpdates: ["message"] })).rejects.toMatchObject({
		errorCode: 429,
		retryAfterMs: 3_000,
	});
});
```

Also cover: documented token grammar rejection before URL construction; allowlisted method names only; typed `getMe`; `getWebhookInfo`; `getUpdates` JSON body (`offset`, `limit`, `timeout`, `allowed_updates`); `sendMessage` sends `{chat_id,text}` with no `parse_mode`; HTTP error and HTTP-200 `{ok:false}` classification; malformed/non-JSON response; malformed/huge/negative `retry_after`; external abort; redirect rejection; client timeout; and `ambiguous:true` for every `sendMessage` failure after transmission may have begun. Run every failure with a sentinel token and assert it is absent from the error message, serialized own fields, stack, captured output, and nested values.

- [ ] **Step 2: Verify RED**

Run from `packages/coding-agent`:

```bash
bun test test/telegram/telegram-client.test.ts
```

Expected: FAIL because `telegram/client` and exports do not exist.

- [ ] **Step 3: Implement the narrow client**

Use UTF-8 JSON POST requests to `${origin}/bot${token}/${method}` with `redirect: "error"` and an allowlisted `TelegramMethod`. Validate token shape before URL construction, validate both HTTP status and Bot API `{ok,result,error_code,parameters}` envelope, cap `retry_after` to the shared five-minute budget, and validate minimal result fields at runtime. Catch and replace fetch, abort, timeout, TLS, redirect, JSON parse, body read, and response-validation errors at this boundary. Construct only the local `TelegramApiError implements TelegramApiFailure` from validated method/status/code/retry metadata—never expose the URL, token, raw description/body, headers, request object, or `cause`. Compose caller and timeout signals. Do not log in the transport; the handling bridge/controller logs once.

- [ ] **Step 4: Verify GREEN**

```bash
bun test test/telegram/telegram-client.test.ts
```

Expected: all transport success/error/timeout tests pass with no real network calls.

---

### Task 2: Session-scoped Telegram bridge

**Files:**
- Create: `packages/coding-agent/src/telegram/bridge.ts`
- Test: `packages/coding-agent/test/telegram/telegram-bridge.test.ts`
- May consume only: `packages/coding-agent/src/telegram/types.ts`, `packages/coding-agent/src/session/agent-session-events.ts`
- Forbidden: interactive-mode, slash registry, env/config, changelog.

**Interfaces:**
- Produces `TelegramBridge implements TelegramBridgeHandle` with constructor `constructor(options: TelegramBridgeOptions)`.
- `start()` settles only after `getMe`, webhook validation, `getUpdates(offset=-1, limit=1)`, connection `sendMessage`, session subscription, and one poll-loop launch.
- Each bridge instance serializes `off → starting → on → stopping → off`, owns an immutable generation fence/abort controller/listener/offset/FIFO, and checks liveness before and after every await, callback, queue mutation, HTTP start, and status mutation. `stop()` is idempotent and awaits abortable work; `dispose()` synchronously fences, unsubscribes, aborts, and logs no content.

- [ ] **Step 1: Write RED authorization and inbound tests**

Use a contract fake, not a real network. Required behavior examples:

```ts
it("delivers only the configured private chat and preserves update order", async () => {
	// Baseline update 40 is discarded. Live batch contains unauthorized 41,
	// authorized /queue 42, duplicate 42, and plain steer 43.
	// Assert session receives [{text:"later",deliverAs:"followUp"},
	//                          {text:"redirect",deliverAs:"steer"}].
	// Assert next getUpdates offset is 44.
});

it("silently rejects an identical id from a non-private chat", async () => {
	// chat.id matches but chat.type="group"; session and sendMessage remain unchanged.
});
```

Cover `/steer`, `/queue`, empty command usage, `/start`, `/help`, unsupported/media/update variants, unsafe/malformed `update_id`, unsafe/malformed `chat.id`, matching IDs in non-private chats, a batch of 100 unauthorized updates followed by an authorized update in the next poll, increasing-offset dedupe, and no concurrent `getUpdates` calls. A session acceptance result of `false` or a guaranteed-no-mutation rejection advances the cursor and queues a safe authorized-chat error instead of retrying or silently claiming acceptance.

- [ ] **Step 2: Write RED lifecycle/retry/output tests**

Cover:

- Active webhook refuses before activation/poller and never calls webhook mutation.
- HTTP and body-level 401/403/409/malformed protocol transitions to failed and stops.
- `getUpdates` timeout/5xx/429 retry with deterministic injected delay/random; validated 429 honors capped `retryAfterMs`; abort during backoff never retries.
- Only a terminal `agent_end` paired with an `agent_start` observed in the same live generation mirrors the last non-empty assistant text. Enabling mid-turn, `isTerminal:false`, tool-use/intermediate, notice, empty answer, and callbacks from a stopped generation are ignored.
- Unicode/emoji response splits without surrogate damage into ordered <=4,000-code-point plain chunks.
- Chunk a whole final before mutation; atomically enqueue all of its chunks or none. Test a >32-chunk final and insufficient remaining capacity: both fail closed with no partial enqueue, cross-final interleaving, drop, or reorder.
- `sendMessage` validated 429 retains the FIFO head but fails closed after 5 attempts or 5 cumulative minutes; ambiguous timeout/redirect/5xx/malformed response fails without retry.
- Concurrent start/stop, stop during poll, stop during send-429 backoff, reactivation, and dispose remove the listener, abort work, and prevent every old-generation side effect.

- [ ] **Step 3: Verify RED**

```bash
bun test test/telegram/telegram-bridge.test.ts
```

Expected: FAIL because `TelegramBridge` is missing.

- [ ] **Step 4: Implement bridge state machines**

Implement one poll task and one FIFO send task per generation. Establish activation with `getUpdates({ offset: -1, limit: 1, timeoutSeconds: 0, allowedUpdates: ["message"] })`; validate and discard its returned tail, then set `nextOffset` to that update ID plus one (or leave it undefined when empty). Sort every live batch by safe-integer `update_id`; skip IDs below `nextOffset`; advance every well-formed rejected/unsupported update so it cannot starve later work. For an authorized action, call `session.enqueueUserMessage`; on `true`, advance; on `false` or guaranteed-no-mutation rejection, advance and enqueue a safe error response. Malformed update IDs fail the generation because no acknowledgement cursor can be trusted. Authorization precedes command parsing and requires the explicit `update.message` shape, safe positive integer private chat ID, and exact immutable allowlist equality.

Subscribe only after activation. Track whether the generation observed `agent_start`; mirror a terminal `agent_end` only for an observed start, then reset. Chunk the complete final before queue mutation and atomically append all chunks only when the 32-slot capacity can hold them; otherwise fail before mutation. Do not correlate to Telegram-originated prompts: the approved product intentionally mirrors every terminal turn that starts while this single-chat bridge generation is enabled.

On polling failure, retry only idempotent `getUpdates` timeout/retryable transport/5xx/validated 429 with capped exponential backoff (base 250 ms, cap 30 s) and injected jitter. Stop on abort, auth/config errors, 409, malformed results, and other 4xx. For outbound sends, retain the FIFO head only for validated 429, with both attempt and cumulative-wait caps; ambiguous timeout/redirect/5xx/malformed outcomes fail without resend. All waits are abortable and every branch is generation-fenced.

- [ ] **Step 5: Verify GREEN**

```bash
bun test test/telegram/telegram-bridge.test.ts
```

Expected: all authorization, queue, retry, chunk, overflow, and lifecycle tests pass deterministically with zero sleeps and zero real network.

---

### Task 3: Telegram command controller and slash surface

**Files:**
- Create: `packages/coding-agent/src/modes/controllers/telegram-command-controller.ts`
- Modify: `packages/coding-agent/src/modes/types.ts:230-235,268-275,332-375`
- Modify: `packages/coding-agent/src/slash-commands/builtin-registry.ts:3467-3477`
- Test: `packages/coding-agent/test/modes/controllers/telegram-command-controller.test.ts`
- Modify test: `packages/coding-agent/test/available-commands.test.ts`
- Forbidden: `interactive-mode.ts`, real client/bridge imports, top-level `cli-commands.ts`, AgentSession internals, settings schema, generated files, changelog.

**Interfaces:**

```ts
export interface TelegramCommandControllerDeps {
	env: Record<string, string | undefined>;
	createBridge: CreateTelegramBridge;
}

export class TelegramCommandController {
	constructor(ctx: InteractiveModeContext, deps: TelegramCommandControllerDeps);
	get status(): TelegramBridgeStatus;
	handleCommand(action: string): Promise<void>;
	stop(): Promise<void>;
	dispose(): void;
}
```

Add to `InteractiveModeContext`:

```ts
handleTelegramCommand(action: string): Promise<void>;
```

- [ ] **Step 1: Write RED controller tests**

Required tests:

```ts
it("rejects every non-canonical chat id before constructing a bridge", async () => {
	// Table: missing, whitespace, 0, -1, +1, 1.0, 1e3, 001, 12x,
	// Number.MAX_SAFE_INTEGER + 1. createBridge must remain untouched.
});

it("serializes on/off/status and never renders secret or identifier values", async () => {
	// Concurrent on calls start once; off waits for start, stops once; later on
	// creates a fresh bridge. Captured status/error/logger fields contain no
	// token, URL, raw chat ID, inbound text, or model output.
});
```

Also cover missing token, unknown/empty action usage, bridge start failure, safe status mapping, stop during start, repeated off, and synchronous dispose fencing. Use an injected bridge factory only; this package must compile before real transport/bridge modules exist.

- [ ] **Step 2: Verify RED**

```bash
bun test test/modes/controllers/telegram-command-controller.test.ts
```

Expected: FAIL because the controller is missing.

- [ ] **Step 3: Implement serialized controller and slash metadata**

Mirror the ownership shape of `LiveCommandController` but keep composition injected:

- parse the chat ID only with `^[1-9][0-9]*$`, then require `Number.isSafeInteger` and `>0`; never permissively coerce;
- serialize lifecycle operations so concurrent `on`, `off`, and status callbacks cannot replace one another;
- use bridge identity checks so status from an old instance cannot render after replacement;
- add `/telegram` with declarative `on`, `off`, `status` subcommands and a TUI-only handler;
- clear the editor before handling and delegate to `runtime.ctx.handleTelegramCommand(action)`;
- user copy follows: `Telegram connected as @name.`, `Telegram is disconnected.`, `Telegram bridge stopped.`, and errors state failure + impact + next action;
- log once at the handling site with centralized `logger` and stable event names; no token, URL, chat ID, inbound text, or model output.

- [ ] **Step 4: Verify GREEN and registry reachability**

```bash
bun test test/modes/controllers/telegram-command-controller.test.ts test/available-commands.test.ts
```

Expected: controller matrix passes and `/telegram` appears exactly once in built-in command metadata.

---

### Task 4: Production composition and InteractiveMode lifecycle wiring

**Files:**
- Create: `packages/coding-agent/src/telegram/factory.ts`
- Modify: `packages/coding-agent/src/modes/interactive-mode.ts:184-188,648-650,896-899,1162-1165,4489-4495,4542-4548,5177-5184`
- Test: `packages/coding-agent/test/telegram/telegram-factory.test.ts`
- May consume production outputs from Tasks 0–3.
- Forbidden: slash registry, controller internals, AgentSession queue internals, settings schema, generated files, changelog.

**Interfaces:**

```ts
export const createTelegramBridge: CreateTelegramBridge;
```

The production factory alone composes `createTelegramBotClient(token)` with `TelegramBridge`; it exposes no configurable origin.

- [ ] **Step 1: Write RED production-composition test**

Assert the factory constructs a bridge with a client that uses the pinned official origin, refuses an invalid token before any fetch, and has no environment/config origin seam. Use an injected fetch only at the client module boundary; never source-grep.

- [ ] **Step 2: Verify RED**

```bash
bun test test/telegram/telegram-factory.test.ts
```

Expected: FAIL because the production factory and InteractiveMode ownership do not exist.

- [ ] **Step 3: Wire the production owner**

- instantiate `TelegramCommandController(this, { env: $env, createBridge: createTelegramBridge })` in `InteractiveMode`;
- stop it before session switch and in `#finishProcessExit`;
- dispose it in synchronous `stop()` teardown;
- delegate public `handleTelegramCommand(action)`;
- preserve existing live/collab ordering and cleanup; do not add another process-level signal handler;
- production composition must never accept a Bot API origin from environment, settings, command arguments, or Telegram payload.

- [ ] **Step 4: Verify wiring**

```bash
bun test test/telegram/telegram-factory.test.ts test/modes/controllers/telegram-command-controller.test.ts test/available-commands.test.ts
bun check
```

Expected: focused tests pass and `InteractiveMode` satisfies the extended context type without diagnostics.

---

### Task 5: Cross-owner integration through real bridge/client/controller

**Files:**
- Create: `packages/coding-agent/test/telegram/telegram-command-integration.test.ts`
- Read-only production files from Tasks 0–4.
- Test owner must not modify production code; return a concrete failure to the owning package if the locked contract is not met.

- [ ] **Step 1: Start a real local Bot API stub in the test**

Use `Bun.serve({ port: 0 })` with a fake token and capture method names/bodies. Implement documented responses for `getMe`, `getWebhookInfo`, `getUpdates(offset=-1,limit=1)`, live `getUpdates`, and `sendMessage`. Inject the loopback origin only through the direct test constructor `new TelegramBotClient({ origin })`; production composition remains pinned.

- [ ] **Step 2: Exercise success, authorization, ordering, and lifecycle**

Instantiate `TelegramCommandController` with real `TelegramBridge` + direct-test `TelegramBotClient`, a fake session implementing `enqueueUserMessage`/`subscribe`, and env containing the fake token/allowed chat. Call concurrent `handleCommand("on")`; deliver 100 unauthorized updates, then authorized `/queue` and steer updates; emit same-generation agent start/end; call `off` during a 429 backoff; reactivate; emit an old callback.

Assert externally observable state:

- one activation poller and one connection message;
- unauthorized/non-private/unsupported updates leave session input empty but do not starve later authorized work;
- `/queue build later` and plain `redirect now` reach follow-up/steer in update order and each update is accepted once;
- terminal answer chunks are plain, contiguous, ordered, and bounded;
- stop settles with no later old-generation update, output, HTTP request, or status mutation;
- reactivation starts a fresh generation and activation boundary.

- [ ] **Step 3: Exercise designed failures**

Table-drive active webhook, 409, session acceptance `false`, atomic queue overflow, repeated 429 exhaustion, ambiguous send timeout/5xx, malformed update ID, malformed Bot API envelope, and sentinel-token transport failures. Assert no session mutation on unauthorized/protocol failures, no retry storm, no webhook mutation, no partial final, and no secret/content leakage.

- [ ] **Step 4: Run integration test**

```bash
bun test test/telegram/telegram-command-integration.test.ts
```

Expected: success and adversarial failure flows pass against real HTTP serialization with only Telegram's external service stubbed.

---
## Locked execution wave plan

| Package | Owns | Needs | C/R | Tier | Wave | Acceptance |
|---|---|---|---|---|---:|---|
| P0 Queue acceptance | AgentSession method + message-pipeline test | shared signature | C | task | 1 | message-pipeline test |
| P1 Bot API client | client + client test | shared error/types | C | task | 1 | client test |
| P2 Bridge core | bridge + bridge test | shared contracts; fake client/session | C | heavy_task | 1 | bridge test |
| P3 Command surface | controller/types/registry + tests | shared factory/handle types | C | task | 1 | controller + available commands |
| P4 Production wiring | factory + InteractiveMode + factory test | P0–P3 working production | R | task | 2 | factory/controller tests + `bun check` |
| P5 Integration | cross-owner HTTP-stub test only | P0–P4 working production | R | tester | 3 | integration test |

P2 is the indivisible security/concurrency core after transport, AgentSession acceptance, command parsing, and production wiring are split off. Execute the entire table in one workflow: wave 1 parallel → wave 2 → wave 3 → focused union gate. Reviewer and QA remain final assurance, outside implementation waves.


## Final integration and assurance

- [ ] Run focused union tests:

```bash
bun test test/agent-session-message-pipeline.test.ts test/telegram/telegram-client.test.ts test/telegram/telegram-bridge.test.ts test/telegram/telegram-factory.test.ts test/telegram/telegram-command-integration.test.ts test/modes/controllers/telegram-command-controller.test.ts test/available-commands.test.ts
```

Expected: all new/modified behavior tests pass.

- [ ] Run package type/static gate:

```bash
bun check
```

from `packages/coding-agent`; expected exit 0 with no diagnostics.

- [ ] Build the worktree-local binary:

```bash
bun --cwd=packages/coding-agent run build
```

from repo root; expected `packages/coding-agent/dist/ompx` produced.

- [ ] Entry-point probe in a PTY using the worktree-local binary:

1. Launch `packages/coding-agent/dist/ompx` with Telegram variables absent.
2. Submit `/telegram status`; observe `Telegram is disconnected.`
3. Submit `/telegram on`; observe an exact missing-token corrective error and no crash/model prompt forwarding.
4. Exit cleanly and confirm process exit 0.

This proves installed command routing/lifecycle and the designed failure path. Real Telegram success is substituted by Task 5's local HTTP stub because no user token is available; report that boundary honestly.

- [ ] Independent security review: exact private-chat allowlist, secret redaction, no env base-origin override, retry/idempotency behavior, and teardown races.

- [ ] Independent QA: rerun focused tests and both the HTTP-stub success/failure harness and installed-binary PTY failure path.

- [ ] After runtime proof only, add one `### Added` entry under `packages/coding-agent/CHANGELOG.md` `[Unreleased]` describing the private Telegram steer/queue/final-answer bridge. Run the focused changelog/docs gate selected by repository scripts; do not modify released sections.

## Rollback and observability

Rollback is `/telegram off` at runtime or removal of the slash-command/controller wiring in code; no data/schema rollback exists. Watch for `telegram_bridge_failed`, repeated `telegram_poll_retry`, or any authorization-rejection anomaly. A reproducible unauthorized delivery, duplicate runtime update, unbounded queue, or token/content log leak blocks release.
