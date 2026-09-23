Explore indexed code structure, source, and call paths.

Use `codegraph_explore` FIRST when you do not yet know where the code lives: architecture, symbol lookup, call paths, and blast radius before editing. Returned line-numbered source is already read; NEVER re-read or re-grep it unless incomplete or stale.

Go straight to `read`/`grep` instead when you already know the exact path or symbol, or the target is config, docs, generated output, or a file outside the indexed tree.

One relevance check per query: if the result does not answer the query — unrelated modules, another language, another worktree, or the files you need flagged "changed on disk" — the index does not cover this area. Switch to `jev_scout` for behavior lookups or `grep`/`read` for exact names immediately; NEVER re-query with a reworded prompt, and NEVER initialize or rebuild the index to fix it.

An error saying the project has no index, is still indexing, or has no CodeGraph install means the same: use `jev_scout` or `grep`/`read` for this lookup. NEVER install CodeGraph or run `codegraph_init` to answer it.

Pass `query`; optionally narrow another repository with `projectPath` and cap returned files with `maxFiles`.
