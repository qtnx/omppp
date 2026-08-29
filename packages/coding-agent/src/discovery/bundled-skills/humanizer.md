---
name: humanizer
description: Use when writing or rewriting marketing, advertising, campaign, brand, product, or other copywriting prose; when asked to humanize text; or when copy sounds AI-generated, generic, inflated, salesy, repetitive, or chatbot-like.
license: MIT
---

# Humanizer

Humanizer rewrites AI-sounding marketing and copywriting so it reads like a person wrote it without changing what it says. Preserve the writer's voice, source facts, and intended call to action. This skill is for voice-preserving copywriting; `stop-slop` owns strict generic AI-tell auditing. Use both only when the user asks for both jobs.

Source: [blader/humanizer](https://github.com/blader/humanizer), Humanizer © 2025 Siqi Chen. Based on Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by [WikiProject AI Cleanup](https://en.wikipedia.org/wiki/Wikipedia:WikiProject_AI_Cleanup).

## Workflow

1. Capture the objective, audience, voice, source facts, and CTA. Identify what the copy must achieve and what it must not claim.
2. Read any writing sample first. Note sentence length, word choice, punctuation, paragraph openings, transitions, rhythm, and deliberate quirks. A sample overrides the defaults below, including the dash preference.
3. Draft or rewrite for the audience and voice. For marketing copy, personality is welcome when it fits; technical, reference, legal, and factual prose stays neutral and plain.
4. Audit the draft against all 35 patterns below.
5. Compare every claim with the source and user brief. Ask: “What still sounds AI-generated?” and “Did the rewrite add or remove any fact, name, number, date, quote, citation, ranking, or other claim?”
6. Rewrite the remaining problems as complete passages, not isolated word substitutions. Return the final copy.

## Non-negotiable fact and file rules

- Invent nothing. Names, numbers, dates, quotes, citations, testimonials, metrics, proof, rankings, and personal details must come from the source or user. Fiction is exempt only when invention is the task.
- If a detail is missing, ask for it or use a simpler sentence. Do not fill gaps with plausible guesses.
- Keep useful opinions, uncertainty, mixed feelings, humor, asides, unusual details, dated references, deliberate first-person choices, and varied rhythm when they belong to the writer.
- In file mode, write only final prose changes. Preserve code, data, YAML/frontmatter, URLs, link targets, identifiers, and exact quotes. Do not rewrite watched phrases inside quotations, titles, proper names, or examples where they are discussed rather than used.
- One pattern alone is not proof of AI writing. Consider several patterns together; keep real limits, named objections, useful disclaimers, genuine alternatives, and deliberate repetition.

## The 35-pattern audit checklist

Check every item on every rewrite. A pattern is a signal, not an automatic ban when the source, sample, or meaning requires it.

### Content

1. **Inflated importance and legacy:** Remove claims that ordinary facts mark pivotal moments, prove enduring significance, or reflect broad trends unless sourced.
2. **Name-dropping:** Keep publications, experts, follower counts, or affiliations only when the context is useful and sourced.
3. **Shallow `-ing` analysis:** Cut unsupported “highlighting,” “symbolizing,” “reflecting,” “showcasing,” “ensuring,” and similar add-on analysis.
4. **Sales language:** Replace unearned “vibrant,” “breathtaking,” “renowned,” “must-visit,” “nestled,” “groundbreaking,” and similar promotion with specific claims.
5. **Vague sources:** Name a real source when provided; otherwise remove “experts,” “observers,” “critics,” or “industry reports” claims that have no support.
6. **Formulaic challenges and outlook:** Remove stock “despite challenges,” “future outlook,” and “continues to thrive” sections unless they add sourced facts or real plans.

### Language and grammar

7. **Overused AI words:** Audit clustered words such as “actually,” “additionally,” “align,” “crucial,” “delve,” “enhance,” “foster,” “garner,” figurative “gate/gated/gating,” “highlight,” “interplay,” “intricate,” “key,” abstract “landscape,” “pivotal,” “quietly,” “showcase,” “tapestry,” “testament,” “underscore,” “valuable,” and “vibrant.” Preserve established technical usage.
8. **Avoiding “is,” “are,” and “has”:** Prefer simple verbs over “serves as,” “stands as,” “boasts,” “features,” “offers,” and “represents” when they mean the same thing.
9. **“Not X but Y” and clipped negative endings:** State the point directly instead of “not just X, it’s Y,” “not only...but,” or fragments such as “no guessing.”
10. **Forced groups of three:** Use only as many items as the meaning needs; do not force three-part lists for rhythm.
11. **Changing names and repeated openings:** Use one clear name for a subject; merge or vary repeated sentence openings when repetition adds nothing. Keep deliberate repetition.
12. **False “from X to Y” ranges:** Use a direct list unless the endpoints form a real range.
13. **Passive voice and missing subjects:** Name the actor when that makes responsibility or action clearer; do not hide who did what.

### Style

14. **Em/en dashes:** Remove em dashes (`—`), en dashes (`–`), spaced dashes, and double-hyphen dashes unless the writer's sample uses them; use punctuation or a rewrite instead.
15. **Too much bold text:** Remove decorative bolding; retain emphasis only when the format or meaning needs it.
16. **Bold mini-headings in lists:** Replace repetitive `**Label:** sentence` lists with prose or a useful list structure.
17. **Title Case headings:** Use sentence case rather than capitalizing every main word.
18. **Emojis:** Remove decorative emojis from headings and copy unless the brief explicitly requires them.
19. **Curly quotation marks:** Use straight quotes when that is the target format; curly quotes alone are not evidence of AI writing.
20. **Chatbot residue:** Remove “I hope this helps,” “let me know,” “here is,” “would you like,” “certainly,” and similar greetings, offers, or closings from copy that should stand alone.
21. **Knowledge-limit disclaimers and guesses:** State what the sources do not show or omit it; never turn “likely,” “it is believed,” or a cutoff disclaimer into an unsupported fact.
22. **Overly agreeable tone:** Remove praise and agreement such as “Great question!” or “You’re absolutely right!” before the actual copy.

### Filler and hedging

23. **Filler phrases:** Prefer “to,” “because,” “now,” “if,” “can,” and direct sentences over “in order to,” “due to the fact that,” “at this point in time,” “in the event that,” and “it is important to note.”
24. **Too many qualifiers:** Keep a qualifier only when the source supports it and the meaning needs it; reduce stacks such as “could potentially possibly.”
25. **Generic positive endings:** End on a concrete benefit, fact, or sourced plan. Cut vague send-offs such as “the future looks bright” unless they are a real sourced claim.

### Additional style patterns

26. **Too many hyphenated word pairs:** Keep hyphens where grammar requires them before a noun (`high-quality report`), but avoid stacking them or keeping them after a noun (`report is high quality`).
27. **Fake deeper truth:** Replace “at its core,” “the real question,” “what really matters,” “the heart of the matter,” and similar framing with the specific claim.
28. **Announcing the next point:** Remove “let’s dive in,” “here’s what you need to know,” “quick note,” “without further ado,” and casual announcement hooks; start with the content.
29. **Heading repeated below itself:** Remove a first sentence that merely restates its heading before the useful content.
30. **Writing about the old version:** Describe current behavior in current copy; mention previous versions only in change logs, release notes, migration guides, or other change-focused documents.
31. **Forced punchlines and fragments:** Avoid rows of dramatic fragments. Use natural sentence lengths and specific claims; one short emphasis sentence can remain when it fits.
32. **Formulaic sayings:** Replace “X is the language/currency/architecture of Y” and other fake aphorisms with the concrete claim.
33. **Fake-candid openings:** Remove standalone “Honestly?”, “Look,” “Here’s the thing,” “Real talk,” and similar staged pauses before an ordinary point. Keep normal mid-sentence usage.
34. **Answering objections no one raised:** Remove unsupported defenses such as “this isn’t mainly about...” or “don’t get me wrong.” Keep a named objection or real claim, stated directly.
35. **Rejecting fake alternatives:** Remove a tempting or obvious option that no reader would consider and that adds no information. Keep real alternatives in designs, tutorials, or arguments.

## Output modes

- **Pasted text:** Return the draft, a short list of remaining AI patterns, and the final rewrite.
- **File mode:** Run the full process but write only the final prose to the named file, preserving protected file content above.
- **Embedded mode:** When another task uses Humanizer for a PR, commit message, or document, return only the final text.
