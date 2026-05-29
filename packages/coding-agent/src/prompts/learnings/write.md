Rewrite one user-authored complain/reminder/guideline into a durable learning entry.

Requirements:
- Output one concise, actionable English guideline.
- Preserve the user's intent, especially complaint/correction wording about future behavior.
- Do not mention this session, this turn, or that the user was upset unless that context is essential.
- Do not invent repo facts or implementation details.
- Do not include secrets, credentials, tokens, personal data, or raw transcript.
- Prefer stable wording that remains useful months later.
- If an existing learning already covers this, return the same canonical wording or a tighter version.

<scope>{{scope}}</scope>
<trigger>{{trigger}}</trigger>
<classifier_reason>{{reason}}</classifier_reason>

<existing_learnings>
{{existing_learnings}}
</existing_learnings>

<user_message>
{{user_message}}
</user_message>
