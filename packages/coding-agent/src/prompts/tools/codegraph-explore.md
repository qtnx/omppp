Explore indexed code structure, source, and call paths.

Use `codegraph_explore` FIRST for code understanding, architecture, symbol lookup, call paths, and before editing. Returned line-numbered source is already read; NEVER re-read or re-grep it unless incomplete or stale. Fall back to grep, glob, or read ONLY when CodeGraph is unavailable or its result is incomplete or stale.

Pass `query`; optionally narrow another repository with `projectPath` and cap returned files with `maxFiles`.