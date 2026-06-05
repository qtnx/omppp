Generate a durable repo learning lesson from this review finding.

The final lesson must not be the raw review comment. Distill it into fields that prevent repeating the mistake.

Review finding JSON:

```json
{{finding_json}}
```

Return JSON with:
- facts: 1-5 concrete facts from the finding/source context.
- lesson: one reusable rule for this repo.
- rationale: why the rule matters.
- apply_when: 1-5 situations where future agents should apply it.
- avoid: 0-5 anti-patterns to avoid.
- source_summary: one short source note including file/location context.
