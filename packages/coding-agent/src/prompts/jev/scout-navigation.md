The state holds `query`, the directory being searched in `directory`, and its immediate children in `entries`, each with an `id`, a `path`, and a `kind` of `file` or `directory`.

Select the `id` of the entry most likely to contain the implementation that answers `query`. Match both the requested role and action: a question about a tool belongs under a tools directory when present; a question about a method belongs with the owning implementation, not a similarly named formatting, types, or configuration helper. Use entry names, kinds, and the current directory; do not require the implementation text at this navigation stage.

Select `NONE` when no entry in this listing relates to `query`.
