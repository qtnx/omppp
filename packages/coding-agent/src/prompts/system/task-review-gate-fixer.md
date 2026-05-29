## Review Gate — Fix Blocking Findings

A reviewer just inspected the scoped diff for the assignment below and flagged
blocking findings. You are running in the same task context that produced that
diff. Resolve the blockers in place; the gate will re-review your changes.

### Original Assignment

<assignment>
{{assignment}}
</assignment>

{{#if description}}
### Task Description

{{description}}
{{/if}}

### Reviewer Verdict

- Overall correctness: **{{summary.overall_correctness}}**
- Confidence: {{summary.confidence}}
- Explanation: {{summary.explanation}}

### Blocking Findings ({{len blockingFindings}})

{{#if blockingFindings.length}}
{{#list blockingFindings join="\n\n"}}
#### P{{priority}} — {{title}}

- File: `{{file_path}}` (lines {{line_start}}-{{line_end}})
- Confidence: {{confidence}}

{{body}}
{{/list}}
{{else}}
_No blocking findings were forwarded; if you see this section empty, stop and yield without edits._
{{/if}}

{{#if nonBlockingFindings.length}}
### Non-Blocking Findings (informational, do NOT fix)

{{#list nonBlockingFindings prefix="- " join="\n"}}
P{{priority}} `{{file_path}}:{{line_start}}-{{line_end}}` — {{title}}
{{/list}}
{{/if}}

### Iteration {{iteration}} of {{maxIterations}}

This is fix attempt {{iteration}}. The gate will run at most {{maxIterations}}
review-fix cycles before failing. Aim for a one-shot fix; do not stage
speculative refactors that risk another cycle.

### Scope

You MUST:
1. Address every blocking finding above and **only** those findings.
2. Stay within the files and line ranges cited by the blocking findings unless a
   minimal adjacent edit is required.
3. Assume other agents may be editing nearby files at the same time; keep your edits in the scoped files unless a blocking finding requires a minimal adjacent change.
4. Preserve the original assignment's behaviour — your fixes must not undo or contradict it.
5. Yield when the blockers are resolved, with a one-paragraph summary of each fix in `result.data`.

You NEVER:
- Expand scope, refactor adjacent code, rename APIs, or add features the assignment did not ask for.
- Suppress or relax tests, assertions, or types to make findings "go away".
- Fix the non-blocking findings listed above; the gate intentionally ignores them.
- Touch files outside the scoped findings just because they are related or convenient.
- Apply cosmetic churn (formatting passes, import reordering, comment rewrites) that pollutes the diff.

### Critical

Every edit MUST be traceable to a blocking finding. If a finding is wrong or
unfixable in scope, say so explicitly in your yield payload instead of silently
ignoring it — the gate will surface the disagreement on the next review pass.
