import type { ReviewFindingRecordItem } from "@oh-my-pi/omp-stats/review-findings";
import {
	JevError,
	jevModel,
	postSystemOne,
	type JevChoice,
	type JevQuestion,
	type JevRequest,
	validateChoice,
} from "../jev/systemone";
import findingVerdictInstructions from "../prompts/task/jev/finding-verdict.md" with { type: "text" };

const MAX_FINDINGS_PER_REQUEST = 40;
/** Minimum verdict confidence before a `drop` is allowed to erase a finding. */
const DROP_CONFIDENCE = 0.5;
const VERDICT_IDS = ["blocker", "should", "nit", "drop"] as const;
const VERDICT_CRITERIA: Record<string, string | null> = {
	blocker: null,
	should: null,
	nit: null,
	drop: null,
};
const PRIORITY_BY_VERDICT: Record<(typeof VERDICT_IDS)[number], ReviewFindingRecordItem["priority"] | null> = {
	blocker: "P1",
	should: "P2",
	nit: "P3",
	drop: null,
};

export interface FilterReviewFindingsInput {
	findings: ReviewFindingRecordItem[];
	post?: typeof postSystemOne;
	signal?: AbortSignal;
}

export interface FilterReviewFindingsResult {
	kept: ReviewFindingRecordItem[];
	dropped: number;
}

export async function filterReviewFindings(input: FilterReviewFindingsInput): Promise<FilterReviewFindingsResult> {
	const { findings } = input;
	if (findings.length === 0 || findings.length > MAX_FINDINGS_PER_REQUEST) {
		return { kept: findings, dropped: 0 };
	}

	const questions: Record<string, JevQuestion> = {};
	for (const [index, finding] of findings.entries()) {
		questions[`finding::${index}`] = {
			type: "choice",
			instructions: {
				question: findingVerdictInstructions,
				finding: {
					title: finding.title,
					body: finding.body,
					file_path: finding.file_path,
					line_start: finding.line_start,
					line_end: finding.line_end,
				},
			},
			criteria: VERDICT_CRITERIA,
		};
	}

	let answers: Record<string, unknown>;
	try {
		const request: JevRequest = {
			model: jevModel(),
			state: {
				findings: findings.map(finding => ({
					title: finding.title,
					body: finding.body,
					file_path: finding.file_path,
					line_start: finding.line_start,
					line_end: finding.line_end,
				})),
			},
			questions,
		};
		answers = (await (input.post ?? postSystemOne)(request, { timeoutMs: 8000, signal: input.signal })).answers;
	} catch (error) {
		if (error instanceof JevError) return { kept: findings, dropped: 0 };
		throw error;
	}

	const kept: ReviewFindingRecordItem[] = [];
	let dropped = 0;
	for (const [index, finding] of findings.entries()) {
		const answer = answers[`finding::${index}`];
		if (answer === undefined) {
			kept.push(finding);
			continue;
		}
		let verdict: JevChoice;
		try {
			verdict = validateChoice(answer, VERDICT_IDS);
		} catch (error) {
			if (error instanceof JevError) {
				kept.push(finding);
				continue;
			}
			throw error;
		}
		// A drop is destructive — it removes the finding from the record — so it
		// only applies when the verdict is confident. An uncertain `drop` keeps
		// the finding exactly as it arrived, including its original priority.
		if (verdict.choice === "drop" && verdict.confidence >= DROP_CONFIDENCE) {
			dropped += 1;
			continue;
		}
		const priority = PRIORITY_BY_VERDICT[verdict.choice as (typeof VERDICT_IDS)[number]];
		kept.push({
			...finding,
			priority: verdict.confidence >= 0.5 && priority !== null ? priority : finding.priority,
		});
	}
	return { kept, dropped };
}
