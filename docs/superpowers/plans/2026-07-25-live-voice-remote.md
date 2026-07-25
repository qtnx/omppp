# Live Voice Over SSH and Browser — Implementation Plan

> **For agentic workers:** implement task-by-task. Each task is dispatched to a fresh subagent with the
> contract below pasted into its assignment.

**Goal:** Let `/live` run with the microphone and speaker on the user's own machine while `ompx` and the
coding agent run on a remote host — either through an SSH-attached laptop client (B) or through a
browser joined to the collab room (C).

**Architecture:** `LiveSessionController` is split into two swappable endpoints — `LiveMediaEndpoint`
(WebRTC peer + audio devices) and `LiveAgentEndpoint` (delegated agent turns). B moves the agent
endpoint across an SSH stdio bridge; C moves the media endpoint across the existing E2E-encrypted
collab relay. No audio bytes cross either wire.

**Tech Stack:** Bun, TypeScript, napi-rs natives (`AudioCapture`, `LiveWebRtcPeer`), WebRTC, React
(`packages/collab-web`), AES-GCM collab relay.

**Spec:** `docs/superpowers/specs/2026-07-25-live-voice-remote-design.md` — the locked contract.

## Global Constraints

- `AGENTS.md` rules apply everywhere: no `any`, no `ReturnType<>`, no inline/dynamic imports, `#private`
  fields, `Promise.withResolvers()`, prompts in `.md` files imported `with { type: "text" }`, Bun APIs
  over node, `logger` never `console`.
- Typecheck is `bun check` from the repo root. Never `tsc`.
- `packages/wire` stays dependency-free; it never imports from the coding agent.
- Local `/live` behaviour must remain byte-identical through the whole plan.
- No commits from task workers; the parent integrates.

## File Structure

| File | Responsibility |
|---|---|
| `src/live/endpoints.ts` (new) | `LiveMediaEndpoint`, `LiveAgentEndpoint`, `LiveAgentIdentity` |
| `src/live/local-endpoints.ts` (new) | native mic + peer media endpoint; `AgentSession` agent endpoint |
| `src/live/controller.ts` | orchestration only: phases, mute, transcripts, delegation state |
| `src/live/transport.ts` | signaling + sideband; drives an injected media endpoint |
| `src/live/bridge-protocol.ts` (new) | SSH bridge frames + NDJSON decoder tolerant of shell banners |
| `src/live/bridge-server.ts` (new) | unix socket server exposing the session's agent plane |
| `src/live/bridge-agent-endpoint.ts` (new) | client-side `LiveAgentEndpoint` speaking the bridge |
| `src/live/relay-media-endpoint.ts` (new) | host-side `LiveMediaEndpoint` backed by a browser peer |
| `src/commands/live.ts` (new) | `ompx live --attach <target>` client mode |
| `src/commands/live-agent.ts` (new) | `ompx live-agent --session <id>` stdio↔socket pump |
| `src/collab/host.ts` | `live-*` frame handlers |
| `packages/wire/src/index.ts` | `live-*` frames, `COLLAB_PROTO` 4 |
| `packages/collab-web/src/components/live/**` (new) | browser voice panel |
| `packages/collab-web/src/lib/live-peer.ts` (new) | browser `RTCPeerConnection` lifecycle |

## Wave 1 — seams and contracts (dispatched)

- **Task 1 `CoreSeams`** — extract `endpoints.ts` + `local-endpoints.ts`, inject the media endpoint into
  `CodexLiveTransport`, move identity (`sessionId`, `username`, `firstName`, `cwd`) into
  `LiveAgentIdentity`, add the no-input-device guidance path. Acceptance: `bun check`;
  `bun --cwd=packages/coding-agent test test/live/`; a real `/live` run from `dist/ompx`.
- **Task 2 `BridgeProtocol`** — `bridge-protocol.ts` + tests: frame unions, `encodeBridgeFrame`,
  `BridgeFrameDecoder` (partial lines, multi-frame chunks, banner preamble skipping, 1 MB guard),
  type guards.
- **Task 3 `WireLiveFrames`** — wire frame additions, `LivePhase` restated in wire, `COLLAB_PROTO` 4,
  changelog, test fallout.
- **Task 4 `SpikeBrowserSDP`** — go/no-go for C: does Codex signaling accept a Chrome-generated offer
  carrying one sendrecv Opus track plus an `oai-events` data channel?

## Wave 2 — B, the SSH bridge

### Task 5: Bridge server (remote side)

**Files:** create `src/live/bridge-server.ts`, `test/live/bridge-server.test.ts`; modify
`src/modes/controllers/live-command-controller.ts` (start/stop the server for `/live --remote`).

