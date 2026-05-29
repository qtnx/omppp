/**
 * Hard review gate that wraps an isolated subagent.
 *
 * Sits between the implementation subagent and the final patch/branch capture:
 * spawns a reviewer agent against the current isolated diff, optionally loops
 * through a fixer agent when blocking findings surface, and refuses to merge
 * when the gate stays blocked. Designed to be invoked only for isolated tasks
 * (`task.isolation.mode !== "none"` + `isolated: true`); the caller MUST
 * short-circuit before isolation work when the gate is enabled but the call
 * is non-isolated.
 *
 * The gate never calls `captureDeltaPatch` itself. Instead, the caller passes a
 * `captureDelta` closure that returns the current isolated delta (root +
 * nested patches). The gate composes the diff text shown to the reviewer from
 * that delta, and on `passed` returns the accepted delta back to the caller so
 * the final patch capture can reuse it without re-running git plumbing.
 *
 * Errors thrown by `captureDelta` fail the gate closed with a clear
 * `Review gate diff capture failed: ...` failure reason. The gate never
 * silently swallows them into an empty diff.
 */

import { prompt } from "@oh-my-pi/pi-utils";
import fixerTemplate from "../prompts/system/task-review-gate-fixer.md" with { type: "text" };
import reviewerTemplate from "../prompts/system/task-review-gate-reviewer.md" with { type: "text" };
import { type ReportFindingDetails, toReviewFinding } from "../tools/review";
import type {
	AgentDefinition,
	ReviewData,
	ReviewFinding,
	ReviewGateIteration,
	ReviewGateOutcome,
	ReviewGateResult,
	ReviewSummary,
	SingleResult,
} from "./types";
import type { DeltaPatchResult } from "./worktree";

/** Runtime configuration consumed by the gate (already resolved against settings). */
export interface ReviewGateConfig {
	reviewerAgent: AgentDefinition;
	reviewerModel?: string[];
	fixerAgent: AgentDefinition;
	maxFixIterations: number;
	failOnPriorities: readonly number[];
	requireCorrectVerdict: boolean;
}

/** Per-call request handed to the caller-supplied subagent runners. */
export interface ReviewGateRunRequest {
	promptText: string;
	iteration: number;
}

export interface ReviewGateOptions {
	config: ReviewGateConfig;
	/** Original assignment text passed to the implementer. Rendered into reviewer/fixer prompts. */
	assignment: string;
	/** Optional task description, surfaced to the reviewer/fixer for context. */
	description?: string;
	/**
	 * Capture the current isolated delta (root + nested patches). The gate
	 * composes the reviewer-facing diff text from the returned `DeltaPatchResult`
	 * and, on a passing iteration, threads the accepted delta back to the caller
	 * via `ReviewGateRunResult.acceptedDelta` so the final patch write can reuse
	 * it. The gate fails closed when this throws.
	 */
	captureDelta: () => Promise<DeltaPatchResult>;
	/** Invoke the reviewer agent. Caller binds isolation/context. */
	runReviewer: (request: ReviewGateRunRequest) => Promise<SingleResult>;
	/** Invoke the fixer agent inside the same isolation dir. */
	runFixer: (request: ReviewGateRunRequest) => Promise<SingleResult>;
	signal?: AbortSignal;
}

export interface ReviewGateRunResult {
	/** True only when the gate reached `passed`. `skipped` is treated as passing for merge purposes. */
	passed: boolean;
	result: ReviewGateResult;
	/**
	 * Delta captured for the final accepted reviewer pass. Populated only when
	 * `passed === true`; reused by the caller to avoid recapturing the patch
	 * after the gate has already inspected the worktree.
	 */
	acceptedDelta?: DeltaPatchResult;
}

interface YieldExtractedItem {
	data?: unknown;
	status?: string;
	error?: string;
}

interface DiffStats {
	filesChanged: number;
	linesAdded: number;
	linesRemoved: number;
}

interface BlockerInput {
	reviewData: ReviewData;
	blockingFindings: readonly ReviewFinding[];
	requireCorrectVerdict: boolean;
	blockingLabel: string;
}

