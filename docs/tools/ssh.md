# ssh

> Execute one command on a discovered remote SSH host.

## Source
- Entry: `packages/coding-agent/src/tools/ssh.ts`
- Prompt: `packages/coding-agent/src/prompts/tools/ssh.md`
- Capability: `packages/coding-agent/src/capability/ssh.ts`
- Executor: `packages/coding-agent/src/ssh/ssh-executor.ts`

## Inputs

| Field | Required | Description |
| --- | --- | --- |
| `host` | Yes | Discovered SSH host name, not an arbitrary hostname or IP address. |
| `command` | Yes | Remote command string. |
| `cwd` | No | Absolute remote working directory. Omit it unless required; `~` and `~/...` are rejected. |
| `timeout` | No | Command timeout in seconds; defaults to `60` and is clamped to `1..3600`. |

The tool is available only when SSH host discovery finds at least one configured host. Its description includes the available host names and detected shell/OS information when known.

## Execution

The selected host must exactly match a discovered host name. The tool detects host information before execution and chooses a `cwd` wrapper appropriate to the target:

- Unix-like hosts and Windows compatibility shells: `cd -- '<cwd>' && <command>`
- Windows PowerShell: `Set-Location -Path '<cwd>'; <command>`
- Windows cmd: `cd /d "<cwd>" && <command>`

Use commands compatible with the host's reported shell. The tool has no `env`, PTY, upload, download, or file-transfer parameters.

## Output and failures

The final text result contains combined remote stdout and stderr, or `(no output)` when the command produces none. While a command runs, the tool can stream tail-only updates. Large output may be truncated in the in-memory result and written to a session artifact when one is available.

The tool throws an error for an unknown or unloaded host, invalid `cwd`, cancellation or timeout, SSH startup failure, and any non-zero remote exit. A non-zero exit includes captured output and `Command exited with code N`.

## Side effects

An invocation opens an SSH connection to the configured remote host and may probe it to determine OS and shell. Host-info and connection management are handled by the SSH subsystem. Calls are exclusive for the calling agent.

## Compatibility

`ssh` remains a discoverable standalone built-in tool for existing callers. It is exposed alongside the newer `hub` and `xd` surfaces; neither replaces this parameter or error contract.
