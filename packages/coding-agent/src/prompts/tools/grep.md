Greps files using regex (Rust regex + PCRE2).

<instruction>
- `path`: scope to known path (e.g. `src`); pass several as delimited list (`src; tests`).
  Line selector on one file (`src/foo.ts:50-100`); selectors never choose search root.
- Cross-line patterns from literal `\n` or `\\n` in `pattern`.
</instruction>

<critical>
- MUST use built-in `grep` for any content search. NEVER shell out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, `sed`-for-search, or any CLI search via Bash — not even for one match or a quick check.
- Open-ended search needing multiple rounds? MUST use the Task tool with the explore subagent, NOT chained `grep` calls.
</critical>
