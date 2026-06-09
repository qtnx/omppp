Add trusted files or directories to the macOS OMPx sandbox allowlist.

Use when a command, read/search/find, hook, package manager, or Kubernetes tooling needs another trusted path outside the current sandbox.

Important:
- macOS Seatbelt sandboxes cannot be relaxed inside the running process.
- This tool asks the unsandboxed OMPx supervisor to relaunch the current session with extra sandbox allowlist entries; if no supervisor is available, it returns manual restart args.
- Use `remember: true` only when the user approved persisting the paths to `sandbox.allowedPaths` for future sessions.
- Only add paths the user trusts.
- NEVER add broad home directories, credential directories, keychains, or private-key paths.