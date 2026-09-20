import type { ReviewFindingRecordItem } from "../../packages/stats/src/review-findings";

export type BriefGap = "anchors" | "acceptance" | "scope";

export interface BriefTask {
	id: string;
	assignment: string;
	context: string;
	expectGaps: BriefGap[];
}

const GOOD_BRIEF_PREFIX = `Target
Own packages/coding-agent/src/task/jev-context.ts and its focused test. Forbidden: generated files and unrelated packages.
Pointers
packages/coding-agent/src/task/jev-context.ts:73-130 selectRelevantContext; packages/coding-agent/test/task/jev-context.test.ts:20-85 existing selection cases.
Change
Preserve section ordering and add the requested selection behavior without changing the public return shape.
Acceptance
1. bun test packages/coding-agent/test/task/jev-context.test.ts passes with 0 fail.
2. Run the changed path with a duplicate section and verify selected sections contain no duplicate.
Done
Report changed symbols, both checks, and any intentional limitation.`;

export const BRIEF_TASKS: BriefTask[] = [
	{
		id: "brief-good-context",
		assignment: `${GOOD_BRIEF_PREFIX}\nTask: Make relevant context selection retain explicit negative constraints.`,
		context: "Use existing Jev context scoring. Keep maxSections and maxChars behavior stable.",
		expectGaps: [],
	},
	{
		id: "brief-good-route",
		assignment: `Target
Own packages/coding-agent/src/task/jev-brief.ts only. Forbidden: prompt files and unrelated task helpers.
Pointers
packages/coding-agent/src/task/jev-brief.ts:102-121 routeAgent; packages/coding-agent/src/task/index.ts:1025-1036 caller.
Change
Keep low-confidence routing undefined and preserve the existing agent list.
Acceptance
Run bun test packages/coding-agent/test/task/jev-brief.test.ts and verify confidence below 0.6 returns undefined.
Done
List files and symbols changed; include the focused test output.`,
		context: "This is a contained runtime behavior change. Do not add a compatibility alias.",
		expectGaps: [],
	},
	{
		id: "brief-good-triage",
		assignment: `Target
Own packages/coding-agent/src/task/jev-triage.ts and packages/coding-agent/test/task/jev-triage.test.ts. Forbidden: packages/stats and prompt wording.
Pointers
packages/coding-agent/src/task/jev-triage.ts:5-16 TriageKind; packages/coding-agent/src/task/jev-triage.ts:19-52 triageChildQuestion.
Change
Add coverage for user-only and status classifications while keeping the five existing kinds.
Acceptance
Run bun test packages/coding-agent/test/task/jev-triage.test.ts -t "user-only|status"; expected output includes 2 pass.
Done
Report the two cases and the exact command result.`,
		context: "Use the injected post seam; do not make network calls from the test.",
		expectGaps: [],
	},
	{
		id: "brief-good-findings",
		assignment: `Target
Own packages/coding-agent/src/task/jev-findings.ts:39-112 and its focused test. Forbidden: review persistence and database schema.
Pointers
packages/coding-agent/src/task/jev-findings.ts:13-24 verdict priorities; packages/coding-agent/src/task/jev-findings.ts:84-112 filter loop.
Change
Retain concrete blockers, map should findings to P2, and drop formatter-only findings.
Acceptance
Run bun test packages/coding-agent/test/task/jev-findings.test.ts; expected output includes 0 fail.
Done
State kept and dropped counts, then stop.`,
		context: "The public result is kept findings plus dropped count; preserve malformed-answer fallback.",
		expectGaps: [],
	},
	{
		id: "brief-missing-anchors",
		assignment: `Target
Own selectRelevantContext only. Forbidden: generated files, other helpers, and public return-shape changes.
Change
Make negative constraints win over unrelated topical matches.
Acceptance
Run bun test packages/coding-agent/test/task/jev-context.test.ts; expected output includes 0 fail.
Done
Report changed symbols and test output.`,
		context: "Do not change public behavior outside relevant context selection.",
		expectGaps: ["anchors"],
	},
	{
		id: "brief-missing-acceptance",
		assignment: `Target
Own packages/coding-agent/src/task/jev-evidence.ts. Forbidden: prompt files and unrelated packages.
Pointers
packages/coding-agent/src/task/jev-evidence.ts:17-45 assessResultEvidence; packages/coding-agent/src/task/review-findings.ts:32-45 caller.
Change
Treat reports missing failure-path evidence as weak.
Done
Report files and symbols changed, with the resulting behavior.`,
		context: "Keep strong evidence limited to observable acceptance results.",
		expectGaps: ["acceptance"],
	},
	{
		id: "brief-missing-scope",
		assignment: `Pointers
packages/coding-agent/src/task/jev-context.ts:73-130 selectRelevantContext.
Change
Preserve maxChars while choosing the most relevant sections.
Acceptance
Run bun test packages/coding-agent/test/task/jev-context.test.ts -t selection; expected output includes 4 pass.
Done
Return the focused test result.`,
		context: "Existing callers depend on method being jev or none.",
		expectGaps: ["scope"],
	},
	{
		id: "brief-missing-one-scope",
		assignment: `Target
Own packages/coding-agent/src/task/jev-brief.ts.
Pointers
packages/coding-agent/src/task/jev-brief.ts:102-121 routeAgent.
Change
Keep confidence gating and return undefined below threshold.
Acceptance
Run bun test packages/coding-agent/test/task/jev-brief.test.ts; expected output includes 0 fail.
Done
Report exact output.`,
		context: "This is the next queued implementation task.",
		expectGaps: ["scope"],
	},
];