/**
 * Run the reviewer/fixer loop. Returns once the gate reaches a terminal
 * outcome (`passed`, `blocked`, `failed`, or `skipped`).
 */
export async function runReviewGate(options: ReviewGateOptions): Promise<ReviewGateRunResult> {
	const {
		config: { reviewerAgent, fixerAgent, maxFixIterations, failOnPriorities, requireCorrectVerdict },
		assignment,
		description,
		captureDelta,
		runReviewer,
		runFixer,
		signal,
	} = options;

	const blockingSet = new Set<number>(failOnPriorities);
	const sortedBlocking = [...blockingSet].sort((a, b) => a - b);
	const blockingLabel = sortedBlocking.map(p => `P${p}`).join(", ");

	const iterations: ReviewGateIteration[] = [];
	let lastReviewData: ReviewData | undefined;
	let acceptedDelta: DeltaPatchResult | undefined;
	let outcome: ReviewGateOutcome = "failed";
	let failureReason: string | undefined;

	// One reviewer pass per iteration; a fixer runs between passes whenever
	// blockers persist and the max-iteration budget still allows it.
	for (let i = 0; i <= maxFixIterations; i++) {
		if (signal?.aborted) {
			outcome = "failed";
			failureReason = "Review gate aborted before reviewer ran.";
			break;
		}

		let delta: DeltaPatchResult;
		try {
			delta = await captureDelta();
		} catch (err) {
			outcome = "failed";
			failureReason = `Review gate diff capture failed: ${err instanceof Error ? err.message : String(err)}`;
			break;
		}
		const rawDiff = composeDiffText(delta);
		const stats = summarizeDiff(rawDiff);
		const reviewerPrompt = prompt.render(reviewerTemplate, {
			assignment,
			description: description ?? "",
			rawDiff,
			filesChanged: stats.filesChanged,
			linesAdded: stats.linesAdded,
			linesRemoved: stats.linesRemoved,
			iteration: i > 0 ? i + 1 : 0,
			maxIterations: maxFixIterations + 1,
			blockingPriorities: blockingLabel,
		});

		const reviewerResult = await runReviewer({ promptText: reviewerPrompt, iteration: i + 1 });
		const reviewData = extractReviewData(reviewerResult);
		lastReviewData = reviewData;
		const blockingFindings = reviewData.findings.filter(f => blockingSet.has(f.priority));

		const iteration: ReviewGateIteration = {
			iteration: i + 1,
			reviewerExitCode: reviewerResult.exitCode,
			reviewerAborted: Boolean(reviewerResult.aborted),
			reviewerError: reviewerResult.error,
			summary: reviewData.summary,
			findings: reviewData.findings,
			blockingFindings,
		};

		const reviewerFailures = collectReviewerFailures(reviewerResult, reviewData);
		if (reviewerFailures.length > 0) {
			iterations.push(iteration);
			outcome = "failed";
			failureReason = reviewerFailures.join(" ");
			break;
		}

		const blockers = collectBlockers({
			reviewData,
			blockingFindings,
			requireCorrectVerdict,
			blockingLabel,
		});

		if (blockers.length === 0) {
			iterations.push(iteration);
			acceptedDelta = delta;
			outcome = "passed";
			break;
		}

		// Fix budget exhausted — record the blocking iteration and stop.
		if (i >= maxFixIterations) {
			iterations.push(iteration);
			outcome = "blocked";
			failureReason = blockers.join(" ");
			break;
		}

		const nonBlockingFindings = reviewData.findings.filter(f => !blockingSet.has(f.priority));
		const fixerPrompt = prompt.render(fixerTemplate, {
			assignment,
			description: description ?? "",
			summary: reviewData.summary ?? {
				overall_correctness: "incorrect",
				explanation: "Reviewer did not submit a verdict.",
				confidence: 0,
			},
			blockingFindings,
			nonBlockingFindings,
			iteration: i + 1,
			maxIterations: maxFixIterations,
		});
		const fixerResult = await runFixer({ promptText: fixerPrompt, iteration: i + 1 });
		iteration.fixerExitCode = fixerResult.exitCode;
		iteration.fixerAborted = Boolean(fixerResult.aborted);
		iteration.fixerError = fixerResult.error;
		iterations.push(iteration);

		if (fixerResult.exitCode !== 0 || fixerResult.aborted) {
			outcome = "failed";
			failureReason = `Fixer agent failed: ${fixerResult.error ?? fixerResult.stderr ?? "unknown error"}`;
			break;
		}
	}

	return {
		passed: outcome === "passed",
		result: {
			enabled: true,
			outcome,
			reviewerAgent: reviewerAgent.name,
			fixerAgent: fixerAgent.name,
			failOnPriorities: sortedBlocking,
			maxFixIterations,
			iterations,
			finalReview: lastReviewData,
			failureReason,
		},
		acceptedDelta: outcome === "passed" ? acceptedDelta : undefined,
	};
}

