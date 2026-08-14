# Herdr ↔ ompx integration

`ompx` already reports native agent state and can accept lossless control-socket prompts inside a Herdr pane. Herdr must add an `ompx` agent kind (and broaden its existing `omp` process matching) so named-agent ownership and control survive the fork's `ompx` process identity.

## Problem

On this machine with herdr 0.7.5:

```sh
$ herdr agent start testx --kind omp --pane w6545f72d8f6a4c:pQ --timeout 20000
{"result":{"agent":{"agent":"omp","agent_status":"idle","interactive_ready":true,"name":"testx",...},"argv":["omp"],"type":"agent_started"}}

$ herdr agent prompt testx "hello from herdr control test"
{"error":{"code":"agent_not_ready","message":"agent testx is no longer the pane foreground process"},"id":"cli:agent:prompt"}

$ herdr agent send-keys testx esc
{"error":{"code":"agent_not_ready","message":"agent testx is not an active named agent"},"id":"cli:agent:send-keys"}

$ herdr pane process-info --pane w6545f72d8f6a4c:pQ
"foreground_processes":[{"argv":["ompx"],"cmdline":"ompx","name":"ompx","pid":3571049}]
```

`herdr agent start --kind omp` types `omp`; this machine aliases it to `ompx`, but Herdr's `omp` kind requires foreground process name `omp` and therefore disowns the named agent.

## Which side owns what

| Capability | ompx side | Herdr side | Status |
| --- | --- | --- | --- |
| Native state reporting | Reports `working`, `blocked`, and `idle` over the Herdr socket | Consumes `pane.report_agent` | shipped here |
| Named-agent ownership | Ships an `omp`-named entrypoint (`ompx herdr install`) so `comm` reads `omp` | Matches foreground process identity | shipped here |
| Native agent kind | Exposes process identity and reporter markers | Adds `ompx` enum kind and detection | needs herdr change |
| Prompt delivery | Serves a session control socket and `ompx prompt` CLI | Uses `session.prompt` before keystrokes | shipped here |
| Turn metadata and notifications | Reports metadata/session and sends configured notifications | Renders metadata and delivery toasts | works |

## ompx side (shipped)

### Native status reporter

`packages/coding-agent/src/extensibility/extensions/herdr-agent-state.ts` reports with source-id prefix `herdr:omp`, agent label `omp`, and state values `working`, `blocked`, or `idle`.

It enables automatically only when all of the following are present:

```sh
HERDR_ENV=1
HERDR_SOCKET_PATH
HERDR_PANE_ID
```

Herdr also exports these pane values for metadata and control correlation:

```sh
HERDR_TAB_ID
HERDR_WORKSPACE_ID
```

Disable the native reporter with:

```sh
OMP_NATIVE_HERDR_AGENT_STATE=0
```

### `omp`-named entrypoint

Herdr's `omp` kind validates the pane's **foreground process name** (`argv[0]` / cmdline — see the `process-info` output below), not the agent label reported over the socket. `process.title` cannot satisfy it: Bun's setter changes only the JS-visible value, leaving `/proc/<pid>/comm` and the cmdline as `ompx` (verified — `bun -e 'process.title="omp"'` leaves `comm=bun`). What the kernel does honour is the name the binary was exec'd through, so ompx ships an opt-in `omp`-named symlink beside the installed executable:

```sh
ompx herdr status      # show the entrypoint state, plus any shadowing shell alias
ompx herdr install     # symlink <dir-of-ompx>/omp -> ompx   (--force to replace, --dir/--target to override)
ompx herdr uninstall   # remove it again (only when it points at ompx)
```

It is opt-in because the `omp` name is shared with upstream `omp`; `install` refuses to clobber an unrelated binary unless `--force` is passed.

A shell `alias omp=ompx` **defeats this**: an interactive shell expands the alias before the PATH lookup, so `herdr agent start --kind omp` launches `ompx` again and `comm` reverts to `ompx`. `ompx herdr status` scans `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` and `~/.profile` and warns when it finds one. Remove the alias and let the entrypoint resolve.

**Updates do not need a reinstall.** The link resolves by path, and every update route replaces the file it points at rather than the link itself: `scripts/install.sh` does `mv <tmp> $INSTALL_DIR/ompx`, and `ompx update` resolves its swap target with `$which("ompx")` (`src/cli/update-cli.ts:resolveOmpPath`), so `omp update` still rewrites `ompx`. The link only goes stale when the binary lands in a *different* directory — switching `PI_INSTALL_DIR`, or moving from the binary install to `--source` (`bun install -g` puts `ompx` in the bun global bin). The installer repoints an existing link for exactly that case; recover manually with `ompx herdr install --force`.

Verified on herdr 0.7.5 with the entrypoint in place:

```
$ herdr pane process-info --pane w6545f72d8f6a4c:pR
"foreground_processes":[{"argv":["omp"],"cmdline":"omp","name":"omp","pid":3944932}]

$ herdr agent prompt ompxtest "say exactly: HERDR-CONTROL-OK"
{"id":"cli:agent:prompt","result":{"agent":{...,"name":"ompxtest"},"type":"agent_prompted"}}

$ herdr agent send-keys ompxtest esc
{"id":"cli:agent:send-keys","result":{"type":"ok"}}
```

No herdr-side change is required for this path.