export interface RouteTask {
	id: string;
	assignment: string;
	context: string;
	expect: string;
}

export const ROUTE_AGENTS = [
	{
		name: "scout",
		description:
			"MUST be used for exploratory codebase research, rapid code analysis, and broad pattern searches. Fast read-only scout returning compressed context for handoff.",
	},
	{ name: "explore", description: "Fast read-only codebase scout returning compressed context for handoff" },
	{
		name: "task",
		description:
			"You are a worker agent for delegated implementation slices — routine or load-bearing, always one contained concern sized to finish in about ten minutes.",
	},
	{
		name: "quick_task",
		description: "Fast implementer for light mechanical work; optimized for speed and parallel execution.",
	},
	{ name: "reviewer", description: "Code review specialist for quality/security analysis" },
	{
		name: "qa",
		description:
			"Adversarial senior QA engineer that independently re-verifies completed work against a harness-ready handoff; re-runs everything itself and returns a pass/fail/blocked verdict with evidence; never edits code",
	},
	{
		name: "plan",
		description:
			"Software architect for complex multi-file architectural decisions. NOT for simple tasks, single-file changes, or tasks completable in <5 tool calls.",
	},
	{
		name: "frontend_ui",
		description:
			"Frontend implementer for scoped, well-defined UI build tasks inside an existing design system — components, screens, states, and fixes. Escalate to designer when the task needs new aesthetic direction or system-level concepts beyond adding a token.",
	},
	{
		name: "librarian",
		description:
			"Researches external libraries and APIs by reading source code. Returns definitive, source-verified answers.",
	},
] as const;

