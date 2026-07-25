# Live voice over SSH and browser — design

Date: 2026-07-25
Status: approved (B + C both in scope)

## Problem

`/live` binds both audio devices to the machine running `ompx`.

- Mic: `new AudioCapture(16_000, cb)` opens the **default input device of the ompx process**
  (`packages/coding-agent/src/live/controller.ts:176`, cpal in `crates/pi-natives/src/audio.rs:264`).
- Speaker: remote Opus is decoded and rendered to the default output device **inside Rust**
  (`LiveWebRtcPeer`, `packages/natives/native/index.d.ts:47-69`). JS only receives a level float
  (`transport.ts:164-170`), so there is no PCM-out seam at all.

Over SSH the ompx process runs on the server, so `/live` either fails (no device) or — worse, on a
workstation-class host like the one this was written on — records the *server's* microphone and
plays the assistant into the *server's* speakers. `/stt` and TTS have the same defect.

## What the feature actually is

A live session has three planes, currently fused in `LiveSessionController`:

| Plane | Owns | Today |
|---|---|---|
| Media | mic capture, WebRTC peer, Opus, speaker | native, in-process |
| Control | Codex signaling + `oai-events` sideband WS | in-process (holds Codex OAuth) |
| Agent | `AgentSession` delegation turn + context appends | in-process |

The Agent plane is already pure text: `delegation.created` → `sendCustomMessage(LIVE_DELEGATION_MESSAGE_TYPE)`
(`controller.ts:294-315`); results return through `buildDelegationContextAppend`
(`controller.ts:326-352`). Nothing about it needs to be co-located with the audio devices.

## Design

Introduce two endpoint interfaces so the same `LiveSessionController` supports three deployments.

```
                LOCAL (today)         B: SSH client            C: browser
media plane     native, local         native, on laptop        browser WebRTC
control plane   local                 on laptop                on host
agent plane     local                 on remote host           on host
crosses wire    —                     agent plane (text)       signaling + UI (text)
audio on wire   —                     none                     none
```

B and C are mirror images: B moves the **agent** away from the audio, C moves the **audio** away
from the agent. Both are served by the same seam pair.

### Contract — `packages/coding-agent/src/live/endpoints.ts` (new)

```ts
/** Media side of a live call: owns the WebRTC peer and the local audio devices. */
export interface LiveMediaEndpoint {
	/** Create the peer and return its SDP offer. */
	createOffer(): Promise<string>;
	/** Apply the SDP answer returned by Codex signaling. */
	acceptAnswer(sdp: string): Promise<void>;
	/** Resolve once the media path is usable. */
	waitForOpen(timeoutMs?: number): Promise<void>;
	/** Enable/disable microphone transmission. */
	setMuted(muted: boolean): Promise<void>;
	/** Assistant output level, 0..1, for the visualizer. */
	onOutputLevel(handler: (level: number) => void): void;
	/** Fatal media failure. */
	onFailure(handler: (message: string) => void): void;
	close(): Promise<void>;
}

/** Agent side of a live call: runs delegated coding requests. */
export interface LiveAgentEndpoint {
	/** Run one delegated request; resolves when the agent turn is terminal. */
	startDelegation(id: string, request: string): void;
	/** Streamed agent output for an in-flight delegation. */
	onContext(handler: (delegationId: string, text: string, kind?: "commentary") => void): void;
	/** The delegation finished; the media side may return to listening. */
	onDelegationEnd(handler: (delegationId: string) => void): void;
	close(): Promise<void>;
}
```

`LocalMediaEndpoint` wraps today's `AudioCapture` + `CodexLiveTransport` peer path, including the
echo gate (`OUTPUT_ACTIVE_LEVEL` / `MIN_BARGE_IN_LEVEL` / `OUTPUT_ECHO_RATIO`, `controller.ts:365-369`),
unchanged. `LocalAgentEndpoint` wraps today's `AgentSession` path, unchanged. Default `/live`
behaviour must be byte-identical after the refactor.

### Machine-identity leaks the seams must close

Two pieces of the controller read the LOCAL process and would silently describe the wrong machine
once a plane moves:

