Rewrite one user-authored complain/reminder/guideline into a durable learning entry.

Requirements:
- Decide independently whether the classifier decision is correct.
- If the latest user message does not contain a durable complaint, correction, reminder, blame, claim, upset signal, preference, or guideline, return `{"action":"skip","reason":"…"}`.
- If an existing `[l:alias]` entry already covers the learning, return `{"action":"reinforce","target":"<alias>"}`.
- Otherwise, if the latest user message should become a learning, return `{"action":"store","content":"…"}`.
- For `store`, output one concise, durable learning entry.
- Extract the GENERAL principle the user is teaching.
- Keep at most one short concrete example clause when it clarifies the principle.
- Strip incidental task specifics such as file names and one-off values unless the specific is the preference.
- Never invent facts or flip the user's intent.
- When the user blames, claims, or is upset about agent behavior, write the entry as a clear lesson so the agent does not repeat that behavior.
- Keep blame/upset lessons clear and focused on the specific behavior the user identified.
- Do not mention this session, this turn, or that the user was upset unless the user made that part of the durable guideline.
- Do not include secrets, credentials, tokens, personal data, or unrelated raw transcript.
<scope>{{scope}}</scope>
<trigger>{{trigger}}</trigger>
<classifier_reason>{{reason}}</classifier_reason>

<existing_learnings>
{{existing_learnings}}
</existing_learnings>

<user_message>
{{user_message}}
</user_message>
