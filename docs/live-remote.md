# Live voice on a remote host

`/live` binds the microphone and the speaker to the machine that runs `ompx`. When
`ompx` runs on a remote host over SSH, that is the wrong machine: the call would
record the server's microphone, if it even has one.

Two deployments move the audio to you. Neither one sends audio bytes over SSH or
over the collab relay.

| | Mic and speaker | WebRTC call | Agent + credential |
|---|---|---|---|
| `/live` | host | host | host |
| SSH attach | your laptop | your laptop | remote host |
| Browser | your browser | your browser | remote host |

## SSH attach

On the remote host, inside the session you want to talk to:

```
/live remote
```

It prints the command to run on the machine that has your microphone:

```
ompx live --attach <host>:<sessionId>
```

That client spawns `ssh <host> ompx live-agent --session <sessionId>` and speaks
newline-delimited JSON over stdio. SSH provides authentication and transport —
there is no port to forward, no token, and no listening socket beyond a
`0600` unix socket at `~/.omp/run/live/<sessionId>.sock` on the host.

Requirements:

- `ompx` installed on both machines, with matching bridge protocol versions.
- Key or agent SSH authentication. The client runs `ssh -T`, so a host that
  demands an interactive password prompt fails fast instead of hanging.
- A Codex credential on the **client**, because the client places the realtime
  call. If it has none, sign in there with `ompx auth login`.

### Forwarding a credential

If the client cannot sign in, the host can hand it a short-lived Codex access
token over the SSH-authenticated pipe. It is off by default. Start the host side
with:

```
/live remote forward-credentials
```

and the client with `--forward-credentials`. Grants carry an expiry; the client
requests a new one when it lapses.

### What crosses the wire

Only text: a `delegate` frame carrying the spoken request, and `context` frames
carrying the agent's commentary and final answer. Phase and transcript are
mirrored to the host so its status line stays truthful.

If the client disconnects mid-turn, the host keeps running the agent turn — it is
a normal session turn and stays visible in the host's own transcript.

## Browser

Join the session's collab room with a full (write-capable) link and press
**Start voice**. The browser captures the microphone, builds a WebRTC offer, and
sends it to the host over the encrypted relay; the host signs it with its Codex
credential, opens the realtime call, and returns the answer. Audio then flows
directly between your browser and the realtime service.

- Read-only guests do not see the control.
- One call at a time per session; a second guest is refused with a message.
- The browser never receives a credential.

### Secure context

`getUserMedia` only works on a secure page: HTTPS, or `localhost`. The hosted
collab client is HTTPS and works as-is. A self-hosted relay must serve TLS —
plain `http://host:port` over a LAN or a Tailscale IP will not get microphone
permission, and the panel says so instead of failing silently.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/live` reports no input device | You are on a headless or SSH host; use `/live remote`. |
| `no live-enabled session is running on this host` | The host session was not started with `/live remote`. |
| `Live bridge version mismatch` | The two `ompx` installs differ; update the older one. |
| `The remote host did not answer the live bridge` | The remote shell printed to stdout before the helper ran; the captured banner is included in the error. |
| `Voice session access denied` (HTTP 403) | The Codex account is not entitled to live voice. This blocks the native path too. |
| Browser shows the HTTPS message | The page is not a secure context; see above. |