1. `currentUser()` (`controller.ts:78-88`, `os.userInfo()`) feeds `{{firstName}}`/`{{username}}` into
   `live-instructions.md:1`, and `session.sessionId` is sent to Codex as `x-session-id` /
   scoped-session / thread id (`transport.ts:79-99`). In B both are produced on the laptop but must
   describe the **remote** agent host. The bridge `welcome` frame therefore carries `sessionId`,
   `username`, `firstName` and `cwd`, and the client renders instructions and signaling headers from
   those, never from its own `os.userInfo()`.
2. The phase machine (`#refreshAudioPhase`, `controller.ts:451-462`) needs the assistant output level,
   which in C lives in the browser. The browser reports it with a throttled `live-level` guest frame
   (~10/s) so the host TUI visualizer stays correct.

### B — SSH bridge (agent plane crosses the wire)

The laptop runs the whole media + control plane natively (zero added audio latency, native Opus,
native echo gate). Only text delegation crosses SSH.

- Remote (server) side: when a live session is requested on a host with no usable input device, or
  when the user runs `/live --remote`, the interactive session starts `LiveAgentServer` on a unix
  socket at `~/.omp/run/live/<sessionId>.sock` (mode 0600) and prints the exact laptop command.
- Client side: `ompx live --attach <ssh-target>[:<sessionId>]` spawns
  `ssh <target> ompx live-agent --session <id|latest>` and speaks newline-delimited JSON over
  stdio. SSH provides authentication and transport; there is no port, no token, no TLS.
- `ompx live-agent --session <id>` is a ~50-line stdio↔unix-socket pump inside the same binary.
- The client renders the existing `LiveVisualizer` plus transcripts; the remote TUI keeps rendering
  the delegation as the usual `live-delegation` custom message.

Bridge frames (newline-delimited JSON, client → server / server → client):

```ts
type LiveBridgeClientFrame =
	| { t: "hello"; proto: 1; sessionId?: string }
	| { t: "delegate"; id: string; text: string }
	| { t: "phase"; phase: LivePhase }
	| { t: "transcript"; role: "user" | "assistant"; turn: number; text: string; final: boolean }
	| { t: "auth-request" }
	| { t: "bye" };

type LiveBridgeServerFrame =
	| { t: "welcome"; proto: 1; sessionId: string; cwd: string; username: string; firstName: string; title?: string }
	| { t: "context"; delegationId: string; text: string; kind?: "commentary" }
	| { t: "delegation-end"; delegationId: string }
	| { t: "auth-grant"; accessToken: string; accountId?: string; expiresAt: number }
	| { t: "error"; message: string };
```

Credentials: the client uses its own Codex OAuth by default. If absent it fails with instructions,
unless the host opts in (`live.allowCredentialForward`, default `false`), in which case
`auth-request` → `auth-grant` forwards a short-lived access token over the SSH-authenticated pipe.

Bridge robustness (each is a required behaviour, not a nicety):

- **stdout pollution.** Remote shell rc files and banners can print on stdout before our helper runs.
  The client discards every line until the first line that parses as JSON with `t === "welcome"`, and
  fails with the captured preamble if none arrives within 10s.
- **No tty.** `ssh` is spawned with `-T`; password-only hosts fail fast with ssh's own stderr shown.
  Key or agent auth is the documented requirement.
- **Version skew.** `hello.proto` / `welcome.proto` must match exactly; mismatch produces
  `error` naming both versions, never a silent partial session.
- **Half-open pipes.** Remote helper: stdin EOF → close socket → exit 0. Client: stdout EOF or ssh
  non-zero exit → end the live session with the ssh stderr tail as the reason.
- **Client disconnect mid-turn.** The server keeps the running agent turn (it is a normal session
  turn, visible in the remote TUI) and stops streaming context. It does not abort the user's work.
- **Stale socket.** Bind unlinks a dead socket; a socket whose peer refuses connection is reported as
  "session no longer live" with the list of live sessions.

### C — browser client (media plane crosses the wire)

Reuses the existing collab room: E2E-encrypted relay (`wss://my.omp.sh`), existing browser client
`packages/collab-web`, existing room key + write-token model. The browser holds mic and speaker;
the host keeps Codex OAuth, signaling, the sideband, and the agent.

Flow:
1. Browser (write-capable guest) creates an `RTCPeerConnection` with one sendrecv Opus audio track
   from `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })` **and one data
   channel named `oai-events`**, mirroring the native offer shape.
2. Browser sends `live-offer` over the relay.
3. Host signs and POSTs the offer through the existing `CodexLiveTransport` signaling path
   (`transport.ts:201-234`), opens the sideband, returns `live-answer`.