export const ROUTE_TASKS: RouteTask[] = [
	{
		id: "route-locate-helper",
		assignment:
			"Locate every caller of selectRelevantContext and summarize the existing patterns. Do not edit files.",
		context: "One package, known symbol, read-only request.",
		expect: "scout",
	},
	{
		id: "route-map-unknown",
		assignment:
			"Map how task delegation crosses CLI, orchestrator, prompt loading, and stats persistence in this unfamiliar repository. Return compressed architecture context; no code changes.",
		context: "Several packages and unknown call paths require broad read-only discovery.",
		expect: "explore",
	},
	{
		id: "route-rename-enumerated",
		assignment:
			"Rename exactly these exported constants in the named files: JEV_MODEL_ENV to TYPESAFE_MODEL_ENV in systemone.ts and its two imports. No other files or behavior changes.",
		context: "Mechanical edit with exact enumerable scope and one focused check.",
		expect: "quick_task",
	},
	{
		id: "route-contained-logic",
		assignment:
			"Implement one contained change in jev-findings.ts: keep concrete blockers and preserve malformed-answer fallback, then add its focused regression test.",
		context: "Production logic plus earned test, bounded to one concern.",
		expect: "task",
	},
	{
		id: "route-external-api",
		assignment:
			"Read the installed TypeSafe client source and provider documentation to determine the exact timeout and response type for its System One endpoint. Return source citations; do not edit.",
		context: "Question depends on an external library/API contract.",
		expect: "librarian",
	},
	{
		id: "route-ui-build",
		assignment:
			"Build the scoped settings panel for Jev assistance inside the existing TUI design system, including loading, disabled, error, and keyboard states.",
		context: "Rendered UI implementation inside an existing design system.",
		expect: "frontend_ui",
	},
];

export interface ContextTask {
	id: string;
	assignment: string;
	context: string;
	snapshot: string;
	expectSections: string[];
	rejectSections: string[];
	requireUniqueSections?: boolean;
}

export const CONTEXT_TASKS: ContextTask[] = [
	{
		id: "context-test-anchor",
		assignment: "Add a regression test for context selection and use the existing task test conventions.",
		context: "Need the exact test anchor, not release documentation.",
		snapshot: `Context snapshot
## User
Fix Jev context selection regression.
## Assistant
Existing tests use injected post seams.
## File Mentions
packages/coding-agent/test/task/jev-context.test.ts:20-85
## Unrelated
packages/catalog/src/models.json is generated.
## Unrelated Notes
Release uses package changelogs.
## Old Log
A browser screenshot was captured yesterday.`,
		expectSections: ["packages/coding-agent/test/task/jev-context.test.ts:20-85"],
		rejectSections: ["packages/catalog/src/models.json"],
	},
	{
		id: "context-config-flag",
		assignment: "Trace the runtime switch that disables Jev assistance for one run.",
		context: "Prefer config and task runner anchors over release notes.",
		snapshot: `Context snapshot
## User
Find the task jevAssist override.
## Assistant
The override is read from the project config.
## File Mentions
<cwd>/.omp/config.yml task:\n  jevAssist: false
## Other File
packages/coding-agent/src/prompts/task/jev/brief-anchors.md
## Changelog
CHANGELOG.md describes a prior release.
## Build
The binary smoke test covers workers.
## Unrelated
The stats dashboard has a separate config.`,
		expectSections: ["jevAssist: false"],
		rejectSections: ["CHANGELOG.md"],
	},
	{
		id: "context-negative-lock",
		assignment: "Update the Jev evidence prompt; do not change CHANGELOG.md or generated model data.",
		context: "Explicit negative constraints matter more than topical matches.",
		snapshot: `Context snapshot
## User
Update evidence wording only.
## Assistant
Keep generated files untouched.
## File Mentions
packages/coding-agent/src/prompts/task/jev/result-evidence.md
## Locked Constraints
Do not change CHANGELOG.md or packages/catalog/src/models.json.
## Unrelated
packages/stats/src/review-findings.ts stores findings.
## Old Request
A release note was requested in an earlier session.
## Test
bun check validates TypeScript.`,
		expectSections: ["Do not change CHANGELOG.md"],
		rejectSections: ["A release note was requested"],
	},
	{
		id: "context-latest-correction",
		assignment: "Use the latest user correction: wire the route in jev-brief.ts, not jev-context.ts.",
		context: "A later correction supersedes the older file choice.",
		snapshot: `Context snapshot
## User
Earlier request: change packages/coding-agent/src/task/jev-context.ts.
## Assistant
That was the initial interpretation.
## File Mentions
packages/coding-agent/src/task/jev-context.ts
## User
Correction: wire route in packages/coding-agent/src/task/jev-brief.ts instead.
## Assistant
Latest correction is authoritative.
## File Mentions
packages/coding-agent/src/task/jev-brief.ts
## Unrelated
packages/ai/src/providers/anthropic.ts handles cache retention.
## Notes
Do not touch the release pipeline.`,
		expectSections: ["packages/coding-agent/src/task/jev-brief.ts"],
		rejectSections: ["packages/coding-agent/src/task/jev-context.ts"],
	},
	{
		id: "context-duplicate-sections",
		assignment:
			"Find the Jev brief helper and preserve one useful file mention; duplicate snapshot sections should not crowd out the answer.",
		context: "This probe records whether selected output deduplicates repeated sections.",
		snapshot: `Context snapshot
## User
Locate the brief helper.
## File Mentions
packages/coding-agent/src/task/jev-brief.ts
## File Mentions
packages/coding-agent/src/task/jev-brief.ts
## Assistant
The same file was mentioned twice by two collectors.
## Unrelated
packages/coding-agent/src/cli.ts dispatches workers.
## Unrelated Build
bun run ci:test:smoke runs binaries.
## Release
Do not edit release metadata.`,
		expectSections: ["packages/coding-agent/src/task/jev-brief.ts"],
		rejectSections: ["packages/coding-agent/src/cli.ts"],
		requireUniqueSections: true,
	},
	{
		id: "context-worker-wiring",
		assignment: "Verify the worker host selector required for a new stats sync worker.",
		context: "Need the runtime entrypoint and selector, not UI or catalog details.",
		snapshot: `Context snapshot
## User
Add a worker using the shared CLI host.
## Assistant
Workers re-enter cli.ts through a hidden selector.
## File Mentions
packages/coding-agent/src/cli.ts __omp_worker_stats_sync
## Contract
workerHostEntry() must be used at spawn sites.
## Unrelated UI
packages/tui/src/widgets/list.ts renders terminal lists.
## Catalog
packages/catalog/src/models.json is generated.
## Changelog
packages/coding-agent/CHANGELOG.md is user-facing.`,
		expectSections: ["__omp_worker_stats_sync"],
		rejectSections: ["packages/tui/src/widgets/list.ts"],
	},
];

