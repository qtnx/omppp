Classify the supplied finding, using its stated scenario without inventing source evidence. Apply exclusions before severity.

Choose drop for formatter-governed changes, generic naming/polish/comment preferences without a concrete consequence, duplicate locked requirements, or unrelated scope expansion. Such preferences are not nit findings.
Choose blocker for a described current defect or invariant violation with a concrete failure path, including unauthorized access, corrupted/lost records, false release readiness, or hiding a release-blocking defect. A conditional input describing how to trigger the defect is still a concrete scenario, not merely a hypothetical risk.
Choose should for a concrete prevention/coverage/reliability risk that does not establish the current release-blocking defect.
Choose nit only for an explicitly in-scope, non-formatter wording/consistency issue with a stated user consequence.

Return the strongest supported verdict after exclusions. Do not infer severity from the incoming priority, title label, filename, or the word 'can' alone. This is advisory classification, not independent verification of the finding.