4. Media flows browser ↔ OpenAI directly. Control flows host ↔ OpenAI (sideband) and host ↔ browser
   (relay). **No audio bytes ever traverse the relay.**
5. Delegation runs entirely on the host, exactly as today. Phase and transcript are mirrored to the
   browser for its visualizer.

New wire frames in `packages/wire/src/index.ts`, `COLLAB_PROTO` 3 → 4:

```ts
// GuestFrame additions
| { t: "live-offer"; reqId: number; sdp: string }
| { t: "live-mute"; muted: boolean }
| { t: "live-stop" }

// HostFrame additions
| { t: "live-answer"; reqId: number; sdp?: string; error?: string }
| { t: "live-phase"; phase: LivePhase }
| { t: "live-transcript"; role: "user" | "assistant"; turn: number; text: string; final: boolean }
| { t: "live-ended"; reason?: string }
```

Read-only guests are rejected on `live-offer` through the existing write-token check
(`collab/host.ts` `#verifyWriteToken`). Only one live guest at a time; a second `live-offer` is
answered with `error: "a live session is already active"`.

Secure context: the browser needs HTTPS or `localhost` for `getUserMedia`. `https://my.omp.sh`
satisfies it. A self-hosted relay must be TLS; plain `http://host:port` over a LAN or Tailscale IP
will not get microphone permission — documented, not worked around.

## Risks

- **R1 (blocks C):** the Codex realtime endpoint may reject a browser-generated SDP offer. It is a
  private ChatGPT-desktop endpoint and the native offer is the only shape known to work. Mitigation:
  a headless-Chrome spike POSTs a browser offer through the real signaling path before any UI work.
  If it fails, C falls back to browser→host PCM over the relay feeding the native peer, which
  additionally requires a Rust change (`LiveWebRtcPeer` PCM-out callback + local playback off). That
  fallback is *not* built unless the spike fails.
- **R2:** forwarded access tokens expire mid-call. Grants carry `expiresAt`; the client re-requests.
- **R3:** a stale unix socket from a crashed session. The server unlinks on bind and on exit; the
  client reports a dead socket instead of hanging.
- **R4:** proto bump to 4 breaks older guests. Existing `hello` proto check already rejects
  mismatches with a clear message (`collab/host.ts`); browser client and CLI ship together.

## Non-goals

- Moving PCM over SSH (option A). Rejected: needs a Rust change, adds two SSH round-trips to a
  realtime path, and TCP head-of-line blocking degrades under load.
- Fixing `/stt` and TTS over SSH. Same root cause, separate change.
- Multi-listener / multi-mic sessions.

## Acceptance

Each criterion is a command someone can run in this repo.

1. **No regression.** On a host with audio: `bun --cwd=packages/coding-agent test test/live/` passes,
   and a manual `/live` session in the built binary (`dist/ompx`) completes one spoken request with
   tool use — phases `listening → working → speaking` observed in the visualizer.
2. **R1 spike (gates C).** `bun --cwd=packages/coding-agent run scripts/spike-browser-sdp.ts` drives
   headless Chrome with `--use-fake-device-for-media-stream`, builds an offer with one sendrecv audio
   track plus an `oai-events` data channel, POSTs it through the real signaling path, and prints the
   HTTP status, the `Location` call id, and the first 200 chars of the SDP answer. Pass = HTTP 2xx
   with an `rtc_*` id.
3. **B end to end.** On this box (which has both a mic and sshd): terminal 1 runs the built binary and
   `/live --remote`, printing the attach command; terminal 2 runs
   `ompx live --attach localhost:<sessionId>`. Speaking "list the files in this repo" produces a
   `live-delegation` entry in terminal 1's transcript, tool execution on the remote session, and the
   spoken answer on the local speaker. Evidence: both transcripts plus the bridge frame log.
4. **C end to end.** `bun --cwd=packages/collab-web run dev` against `scripts/local-relay.ts`, host
   started with `/collab` pointed at the local relay, browser driven with a fake media device: the
   voice panel reaches `listening`, a spoken request produces a delegation on the host, and the
   answer audio arrives on the browser peer (assert on `RTCInboundRtpStreamStats.bytesReceived > 0`
   for the audio track, plus the transcript frames).
5. **Guidance path.** With input devices hidden, `/live` prints the attach instructions and exits
   cleanly instead of surfacing a cpal device error.
