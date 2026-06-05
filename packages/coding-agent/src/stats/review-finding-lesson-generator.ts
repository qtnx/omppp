import type { ReviewFindingGeneratedLesson, ReviewFindingLessonGenerator } from "@oh-my-pi/omp-stats/review-findings";
import type { ReviewFindingLessonGenerationProgress } from "@oh-my-pi/omp-stats/shared-types";
import { Effort } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import reviewFindingLessonSystemPrompt from "../prompts/stats/review-finding-lesson-system.md" with { type: "text" };
import reviewFindingLessonUserPrompt from "../prompts/stats/review-finding-lesson-user.md" with { type: "text" };
import * as taskExecutor from "../task/executor";
import type { AgentDefinition, AgentProgress, SingleResult } from "../task/types";

const REVIEW_FINDING_LESSON_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		facts: { type: "array", items: { type: "string" } },
		lesson: { type: "string" },
		rationale: { type: "string" },
		apply_when: { type: "array", items: { type: "string" } },
		avoid: { type: "array", items: { type: "string" } },
		source_summary: { type: "string" },
	},
	required: ["facts", "lesson", "rationale", "apply_when", "avoid", "source_summary"],
} as const;

const REVIEW_FINDING_LESSON_AGENT: AgentDefinition = {
	name: "review-finding-learning-writer",
	description: "Distills code-review findings into durable repository learning lessons",
	systemPrompt: reviewFindingLessonSystemPrompt,
	tools: ["read"],
	model: ["pi/task", "pi/slow"],
	thinkingLevel: Effort.High,
	output: REVIEW_FINDING_LESSON_OUTPUT_SCHEMA,
	source: "bundled",
};

export function createReviewFindingLessonGenerator(): ReviewFindingLessonGenerator {
	return async input => {
		const task = prompt.render(reviewFindingLessonUserPrompt, {
			finding_json: JSON.stringify(input.finding, null, 2),
		});
		const result = await taskExecutor.runSubprocess({
			cwd: input.finding.repoRoot,
			agent: REVIEW_FINDING_LESSON_AGENT,
			task,
			index: 0,
			id: "review-finding-learning-writer",
			thinkingLevel: Effort.High,
			outputSchema: REVIEW_FINDING_LESSON_OUTPUT_SCHEMA,
			enableLsp: false,
			onProgress: progress => {
				void input.onProgress(toReviewFindingLessonProgress(progress));
			},
		});
		if (result.exitCode !== 0) throw new Error(reviewFindingLessonFailure(result));
		const parsed = parseReviewFindingLessonOutput(result.output);
		if (!parsed) throw new Error("Review finding lesson writer returned invalid structured output.");
		return parsed;
	};
}

function toReviewFindingLessonProgress(progress: AgentProgress): ReviewFindingLessonGenerationProgress {
	return {
		status: toLessonGenerationStatus(progress.status),
		message: progressMessage(progress),
		...(progress.lastIntent ? { lastIntent: progress.lastIntent } : {}),
		...(progress.currentTool ? { currentTool: progress.currentTool } : {}),
		...(progress.currentToolArgs ? { currentToolArgs: progress.currentToolArgs } : {}),
		recentTools: progress.recentTools,
		recentOutput: progress.recentOutput,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		...(progress.contextTokens !== undefined ? { contextTokens: progress.contextTokens } : {}),
		...(progress.contextWindow !== undefined ? { contextWindow: progress.contextWindow } : {}),
		cost: progress.cost,
		durationMs: progress.durationMs,
		...(progress.resolvedModel ? { resolvedModel: progress.resolvedModel } : {}),
	};
}

function toLessonGenerationStatus(status: AgentProgress["status"]): ReviewFindingLessonGenerationProgress["status"] {
	if (status === "pending") return "queued";
	if (status === "completed") return "succeeded";
	if (status === "aborted") return "failed";
	return status;
}

function progressMessage(progress: AgentProgress): string {
	if (progress.currentTool) {
		return progress.currentToolArgs
			? `Using ${progress.currentTool}: ${progress.currentToolArgs}`
			: `Using ${progress.currentTool}`;
	}
	if (progress.lastIntent) return progress.lastIntent;
	const recent = progress.recentOutput[0]?.trim();
	if (recent) return recent;
	return `${progress.agent} ${progress.status}`;
}
export function parseReviewFindingLessonOutput(output: string): ReviewFindingGeneratedLesson | null {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		const facts = readStringArray(record.facts, false);
		const applyWhen = readStringArray(record.apply_when, false);
		const avoid = readStringArray(record.avoid, true);
		const lesson = readString(record.lesson);
		const rationale = readString(record.rationale);
		const sourceSummary = readString(record.source_summary);
		if (facts.length === 0 || applyWhen.length === 0 || !lesson || !rationale || !sourceSummary) return null;
		return { facts, lesson, rationale, applyWhen, avoid, sourceSummary };
	} catch {
		return null;
	}
}

function readStringArray(value: unknown, allowEmpty: boolean): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	for (const item of value) {
		const text = readString(item);
		if (text) result.push(text);
	}
	return result.length > 0 || allowEmpty ? result : [];
}

function readString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text.length > 0 ? text : null;
}

function reviewFindingLessonFailure(result: SingleResult): string {
	return (
		result.stderr || result.error || result.abortReason || result.output || "Review finding lesson writer failed."
	);
}
