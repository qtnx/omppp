import { describe, expect, test } from "bun:test";
import { collectReviewFindingRecordItems, isReviewFindingAgent } from "../../src/task/review-findings";
import type { SingleResult } from "../../src/task/types";

describe("task review findings capture", () => {
	test("only reviewer agent names enable finding persistence", () => {
		expect(isReviewFindingAgent("reviewer")).toBe(true);
		expect(isReviewFindingAgent("code-reviewer")).toBe(true);
		expect(isReviewFindingAgent("Code-Reviewer")).toBe(false);
		expect(isReviewFindingAgent("task")).toBe(false);
	});

	test("extracts only valid report_finding tool payloads", () => {
		const result: SingleResult = {
			index: 0,
			id: "review-1",
			agent: "reviewer",
			agentSource: "bundled",
			task: "review",
			exitCode: 0,
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
			extractedToolData: {
				report_finding: [
					{
						title: "Fix stale state handling",
						body: "State is reused after refresh.",
						priority: "P1",
						confidence: 0.9,
						file_path: "src/state.ts",
						line_start: 12,
						line_end: 18,
					},
					{
						title: "Reject malformed priority",
						body: "Priority is not a review-finding label.",
						priority: 1,
						confidence: 0.9,
						file_path: "src/state.ts",
						line_start: 12,
						line_end: 18,
					},
					{
						title: "Reject reversed range",
						body: "The end line cannot precede the start line.",
						priority: "P1",
						confidence: 0.9,
						file_path: "src/state.ts",
						line_start: 18,
						line_end: 12,
					},
					{
						title: "Reject fractional line",
						body: "Fractional line values cannot anchor a patch.",
						priority: "P1",
						confidence: 0.9,
						file_path: "src/state.ts",
						line_start: 12.5,
						line_end: 18,
					},
				],
			},
		};

		expect(collectReviewFindingRecordItems(result)).toEqual([
			{
				title: "Fix stale state handling",
				body: "State is reused after refresh.",
				priority: "P1",
				confidence: 0.9,
				file_path: "src/state.ts",
				line_start: 12,
				line_end: 18,
			},
		]);
	});

	test("extracts reviewer issue arrays from yielded structured output", () => {
		const result: SingleResult = {
			index: 0,
			id: "review-2",
			agent: "code-reviewer",
			agentSource: "bundled",
			task: "review",
			exitCode: 0,
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
			extractedToolData: {
				yield: [
					{
						status: "success",
						data: {
							blockers: [
								{
									title: "Refresh list after save",
									confidence: 95,
									file: "packages/stats/src/client/components/ReviewFindingsView.tsx",
									lines: "32-55, 76-87",
									why: "The pending list remains stale after saving.",
									impact: "The dashboard can show saved items as pending.",
									fix: "Reload the list and reselect an item after save.",
								},
							],
							important_non_blocking_issues: [
								{
									title: "Keep selected detail after save",
									file: "packages/stats/src/client/components/ReviewFindingsView.tsx",
									line: 109,
									suggestion: "Use the saved finding detail when a refresh races.",
								},
							],
							missing_tests: [
								{
									title: "Add pending-list save coverage",
									files: ["packages/stats/src/client/components/ReviewFindingsView.tsx"],
									why: "The default pending flow is not covered.",
								},
							],
						},
					},
				],
			},
		};

		expect(collectReviewFindingRecordItems(result)).toEqual([
			{
				title: "Refresh list after save",
				body: [
					"Why: The pending list remains stale after saving.",
					"Impact: The dashboard can show saved items as pending.",
					"Fix: Reload the list and reselect an item after save.",
					"Lines: 32-55, 76-87",
				].join("\n"),
				priority: "P1",
				confidence: 0.95,
				file_path: "packages/stats/src/client/components/ReviewFindingsView.tsx",
				line_start: 32,
				line_end: 55,
			},
			{
				title: "Keep selected detail after save",
				body: "Suggestion: Use the saved finding detail when a refresh races.",
				priority: "P2",
				confidence: 0.8,
				file_path: "packages/stats/src/client/components/ReviewFindingsView.tsx",
				line_start: 109,
				line_end: 109,
			},
			{
				title: "Add pending-list save coverage",
				body: [
					"Why: The default pending flow is not covered.",
					"Files: packages/stats/src/client/components/ReviewFindingsView.tsx",
				].join("\n"),
				priority: "P2",
				confidence: 0.8,
				file_path: "packages/stats/src/client/components/ReviewFindingsView.tsx",
				line_start: 1,
				line_end: 1,
			},
		]);
	});

	test("extracts reviewer issues from JSON final output", () => {
		const result: SingleResult = {
			index: 0,
			id: "review-3",
			agent: "code-reviewer",
			agentSource: "bundled",
			task: "review",
			exitCode: 0,
			output: JSON.stringify({
				issues: [
					{
						severity: "important",
						title: "Prefer saved detail after refresh failure",
						description: "A saved finding can render stale pending state after refresh fails.",
						file: "packages/stats/src/client/components/ReviewFindingsView.tsx",
						line: "96, 104-107",
						confidence: 96,
					},
					{
						severity: "medium",
						title: "Preserve numeric line fields",
						description: "Backfilled yielded issues can store line as a number.",
						file: "packages/coding-agent/src/task/review-findings.ts",
						line: 243,
						confidence: 90,
					},
				],
			}),
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};

		expect(collectReviewFindingRecordItems(result)).toEqual([
			{
				title: "Prefer saved detail after refresh failure",
				body: "Description: A saved finding can render stale pending state after refresh fails.",
				priority: "P1",
				confidence: 0.96,
				file_path: "packages/stats/src/client/components/ReviewFindingsView.tsx",
				line_start: 96,
				line_end: 96,
			},
			{
				title: "Preserve numeric line fields",
				body: "Description: Backfilled yielded issues can store line as a number.",
				priority: "P2",
				confidence: 0.9,
				file_path: "packages/coding-agent/src/task/review-findings.ts",
				line_start: 243,
				line_end: 243,
			},
		]);
	});

	test("extracts numeric and string line range aliases", () => {
		const result: SingleResult = {
			index: 0,
			id: "review-4",
			agent: "code-reviewer",
			agentSource: "bundled",
			task: "review",
			exitCode: 0,
			output: JSON.stringify({
				issues: [
					{
						title: "Numeric lines alias",
						description: "The lines alias can be numeric.",
						file: "src/numeric-lines.ts",
						lines: 12,
					},
					{
						title: "String lineRange alias",
						description: "The lineRange alias can be a string range.",
						file: "src/string-line-range.ts",
						lineRange: "21-22",
					},
					{
						title: "Numeric line_range alias",
						description: "The line_range alias can be numeric.",
						file: "src/numeric-line-range.ts",
						line_range: 31,
					},
				],
			}),
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};

		expect(collectReviewFindingRecordItems(result).map(finding => [finding.line_start, finding.line_end])).toEqual([
			[12, 12],
			[21, 22],
			[31, 31],
		]);
	});

	test("extracts all review section aliases with their fallback priorities", () => {
		const result: SingleResult = {
			index: 0,
			id: "review-5",
			agent: "reviewer",
			agentSource: "bundled",
			task: "review",
			exitCode: 0,
			output: JSON.stringify({
				important_non_blocking: [
					{
						title: "Important alias",
						file: "src/important.ts",
						line: 10,
					},
				],
				non_blocking: [
					{
						title: "Non-blocking alias",
						file: "src/non-blocking.ts",
						line: 20,
					},
				],
				non_blocking_issues: [
					{
						title: "Non-blocking issues alias",
						file: "src/non-blocking-issues.ts",
						line: 30,
					},
				],
				findings: [
					{
						title: "Generic findings alias",
						file: "src/findings.ts",
						line: 40,
					},
				],
			}),
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};

		expect(collectReviewFindingRecordItems(result).map(finding => [finding.title, finding.priority])).toEqual([
			["Important alias", "P2"],
			["Non-blocking alias", "P3"],
			["Non-blocking issues alias", "P3"],
			["Generic findings alias", "P2"],
		]);
	});
});