function composeDiffText(delta: DeltaPatchResult): string {
	const parts: string[] = [];
	if (delta.rootPatch) parts.push(delta.rootPatch);
	for (const nested of [...delta.nestedPatches].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
		if (!nested.patch) continue;
		parts.push(`# Nested repo patch: ${nested.relativePath}\n${nested.patch}`);
	}
	return parts.join("\n");
}

function collectReviewerFailures(reviewerResult: SingleResult, reviewData: ReviewData): string[] {
	const failures: string[] = [];
	if (reviewerResult.aborted || reviewerResult.exitCode !== 0) {
		const abortNote = reviewerResult.aborted ? ", aborted" : "";
		failures.push(`Reviewer agent exited unsuccessfully (exit ${reviewerResult.exitCode}${abortNote}).`);
	} else if (!reviewData.summary) {
		failures.push("Reviewer agent did not submit a verdict via yield.");
	}
	return failures;
}

function collectBlockers(input: BlockerInput): string[] {
	const blockers: string[] = [];
	if (input.requireCorrectVerdict && input.reviewData.summary?.overall_correctness === "incorrect") {
		blockers.push(`Reviewer verdict incorrect: ${input.reviewData.summary.explanation}`);
	}
	if (input.blockingFindings.length > 0) {
		blockers.push(
			`${input.blockingFindings.length} blocking review finding(s) at priorities ${input.blockingLabel}.`,
		);
	}
	return blockers;
}

function extractReviewData(result: SingleResult): ReviewData {
	const findings: ReviewFinding[] = [];
	const rawFindings = result.extractedToolData?.report_finding as ReportFindingDetails[] | undefined;
	if (Array.isArray(rawFindings)) {
		for (const item of rawFindings) {
			findings.push(toReviewFinding(item));
		}
	}
	const yieldItems = result.extractedToolData?.yield as YieldExtractedItem[] | undefined;
	const lastYield = yieldItems?.[yieldItems.length - 1];
	const summary = lastYield?.status === "success" && !lastYield.error ? parseSummary(lastYield.data) : undefined;
	return { findings, summary };
}

function parseSummary(value: unknown): ReviewSummary | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const correctness = record.overall_correctness;
	if (correctness !== "correct" && correctness !== "incorrect") return undefined;
	const explanation = record.explanation;
	if (typeof explanation !== "string" || explanation.trim().length === 0) return undefined;
	const confidence = record.confidence;
	if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence <= 0 || confidence > 1) {
		return undefined;
	}
	return { overall_correctness: correctness, explanation, confidence };
}

function summarizeDiff(diff: string): DiffStats {
	let filesChanged = 0;
	let linesAdded = 0;
	let linesRemoved = 0;
	if (!diff) return { filesChanged, linesAdded, linesRemoved };
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			filesChanged++;
			continue;
		}
		if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
		if (line.startsWith("+")) {
			linesAdded++;
			continue;
		}
		if (line.startsWith("-")) linesRemoved++;
	}
	return { filesChanged, linesAdded, linesRemoved };
}
