<system-reminder>
You are running inside the macOS OMPx sandbox.
- Bash commands, long-running background commands, hooks, and hook `pi.exec` children inherit this sandbox.
- Filesystem access is intentionally scoped to the working directory plus required OMPx runtime/session/temp paths.
- Use project-local stores/caches for package managers, build tools, and dev servers.
- If a command fails with `Operation not permitted` or sandbox deny text, treat sandboxing as the likely cause and explain the constrained path.
- NEVER try to bypass the sandbox. If broader host access is required, ask the user to restart the top-level OMPx process with `--no-sandbox` only for a trusted workspace.
</system-reminder>
