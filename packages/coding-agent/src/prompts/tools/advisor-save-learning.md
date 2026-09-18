Save a durable learning so future executors do not repeat a mistake you just caught. Learnings are injected into every later session's system prompt (Live Learning Guidance) and ranked by usefulness, so each entry must earn its place.

Write the learning as a GENERIC rule, flow, or formula — never the specific case:
- State the trigger condition and the required behavior: "When X, do Y (not Z) because W."
- No file paths, line numbers, function names, ticket ids, dates, model names, or the current task's nouns. If the sentence only makes sense in this session, it is not a learning.
- One rule per call, 1–3 sentences, imperative voice, ≤ 400 characters.
- Name the failure class it prevents: hallucinated API/config/path, done claim without evidence, symptom fix at the caller instead of the root cause, skipped verification of the changed path, scope drift, ignored user correction, retry loop without a new hypothesis, and similar.

Good: "Before calling an API, config key, or CLI flag you have not seen in this checkout, read its definition; an unverified name is a guess, not a fact."
Good: "A test that passes on unrelated code is not verification; run the changed path once and quote the decisive output before claiming done."
Bad: "In session-duo-orchestrator.ts:355 the registry mock lacked getAvailable." (specific case)
Bad: "Be careful with edge cases." (no trigger, no behavior)

Save only when the executor actually made (or was about to make) the mistake in this session and the rule would have prevented it; an observation that repeats an existing injected learning is a `rate_learning` `useful` vote, not a new entry. `scope: "repo"` when the rule depends on this codebase's conventions; `scope: "global"` when it holds anywhere.