### Control socket and `ompx prompt`

Each running session serves a Unix socket and writes its descriptor:

```sh
# ~/.omp/run/control/<sessionId>.sock
# ~/.omp/run/control/<sessionId>.json
```

The descriptor shape is:

```json
{"version":1,"sessionId":"...","pid":12345,"socket":"~/.omp/run/control/<sessionId>.sock","cwd":"...","startedAt":"...","paneId":"...","tabId":"...","workspaceId":"..."}
```

Requests are newline-delimited JSON:

```json
{"v":1,"id":"...","method":"session.prompt","params":{"text":"...","deliverAs":"steer","requireIdle":false}}
```

`deliverAs` is `steer` or `followUp`; `requireIdle` is a boolean. A successful reply is:

```json
{"v":1,"id":"...","result":{"accepted":true,"mode":"turn","sessionId":"..."}}
```

Errors use one of `busy`, `invalid_params`, `unknown_method`, or `internal`:

```json
{"error":{"code":"busy","message":"..."}}
```

The additional methods are `session.ping` and `session.status`.

```sh
# ompx prompt [text|-] [--pane ID] [--session ID] [--cwd PATH] [--socket PATH] [--file PATH] [--steer|--follow-up] [--require-idle] [--timeout MS] [--json] [--list]
```

Exit codes are `0` accepted, `2` usage, `3` no or ambiguous session, `4` busy, and `5` transport.

Send a multi-line prompt through the current pane's session:

```sh
ompx prompt --pane "$HERDR_PANE_ID" - <<'PROMPT'
Review the current change.
Keep leading /commands literal and preserve Unicode: café.
PROMPT
```

### Configuration

The ompx configuration keys are:

```sh
# herdr.notify.done
# herdr.notify.blocked
# herdr.notify.sound
# herdr.notify.minWorkMs
# herdr.metadata.enabled
```

### Per-turn metadata

Each turn reports the current task as the pane title, `display_agent`, token fields `model`, `ctx`, and `cost`, plus `pane.report_agent_session` with the ompx session id and transcript path. Metadata has a TTL so stale fields expire.

## Herdr side: add an `ompx` kind

Add a compiled integration id `ompx` with canonical executable `ompx`. Its acceptable foreground-process names are the set:

```json
["ompx", "omp"]
```

Use these detection markers when correlating native reports:

```json
{"env":"HERDR_ENV","reporter_source_prefix":"herdr:omp","reported_agent":"omp"}
```

The existing `omp` kind should accept `ompx` as an alias executable so existing panes continue to work. Named-agent foreground validation must compare the observed process name against a set of acceptable names, not against one literal process name.

For an active ompx session, Herdr should prefer the control socket over synthetic keystrokes. Discover the descriptor at `~/.omp/run/control/<sessionId>.json`, then write to `~/.omp/run/control/<sessionId>.sock`. This preserves multi-line text, Unicode, and leading-slash text without terminal encoding or shell interpretation.

```json
{"v":1,"id":"herdr:prompt:<request-id>","method":"session.prompt","params":{"text":"hello from Herdr","deliverAs":"steer","requireIdle":false}}
```

Read the newline-delimited reply and treat `result.accepted: true` as delivery success. Retain keystroke injection only as the fallback when no matching control descriptor/socket is available.

Nothing must be installed for the control socket: ompx serves it for every running session. Do not assume `~/.omp/agent/extensions/herdr-omp-agent-state.ts` is present or active; ompx does not use that managed `omp` extension because it has a native reporter.

## Verification

Start the named agent and verify it remains controllable:

```sh
herdr agent start testx --kind ompx --pane "$HERDR_PANE_ID" --timeout 20000
herdr agent prompt testx "hello from herdr control test"
```

List discoverable ompx control sessions:

```sh
ompx prompt --list
```

Deliver a multi-line prompt through the control socket:

```sh
ompx prompt --pane "$HERDR_PANE_ID" - <<'PROMPT'
Line one.
Line two with Unicode: café.
PROMPT
```

Enable Herdr toast delivery, reload its configuration, then complete or block an ompx turn:

```toml
[ui.toast]
delivery = "herdr"
```

```sh
herdr server reload-config
```

Confirm metadata and session correlation from the pane after a turn:

```sh
herdr pane process-info --pane "$HERDR_PANE_ID"
```

## Limitations

- Control through herdr's existing `omp` kind requires the `omp` entrypoint (`ompx herdr install`) and no shadowing shell alias, until herdr ships a native `ompx` kind.
- `herdr agent prompt` still uses keystrokes on the Herdr side until it adopts `session.prompt`.
- Notifications are off by default (`herdr.notify.done` / `herdr.notify.blocked`), and herdr itself must have toast delivery enabled: `[ui.toast] delivery = "herdr"` in `~/.config/herdr/config.toml`, then `herdr server reload-config`. Without it `notification.show` answers `{"shown":false,"reason":"disabled"}`.
- `pane.report_agent_session` is accepted (`{"type":"ok"}`) but herdr surfaces `agent_session` on the **agent** view, not the pane view, so the session id/transcript path only becomes visible once the pane is a named agent (`herdr agent start`). The same ids also ride on every `pane.report_agent` state report.
- Set `HERDR_CONTROL_SOCKET=0` to disable the per-session control socket (no external prompt delivery for that session).
