Add working directories to the macOS OMPx sandbox allowlist.

Use when a command, read/search/find, hook, or package manager needs another trusted project/workspace directory outside the current sandbox.

Important:
- macOS Seatbelt sandboxes cannot be relaxed inside the running process.
- This tool asks the unsandboxed OMPx supervisor to relaunch the current session with extra `--add-dir` entries; if no supervisor is available, it returns manual restart args.
- Only add directories the user trusts as workspace/project roots.
- NEVER add broad home directories, credential directories, keychains, or private-key paths.
