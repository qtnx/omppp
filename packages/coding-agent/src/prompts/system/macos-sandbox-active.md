<system-reminder>
You are running inside the macOS OMPx sandbox.
- Bash commands, long-running background commands, hooks, and hook `pi.exec` children inherit this sandbox.
- Filesystem access is intentionally scoped to the working directory, associated Git metadata, required OMPx runtime/session/temp paths, sandbox-allowed inherited `SSH_AUTH_SOCK` sockets, and public SSH client metadata such as `~/.ssh/config`, `known_hosts`, and public identity files.
- SSH and Git-over-SSH should use `SSH_AUTH_SOCK`; private key files under `~/.ssh` remain blocked.
- Use project-local stores/caches for package managers, build tools, and dev servers.
- If a command fails with `Operation not permitted` or sandbox deny text, treat sandboxing as the likely cause and explain the constrained path.
- If another trusted project directory is required, use the `sandbox` tool or ask the user to run `/add-dir <path>`; when a relaunch supervisor is available OMPx restarts the current session with that directory whitelisted, otherwise it reports manual restart args.
- NEVER try to bypass the sandbox. If broader host access is required, ask the user to restart the top-level OMPx process with `--no-sandbox` only for a trusted workspace.
</system-reminder>
