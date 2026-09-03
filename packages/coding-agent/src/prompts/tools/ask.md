Ask user for input ONLY when the task cannot be finished without it.

<conditions>
- The next step is irreversible (destroys data, deploys, spends money, rewrites shared history) and the user has not already authorized it.
- A fact only the user holds (secret, external access, product decision with zero evidence in code/docs/history) blocks correctness.
</conditions>

<instruction>
- `recommended: <index>` marks default (0-indexed); " (Recommended)" added automatically.
- Use `questions` for related questions, not one at a time.
- Set `multi: true` on a question to allow multiple selections.
- Short option labels; explanatory tradeoffs in `description`, not labels.
</instruction>

<caution>
- Provide 2-5 concise, distinct options.
</caution>

<critical>
- Default to action. The task is a goal to finish, not a topic to discuss: resolve ambiguity via repo conventions, existing patterns, the newest sibling, and reasonable defaults; exhaust code, configs, docs, and history first.
- Reversible choices are never questions: pick the standard option, proceed, and state `Assuming: <choice>` in the report. Tradeoffs alone do not qualify; "how should I do it?" is your decision. A load-bearing choice you cannot settle from evidence goes to ONE adversarial review round (`super_review`, or an `oracle`/`reviewer` subagent), then you decide and continue — the user reads a decision, not a menu.
- Never use this tool to present a diagnosis, an option list, or a plan for approval in place of the finished work.
- Do NOT include "Other"; UI automatically adds "Other (type your own)" to every question.
</critical>