export interface TriageTask {
	id: string;
	message: string;
	expect: "fact-in-repo" | "already-in-brief" | "decision" | "user-only" | "status";
}

export const TRIAGE_TASKS: TriageTask[] = [
	{
		id: "triage-repo-fact",
		message: "Which existing file defines jevAssist and what exact default does it use?",
		expect: "fact-in-repo",
	},
	{
		id: "triage-repo-caller",
		message: "Can you point me to the current caller of filterReviewFindings in this checkout?",
		expect: "fact-in-repo",
	},
	{
		id: "triage-already-brief",
		message:
			"The brief already names packages/coding-agent/src/task/jev-context.ts and the focused test; should I rediscover those same anchors?",
		expect: "already-in-brief",
	},
	{
		id: "triage-decision",
		message:
			"Should this change preserve the old route as an alias, or should we do a clean cutover and migrate callers?",
		expect: "decision",
	},
	{
		id: "triage-decision-scope",
		message: "Do we include a new persistence table in this feature, or keep the existing review-findings store?",
		expect: "decision",
	},
	{
		id: "triage-user-only",
		message: "What private API key should I use to reach the external Jev endpoint?",
		expect: "user-only",
	},
	{
		id: "triage-user-only-approval",
		message: "Can the account owner approve publishing this branch to the remote fork?",
		expect: "user-only",
	},
	{
		id: "triage-status",
		message: "Implementation finished; focused test passed and no blocker remains.",
		expect: "status",
	},
];

export interface EvidenceTask {
	id: string;
	assignment: string;
	output: string;
	expect: "strong" | "weak";
}

