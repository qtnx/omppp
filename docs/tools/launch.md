# launch

> Start and supervise project-scoped long-running processes shared by OMPx sessions in the same directory.

## Source
- Entry: `packages/coding-agent/src/tools/launch.ts`
- Prompt: `packages/coding-agent/src/prompts/tools/launch.md`
- Broker protocol: `packages/coding-agent/src/launch/protocol.ts`

## Operations

| `op` | Required fields | Behavior |
| --- | --- | --- |
| `start` | `name`, `application` | Starts `application` with `args`; records a reusable launch specification. |
| `list` | — | Lists managed processes in the current project scope. |
| `logs` | `name` | Returns captured output. |
| `wait` | `name` | Waits for lifecycle state or an output pattern. |
| `send` | `name` | Writes terminal input and/or sends a process-tree signal. |
| `stop` | `name` | Gracefully stops the process tree, then hard-kills if necessary. |
| `restart` | `name` | Restarts using the retained specification. |
| `describe` | `name` | Returns the retained specification and live state. |

Names are unique within a project directory. A completed name may be started again; a live name must be stopped or restarted.

## Start parameters

```json
{
  "op": "start",
  "name": "web",
  "application": "bun",
  "args": ["run", "dev"],
  "ready": { "log": "Local:.*http", "port": 5173, "timeout": 30 }
}
```

| Field | Description |
| --- | --- |
| `application`, `args` | Executable path and direct argv; no shell parsing occurs. |
| `env` | Extra environment variables. |
| `cwd` | Working directory; defaults to the session directory. |
| `pty` | Allocates a PTY; defaults to `true`. |
| `ready.log` | Output regular expression. |
| `ready.port` | TCP port to probe; must be an integer from `1` through `65535`. |
| `ready.host` | Probe host; defaults to `127.0.0.1`. |
| `ready.timeout` | Readiness deadline in seconds; defaults to `30`. |
| `restart` | `"no"` (default), `"on-failure"`, or `"always"`. |
| `persist` | Keeps the process after the last OMPx client exits; defaults to `false`. |
| `detached` | Survives broker shutdown and all OMPx exits; implies `persist` and disables PTY input. |

A `ready` object requires `log` or `port`. When both are supplied, both must pass. A readiness timeout leaves the process running so callers can inspect logs or stop it.

## Logs, waiting, and input

- `logs` defaults to the last `100` lines; `lines` is capped at `1000`. Set `head: true` to read from the beginning and `grep` to filter with a regular expression.
- `logs` with `follow: true` waits for output newer than `cursor`; reuse the returned cursor for the next call. `timeout` is seconds and defaults to `30`.
- `wait.for` is `"exit"` by default or `"ready"`; `pattern` is an output regular expression and takes precedence. `timeout` defaults to `30` seconds.
- `send.text` appends Enter unless `enter: false`. `keys` accepts `ENTER`, `TAB`, `ESCAPE`, `CTRL_C`, `CTRL_D`, `UP`, `DOWN`, `LEFT`, and `RIGHT`.
- `send.signal` accepts `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, or `SIGKILL`.
- `stop.timeout` defaults to `5` seconds; log and wait timeouts default to `30` seconds. All are bounded to one hour.

## Lifecycle and errors

`restart` reuses the retained specification. `on-failure` and `always` use bounded backoff; an explicit stop prevents automatic restart. Process creation is not readiness: use `ready` or `wait` before depending on a service.

The tool rejects a missing name for name-based operations, a missing `application` for `start`, invalid readiness ports, a `ready` object without `log` or `port`, and unsupported terminal key names.

## Compatibility

`launch` remains a standalone built-in tool for existing callers. It is available alongside the newer `hub` and `xd` surfaces; neither replaces this wire contract.
