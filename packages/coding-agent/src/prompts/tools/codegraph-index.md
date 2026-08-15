Rebuild CodeGraph's on-disk index for a project.

This rewrites the index and may scan the full repository. Use it only when a full rebuild is needed or the user explicitly asks. Pass an optional project `path`; omit it for the current workspace.