export const EVIDENCE_TASKS: EvidenceTask[] = [
	{
		id: "evidence-strong-tests-and-failure",
		assignment: `Acceptance: (1) bun test packages/coding-agent/test/task/jev-evidence.test.ts -t evidence; (2) exercise missing failure-path output and expect weak.`,
		output: `- bun test packages/coding-agent/test/task/jev-evidence.test.ts -t evidence -> 6 pass\n- failure path: report without failure output -> evidence=weak\n- valid report path -> evidence=strong\nBoth acceptance items checked.`,
		expect: "strong",
	},
	{
		id: "evidence-strong-build-and-runtime",
		assignment: `Acceptance: (1) bun check; (2) bun evals/subagent-assist/run.ts --list; (3) verify Jev unavailable path prints a clear message.`,
		output: `- bun check -> 0 errors\n- bun evals/subagent-assist/run.ts --list -> exit 0, every task id listed\n- empty TYPESAFE_SYSTEMONE_URL -> "Jev unavailable" and exit 1\nAll acceptance items and failure behavior checked.`,
		expect: "strong",
	},
	{
		id: "evidence-strong-entrypoint",
		assignment: `Acceptance: (1) bun test packages/coding-agent/test/task/jev-findings.test.ts; (2) run the real filter path with blocker, nit, and drop cases; (3) confirm dropped count.`,
		output: `- bun test packages/coding-agent/test/task/jev-findings.test.ts -> 9 pass\n- real filter invocation -> kept blocker P1, nit P3\n- real filter invocation -> dropped=2\nFailure case with malformed answer -> original finding retained.`,
		expect: "strong",
	},
	{
		id: "evidence-weak-claim",
		assignment: "Acceptance requires bun check and a focused evidence test, including the weak failure path.",
		output: "Implemented as requested. All tests pass.",
		expect: "weak",
	},
	{
		id: "evidence-weak-green",
		assignment: "Acceptance requires running the CLI list command and checking the unavailable endpoint error.",
		output: "Everything is green and ready to merge.",
		expect: "weak",
	},
	{
		id: "evidence-weak-no-output",
		assignment: "Acceptance requires the persistence state query after the changed flow.",
		output: "The implementation works and the requested behavior is covered.",
		expect: "weak",
	},
];

export interface EvalFinding extends ReviewFindingRecordItem {
	id: string;
}

export interface FindingTask {
	id: string;
	findings: EvalFinding[];
	expectKeptIds: string[];
	expectPriorities: Record<string, "P1" | "P2" | "P3">;
}

function finding(
	id: string,
	title: string,
	body: string,
	priority: ReviewFindingRecordItem["priority"],
	filePath: string,
	lineStart: number,
	tag: string,
): EvalFinding {
	return {
		id,
		title,
		body: `${body} [${tag}]`,
		priority,
		confidence: 0.8,
		file_path: filePath,
		line_start: lineStart,
		line_end: lineStart + 2,
	};
}