**Interfaces:**
- Consumes: `LiveAgentEndpoint`, `LiveAgentIdentity` (Task 1); `bridge-protocol.ts` (Task 2).
- Produces:
  ```ts
  export interface LiveBridgeServerOptions {
      session: AgentSession;
      identity: LiveAgentIdentity;
      allowCredentialForward: boolean;
      onPeerChange?(connected: boolean): void;
  }
  export class LiveBridgeServer {
      constructor(options: LiveBridgeServerOptions);
      /** Bind `~/.omp/run/live/<sessionId>.sock` (0600) and return its path. */
      start(): Promise<string>;
      readonly socketPath: string | undefined;
      stop(): Promise<void>;
  }
  ```

Behaviour: one peer at a time; `hello` proto mismatch → `error` frame naming both versions, then close.
On `delegate`, run the local `LiveAgentEndpoint` and stream `context` / `delegation-end` back. On peer
disconnect, keep any running agent turn alive and stop streaming. `auth-request` is answered with
`auth-grant` only when `allowCredentialForward` is true, otherwise an `error` naming the setting.
Bind unlinks a stale socket file; `stop()` unlinks and is idempotent.

### Task 6: `ompx live-agent` stdio pump (remote side)

**Files:** create `src/commands/live-agent.ts`, `test/commands/live-agent.test.ts`; modify
`src/cli-commands.ts` (register).

Resolves `--session <id>` or `latest` against `~/.omp/run/live/*.sock`, connects, and pumps bytes both
ways until either end closes. Writes nothing but frames to stdout — diagnostics go to stderr. Exits 0 on
clean EOF, non-zero with a one-line stderr reason when the socket is missing or dead. Ambiguous
`latest` with several sockets lists them on stderr and exits non-zero.

### Task 7: `ompx live --attach` client mode (laptop side)

**Files:** create `src/commands/live.ts`, `src/live/bridge-agent-endpoint.ts`,
`test/live/bridge-agent-endpoint.test.ts`; modify `src/cli-commands.ts`.

Spawns `ssh -T <target> ompx live-agent --session <id|latest>`, discards preamble until `welcome`
(10 s cap, failing with the captured banner), then composes the normal live stack with
`LocalMediaEndpoint` + `BridgeAgentEndpoint` and the identity taken from `welcome`. Renders the existing
`LiveVisualizer` and transcripts. Uses local Codex OAuth; when absent, prints how to log in and mentions
`--forward-credentials`, which triggers `auth-request`.

## Wave 3 — C, the browser client

### Task 8: Host-side relay media endpoint

**Files:** create `src/live/relay-media-endpoint.ts`, `test/live/relay-media-endpoint.test.ts`; modify
`src/collab/host.ts`.

`RelayMediaEndpoint` implements `LiveMediaEndpoint` where `createOffer()` resolves with the SDP the
browser sent in `live-offer`, `acceptAnswer(sdp)` replies `live-answer`, `waitForOpen()` resolves when
the browser reports its peer connected, `setMuted` sends `live-mute`, and `onOutputLevel` is fed by
`live-level`. Host rejects `live-offer` from read-only peers and from a second peer while a session is
active. `live-stop`, peer-left, and room close all tear the session down and emit `live-ended`.

### Task 9: Browser voice panel

**Files:** create `packages/collab-web/src/lib/live-peer.ts`,
`packages/collab-web/src/components/live/LivePanel.tsx` (+ css), tests under
`packages/collab-web/test/`; modify `src/lib/client.ts` (send/receive `live-*`), `src/app.tsx`,
`src/components/shell/HeaderBar.tsx` (entry point).

`getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`, one sendrecv track, a
data channel named `oai-events`, offer → `live-offer` → `live-answer` → `setRemoteDescription`, remote
track attached to an `<audio autoplay>` element, an `AnalyserNode` driving both the local visualizer and
the throttled `live-level` frames (10 Hz). Mic and stop buttons; transcript from `live-transcript`;
phase chip from `live-phase`. Hidden for read-only guests. Every failure path (permission denied, no
secure context, `live-answer` error, peer failure) renders an explicit message.

## Wave 4 — integration

- `docs/live-remote.md`: both workflows, the secure-context rule, the credential-forwarding setting,
  troubleshooting (no device, stale socket, proto mismatch).
- `packages/coding-agent/CHANGELOG.md`, `packages/wire/CHANGELOG.md`, `packages/collab-web/CHANGELOG.md`
  under `## [Unreleased]`.
- Gates: `bun check`; `bun --cwd=packages/coding-agent test test/live/ test/collab/`;
  `bun --cwd=packages/wire test`; `bun --cwd=packages/collab-web test`; build the binary and run the
  five acceptance criteria from the spec.
