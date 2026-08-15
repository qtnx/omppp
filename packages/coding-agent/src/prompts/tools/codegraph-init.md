Initialize CodeGraph's on-disk index for a project.

This writes `.codegraph/` and may scan the full repository. Use it only when the project is not initialized or the user explicitly asks. Pass an optional project `path`; omit it for the current workspace.