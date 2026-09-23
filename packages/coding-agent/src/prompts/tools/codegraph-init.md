Initialize CodeGraph's on-disk index for a project.

This writes `.codegraph/` and scans the full repository — minutes and hundreds of MB on large repositories. Use it only when the user explicitly asks; lookups on an unindexed project go to `jev_scout` or `grep`/`read`. Pass an optional project `path`; omit it for the current workspace.
