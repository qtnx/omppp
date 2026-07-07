---
name: frontend-ui-copy
description: Rules and formulas for production user-facing UI copy — labels, buttons, errors, empty states, onboarding, notifications — plus the hard rule against internal-note leakage and i18n editing rules. Use whenever any rendered string is written or changed, even inside an implementation task. Single source of the copy/leakage boundary for all frontend agents.
---

# Frontend UI Copy

## Voice defaults (when the project defines none)

Plain, specific, confident. Sentence case. Contractions are fine. No exclamation inflation, no "Oops!" cuteness, no blaming the user ("you input" -> "say what we'd like to know"), no schema jargon (`user_id`, `null`, exception names). An action keeps one name through its whole flow: a "Publish" button leads to a "Published" confirmation, not "Saved".

## Formulas, with examples

**Errors = what happened + impact + next action.**
- x "An error occurred."
- v "Something went wrong."
- v "Couldn't save your changes — you're offline. They'll sync when you reconnect."
- v "That file is over 10 MB. Compress it or choose a smaller one."

**Empty states = what this space is + first action (+ why it's worth doing).**
- x "No data."
- v "Nothing here yet."
- v "No invoices yet. Create your first invoice to start tracking payments."

**Buttons = verb + object.**
- x "Submit", "OK", "Yes"
- v "Create invoice", "Save changes", "Delete 3 files"

**Destructive confirmations name the object and the consequence.**
- x "Are you sure?"
- v "Delete Q3 report? This can't be undone."
  with button "Delete report"

**Success = confirm the outcome, not the mechanism.**
- x "Operation completed successfully."
- v "Invoice sent to anna@example.com."

**Loading = say what's happening if it exceeds ~2s.**
- v "Importing 1,204 rows..."

## Hard rule: internal notes never render

Principle: the interface speaks only for the product, to the user, about product state.

Nothing addressed to the team — instructions, constraints, review feedback, prompt text, implementation notes, rejected alternatives, scope decisions — is content under any transformation. All of these are the same violation:

- Instruction "don't do X" -> UI text "did not do X"
- Review note "make the CTA less aggressive" -> rendered label "Toned-down CTA:"
- "This is out of scope for v1" -> an in-app banner saying "Out of scope"
- PR/commit language in user-visible changelogs ("Fixes #482 per feedback") -> rewrite as user value ("Faster search on large projects")
- A placeholder like "copy TBD per marketing" reaching a rendered string
- Apologies about the development process ("Sorry we didn't have time to add filters")

Convert constraints into positive, production copy that serves the user, or say nothing:

- "don't auto-save" -> either silence, or "Your changes are saved when you click Save."
- "hide advanced filters for launch" -> no visible copy unless the product intentionally offers a clear upgrade path.

## i18n rules

Detect the setup first (i18next / react-intl / vue-i18n / gettext / locale JSON). If present, edit the **source-locale** files — never hardcode strings into component props. Preserve keys, placeholders (`{name}`, ICU plural branches), and formatting tags. Meaning changed -> new key; wording polish -> same key. Never build sentences by concatenating translated fragments; use full-sentence keys with placeholders. Never silently machine-translate other locales; change the source language and flag the rest for translation.

Flag any hardcoded strings found in scope.

Numbers, dates, and currency go through locale utilities, never string-formatted by hand.

## Verification

Run this grep (or your platform equivalent) before reporting done:

```bash
grep -RIn --exclude-dir={node_modules,dist,.next,.nuxt,coverage,build,.git} -E "TODO|FIXME|TBD|lorem|as requested|per (the |your )?(feedback|instruction|review)|did not (do|implement|include)|we (decided|chose|were asked)|out of scope|internal note" src --include='*.tsx' --include='*.jsx' --include='*.vue' --include='*.svelte' --include='*.json'
```

Zero hits on rendered strings. Hits in comments/tests are fine — judge the surface, not the file.
