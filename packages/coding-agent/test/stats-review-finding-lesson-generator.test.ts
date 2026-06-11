import { describe, expect, test, vi } from "bun:test";
import {
	createReviewFindingLessonGenerator,
	parseReviewFindingLessonOutput,
} from "../src/stats/review-finding-lesson-generator";
import * as taskExecutor from "../src/task/executor";
import type { SingleResult } from "../src/task/types";

function singleResult(output: string): SingleResult {
	return {
		index: 0,
		id: "review-finding-learning-writer",
		agent: "review-finding-learning-writer",
		agentSource: "bundled",
		task: "review finding lesson writer",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

describe("review finding lesson generator", () => {
	test("parses structured writer output into generated lesson fields", () => {
		expect(
			parseReviewFindingLessonOutput(
				JSON.stringify({
					facts: ["Review findings are persisted before lesson generation."],
					lesson: "Generate distilled lessons from review findings.",
					rationale: "Raw review comments are noisy durable guidance.",
					apply_when: ["A finding exposes repeatable repo behavior."],
					avoid: ["Do not store the original review body verbatim."],
					source_summary: "packages/stats/src/review-findings.ts:1",
				}),
			),
		).toEqual({
			facts: ["Review findings are persisted before lesson generation."],
			lesson: "Generate distilled lessons from review findings.",
			rationale: "Raw review comments are noisy durable guidance.",
			applyWhen: ["A finding exposes repeatable repo behavior."],
			avoid: ["Do not store the original review body verbatim."],
			sourceSummary: "packages/stats/src/review-findings.ts:1",
		});
	});

	test("runs the bundled writer agent with static prompt contract and forwards progress", async () => {
		const forwardedProgress: unknown[] = [];
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			expect(options.agent.name).toBe("review-finding-learning-writer");
			expect(options.agent.tools).toEqual(["read"]);
			expect(options.cwd).toBe("/repo");
			expect(options.task).toContain("Review finding JSON");
			expect(options.task).toContain("review-finding-1");
			expect(options.outputSchema).toBeDefined();
			options.onProgress?.({
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				status: "running",
				task: options.task,
				lastIntent: "Read the referenced source before writing a lesson.",
				currentTool: "read",
				currentToolArgs: "packages/stats/src/review-findings.ts:1-80",
				recentTools: [],
				recentOutput: ["Inspecting source context."],
				toolCount: 1,
				tokens: 128,
				requests: 1,
				contextTokens: 512,
				contextWindow: 4096,
				cost: 0.004,
				durationMs: 125,
				resolvedModel: "pi/task",
			});
			return singleResult(
				JSON.stringify({
					facts: ["Fact"],
					lesson: "Lesson",
					rationale: "Rationale",
					apply_when: ["Apply"],
					avoid: [],
					source_summary: "Source",
				}),
			);
		});
		try {
			const generator = createReviewFindingLessonGenerator();
			const result = await generator({
				finding: {
					id: "review-finding-1",
					repoName: "repo",
					repoRoot: "/repo",
					agent: "code-reviewer",
					taskId: "ReviewTask",
					taskDescription: "review task",
					title: "Do not save raw comments",
					bodyPreview: "Raw body",
					body: "Raw body",
					priorityLabel: "P1",
					priority: 1,
					confidence: 0.95,
					filePath: "packages/stats/src/review-findings.ts",
					lineStart: 1,
					lineEnd: 2,
					taskExitCode: 0,
					taskAborted: false,
					firstSeenAt: 1,
					lastSeenAt: 2,
					occurrenceCount: 1,
					learningId: null,
					learningSavedAt: null,
					cwd: "/repo",
					taskAssignment: "review assignment",
					outputPath: "/tmp/review.md",
					sessionFile: "/tmp/session.jsonl",
					resolvedModel: "openai/test",
				},
				onProgress: progress => {
					forwardedProgress.push(progress);
				},
			});
			expect(result).toEqual({
				facts: ["Fact"],
				lesson: "Lesson",
				rationale: "Rationale",
				applyWhen: ["Apply"],
				avoid: [],
				sourceSummary: "Source",
			});
			expect(forwardedProgress).toEqual([
				expect.objectContaining({
					status: "running",
					message: "Using read: packages/stats/src/review-findings.ts:1-80",
					currentTool: "read",
					currentToolArgs: "packages/stats/src/review-findings.ts:1-80",
					recentOutput: ["Inspecting source context."],
					toolCount: 1,
					tokens: 128,
					contextTokens: 512,
					contextWindow: 4096,
					cost: 0.004,
					durationMs: 125,
					resolvedModel: "pi/task",
				}),
			]);
			expect(runSpy).toHaveBeenCalledTimes(1);
		} finally {
			runSpy.mockRestore();
		}
	});
});
