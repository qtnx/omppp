<system-notice>
The user's message above contains the **workflow** keyword. For a concrete task that benefits from multi-step or parallel subagent work, call the `workflow` tool with a dynamic JavaScript workflow script.

Use this only when fan-out improves coverage, confidence, or scale. For trivial lookup, single edit, or a question only about workflows, answer directly.

<workflow-use>
- Scout inline first: identify files, conflicts, failures, or review dimensions.
- Then call `workflow` with inline `script` and any dynamic values in `args`.
- Script MUST start with pure-literal `export const meta = { name, description, phases }`.
- Use `phase()`, `log()`, `agent()`, `parallel()`, and `pipeline()` inside the script.
- Use `schema` for subagent outputs you branch on.
- Keep subagent prompts self-contained: target files, constraints, acceptance.
- After workflow completion, verify results yourself before claiming status.
</workflow-use>

<critical>
- NEVER ask the user to write the workflow script.
- NEVER use Python `eval` as the workflow implementation.
- NEVER treat subagent output as verified.
- NEVER fan out for trivial or purely conversational requests.
</critical>
</system-notice>
