Rewrite one user-authored complain/reminder/guideline into a durable learning entry.

Requirements:
- Decide independently whether the classifier decision is correct.
- If the latest user message does not contain a durable complaint, correction, reminder, blame, claim, upset signal, preference, or guideline, return `{"action":"skip","reason":"…"}`.
- If the latest user message should become a learning, return `{"action":"store","content":"…"}`.
- For `store`, output one concise, durable learning entry.
- Preserve only facts that are explicitly present in the user message.
- Do not add details, causes, scope, or examples the user did not state.
- Preserve the user's original intent 100%; do not broaden, narrow, soften, or reinterpret it.
- You may rewrite for clarity, but the meaning must remain identical to the original user message.
- Prefer raw, direct wording over polished abstraction when abstraction would change nuance.
- When the user blames, claims, or is upset about agent behavior, write the entry as a clear lesson so the agent does not repeat that behavior.
- Keep blame/upset lessons clear and focused on the specific behavior the user identified.
- Do not mention this session, this turn, or that the user was upset unless the user made that part of the durable guideline.
- Do not include secrets, credentials, tokens, personal data, or unrelated raw transcript.
- If an existing learning already covers this, return the same canonical wording or a tighter version that does not change meaning.
<scope>{{scope}}</scope>
<trigger>{{trigger}}</trigger>
<classifier_reason>{{reason}}</classifier_reason>

<existing_learnings>
{{existing_learnings}}
</existing_learnings>

<user_message>
{{user_message}}
</user_message>
