Searches files/internal URLs: Rust regex, PCRE2 fallback.

<instruction>
- `path`: known files, directories, globs, internal URLs; roots `;`-separated.
- Broad searches may time out → narrow scope or use `glob` first.
- One-file line selector: `src/foo.ts:50-100`; never selects search root.
- Literal `\n` or `\\n` enables cross-line patterns.
</instruction>

<critical>
- MUST use built-in `grep` for any content search. NEVER shell out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, `sed`-for-search, or any CLI search via Bash — not even for one match or a quick check.
- Open-ended multi-round search MUST use {{#if scoutAvailable}}Task + scout{{else}}Task + explore{{/if}}, not chained `grep` calls.
</critical>
