Searches files/internal URLs: Rust regex, PCRE2 fallback.

<instruction>
- `path`: known files, directories, globs, internal URLs; roots `;`-separated. Bare `*.ts` matches any depth; `dir/*.ts` only direct children (`dir/**/*.ts` recurses). Default case-sensitive, gitignore respected; `skip` paginates files.
- Broad searches may time out → narrow scope or use `glob` first.
- One-file line selector: `src/foo.ts:50-100`; never selects search root.
- Literal `\n` or `\\n` enables cross-line patterns.
Regex engine: Rust regex first, then PCRE2 fallback. `path` accepts `;`-separated files, directories, globs, and internal URLs; default `.`. Case-sensitive and gitignore-respecting by default; `skip` paginates files.
File-only selector: `src/foo.ts:50-100`; selector never applies to search root. Literal `\n` or `\\n` enables cross-line matching.
Bare `*.ts` matches any depth; `dir/*.ts` matches direct children only; use `dir/**/*.ts` to recurse.
</instruction>

<critical>
- MUST use built-in `grep` for content search. NEVER shell out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, or `sed`-for-search.
{{#if hasFind}}- Behavior or unknown symbol → `find`; exact text/regex → `grep`.{{/if}}
{{#if eagerDelegation}}- Open-ended multi-round search MUST use {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}, not chained calls.{{/if}}
</critical>