export const FINDING_TASKS: FindingTask[] = [
	{
		id: "findings-auth-filter",
		findings: [
			finding(
				"auth-blocker",
				"Untrusted path escapes repo root",
				"A crafted path containing ../ can read another tenant's file when the review preview resolves it without a root check.",
				"P2",
				"packages/coding-agent/src/task/review-findings.ts",
				69,
				"scenario",
			),
			finding(
				"auth-should",
				"Missing regression coverage",
				"A permission change can reintroduce cross-tenant reads because no test drives the rejected path and asserts a safe error.",
				"P2",
				"packages/coding-agent/test/task/review-findings.test.ts",
				44,
				"scenario",
			),
			finding(
				"auth-nit",
				"Formatter would wrap this line",
				"Run the repository formatter so this long declaration matches surrounding style.",
				"P3",
				"packages/coding-agent/src/task/review-findings.ts",
				70,
				"formatter",
			),
			finding(
				"auth-drop",
				"Improve naming",
				"The variable name could be nicer.",
				"P3",
				"packages/coding-agent/src/task/review-findings.ts",
				71,
				"no-scenario",
			),
			finding(
				"auth-scope",
				"Add a dashboard redesign",
				"Please redesign the unrelated stats dashboard while fixing this path.",
				"P3",
				"packages/stats/src/ui.ts",
				12,
				"unrelated",
			),
		],
		expectKeptIds: ["auth-blocker", "auth-should"],
		expectPriorities: { "auth-blocker": "P1", "auth-should": "P2" },
	},
	{
		id: "findings-worker-contract",
		findings: [
			finding(
				"worker-blocker",
				"Worker selector is never dispatched",
				"The new worker can be spawned but cli.ts does not recognize __omp_worker_stats_sync, so every production invocation exits before handshake.",
				"P2",
				"packages/coding-agent/src/cli.ts",
				120,
				"scenario",
			),
			finding(
				"worker-should",
				"Smoke test omits the new worker",
				"A packaging regression can break compiled worker startup because ci:test:smoke does not ping this selector.",
				"P2",
				"packages/coding-agent/package.json",
				88,
				"scenario",
			),
			finding(
				"worker-nit",
				"Import order differs",
				"The formatter can normalize these imports; no runtime behavior changes.",
				"P3",
				"packages/coding-agent/src/cli.ts",
				18,
				"formatter",
			),
			finding(
				"worker-drop",
				"Use a different naming style",
				"This name is not ideal, but no failure follows from it.",
				"P3",
				"packages/coding-agent/src/cli.ts",
				121,
				"no-scenario",
			),
			finding(
				"worker-scope",
				"Replace the whole build system",
				"Switch all packages to a new build system as part of this worker fix.",
				"P3",
				"package.json",
				1,
				"unrelated",
			),
		],
		expectKeptIds: ["worker-blocker", "worker-should"],
		expectPriorities: { "worker-blocker": "P1", "worker-should": "P2" },
	},
	{
		id: "findings-context-contract",
		findings: [
			finding(
				"context-blocker",
				"Negative constraint is discarded",
				"When the only relevant section says do not edit CHANGELOG.md, dropping it lets the agent modify a protected release artifact.",
				"P2",
				"packages/coding-agent/src/task/jev-context.ts",
				110,
				"scenario",
			),
			finding(
				"context-should",
				"No duplicate-section check",
				"Repeated collector output can fill maxSections and hide the actual contract section, causing the next agent to miss a required constraint.",
				"P2",
				"packages/coding-agent/src/task/jev-context.ts",
				56,
				"scenario",
			),
			finding(
				"context-nit",
				"Line can be formatted",
				"The formatter would split this call for consistency with adjacent code.",
				"P3",
				"packages/coding-agent/src/task/jev-context.ts",
				123,
				"formatter",
			),
			finding(
				"context-drop",
				"Rename helper",
				"A different helper name might read better.",
				"P3",
				"packages/coding-agent/src/task/jev-context.ts",
				32,
				"no-scenario",
			),
			finding(
				"context-scope",
				"Add browser support",
				"Build a browser UI for this context helper even though this change is backend-only.",
				"P3",
				"packages/coding-agent/src/task/jev-context.ts",
				124,
				"unrelated",
			),
		],
		expectKeptIds: ["context-blocker", "context-should"],
		expectPriorities: { "context-blocker": "P1", "context-should": "P2" },
	},
	{
		id: "findings-evidence-contract",
		findings: [
			finding(
				"evidence-blocker",
				"Success claim lacks observed output",
				"A green test claim without command output can hide a failing acceptance item, so release readiness is falsely reported.",
				"P2",
				"packages/coding-agent/src/task/jev-evidence.ts",
				17,
				"scenario",
			),
			finding(
				"evidence-should",
				"Failure path is not checked",
				"The evaluator can call a report strong even when the required failure branch was never exercised, weakening the evidence contract.",
				"P2",
				"packages/coding-agent/src/task/jev-evidence.ts",
				38,
				"scenario",
			),
			finding(
				"evidence-nit",
				"Add a blank line",
				"Formatting-only whitespace would make this section easier to scan.",
				"P3",
				"packages/coding-agent/src/task/jev-evidence.ts",
				39,
				"formatter",
			),
			finding(
				"evidence-drop",
				"Improve prose tone",
				"The report could sound more polished.",
				"P3",
				"packages/coding-agent/src/task/jev-evidence.ts",
				40,
				"no-scenario",
			),
			finding(
				"evidence-scope",
				"Rewrite all acceptance tests",
				"Replace unrelated package tests with a new framework while changing evidence scoring.",
				"P3",
				"packages/ai/test/example.test.ts",
				1,
				"unrelated",
			),
		],
		expectKeptIds: ["evidence-blocker", "evidence-should"],
		expectPriorities: { "evidence-blocker": "P1", "evidence-should": "P2" },
	},
	{
		id: "findings-cli-scope",
		findings: [
			finding(
				"cli-blocker",
				"Unavailable Jev path crashes without message",
				"An empty endpoint causes the eval runner to throw a generic stack trace instead of the documented clear refusal, blocking operators from fixing configuration.",
				"P2",
				"evals/subagent-assist/run.ts",
				100,
				"scenario",
			),
			finding(
				"cli-should",
				"Results omit model identity",
				"Without endpoint and model identity, two runs cannot be compared when probabilistic accuracy changes.",
				"P2",
				"evals/subagent-assist/run.ts",
				220,
				"scenario",
			),
			finding(
				"cli-nit",
				"Table spacing is inconsistent",
				"The formatter can align this markdown row; behavior is unchanged.",
				"P3",
				"evals/subagent-assist/run.ts",
				240,
				"formatter",
			),
			finding(
				"cli-drop",
				"Use shorter variable names",
				"Shorter names would be preferable.",
				"P3",
				"evals/subagent-assist/run.ts",
				241,
				"no-scenario",
			),
			finding(
				"cli-scope",
				"Add deployment automation",
				"Create production deployment automation for this local eval harness.",
				"P3",
				".github/workflows/release.yml",
				30,
				"unrelated",
			),
		],
		expectKeptIds: ["cli-blocker", "cli-should"],
		expectPriorities: { "cli-blocker": "P1", "cli-should": "P2" },
	},
	{
		id: "findings-review-persistence",
		findings: [
			finding(
				"persist-blocker",
				"Finding priority is silently downgraded",
				"A P1 security finding can be stored as P3 after filtering, so the dashboard hides an issue that blocks release.",
				"P2",
				"packages/stats/src/review-findings.ts",
				37,
				"scenario",
			),
			finding(
				"persist-should",
				"Duplicate records are not stable",
				"Retrying persistence can create multiple rows for one finding and inflate the reviewer queue because the fingerprint is not reused.",
				"P2",
				"packages/stats/src/review-findings.ts",
				300,
				"scenario",
			),
			finding(
				"persist-nit",
				"Formatter nit",
				"This object literal should be formatted across lines by the repository formatter.",
				"P3",
				"packages/stats/src/review-findings.ts",
				360,
				"formatter",
			),
			finding(
				"persist-drop",
				"Add more comments",
				"More comments could make the implementation friendlier.",
				"P3",
				"packages/stats/src/review-findings.ts",
				361,
				"no-scenario",
			),
			finding(
				"persist-scope",
				"Change SQLite provider",
				"Replace the repository's database provider with a different product.",
				"P3",
				"packages/stats/src/review-findings.ts",
				362,
				"unrelated",
			),
		],
		expectKeptIds: ["persist-blocker", "persist-should"],
		expectPriorities: { "persist-blocker": "P1", "persist-should": "P2" },
	},
];
