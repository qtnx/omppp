import { describe, expect, test } from "bun:test";
import type { JevPostOptions, JevRequest, JevResponse } from "../../src/jev/systemone";
import { JevError } from "../../src/jev/systemone";
import { filterReviewFindings } from "../../src/task/jev-findings";
import type { ReviewFindingRecordItem } from "@oh-my-pi/omp-stats/review-findings";

function finding(index: number, priority: ReviewFindingRecordItem["priority"] = "P2"): ReviewFindingRecordItem {
	return {
		title: `Finding ${index}`,
		body: `Failure scenario ${index}`,
		priority,
		confidence: 0.8,
		file_path: `src/file-${index}.ts`,
		line_start: index + 1,
		line_end: index + 1,
	};
}

function answer(choice: string, confidence: number): Record<string, unknown> {
	const probabilities = {
		blocker: choice === "blocker" ? 0.7 : 0.1,
		should: choice === "should" ? 0.7 : 0.1,
		nit: choice === "nit" ? 0.7 : 0.1,
		drop: choice === "drop" ? 0.7 : 0.1,
	};
	return { choice, confidence, probabilities };
}

describe("filterReviewFindings", () => {
	test("an uncertain drop preserves the original high-priority finding", async () => {
		const original = finding(0, "P1");
		const result = await filterReviewFindings({
			findings: [original],
			post: async () => ({ answers: { "finding::0": answer("drop", 0.4) } }),
		});
		expect(result).toEqual({ kept: [original], dropped: 0 });
	});

	test("remaps priorities, drops verdicts, and preserves low-confidence priorities", async () => {
		const findings = [finding(0, "P3"), finding(1, "P1"), finding(2, "P2"), finding(3, "P1"), finding(4, "P0")];
		let request: JevRequest | undefined;
		const post = async (body: JevRequest, _options?: JevPostOptions): Promise<JevResponse> => {
			request = body;
			return {
				answers: {
					"finding::0": answer("blocker", 0.9),
					"finding::1": answer("should", 0.8),
					"finding::2": answer("nit", 0.7),
					"finding::3": answer("drop", 0.9),
					"finding::4": answer("blocker", 0.4),
				},
			};
		};

		const result = await filterReviewFindings({ findings, post });

		expect(result.kept.map(item => item.priority)).toEqual(["P1", "P2", "P3", "P0"]);
		expect(result.kept.map(item => item.title)).toEqual(["Finding 0", "Finding 1", "Finding 2", "Finding 4"]);
		expect(result.dropped).toBe(1);
		expect(Object.keys(request?.questions ?? {})).toEqual([
			"finding::0",
			"finding::1",
			"finding::2",
			"finding::3",
			"finding::4",
		]);
	});

	test("returns findings unchanged when Jev fails", async () => {
		const findings = [finding(0, "P3")];
		const post = async (): Promise<never> => {
			throw new JevError("offline", "connection");
		};

		expect(await filterReviewFindings({ findings, post })).toEqual({ kept: findings, dropped: 0 });
	});

	test("skips Jev when more than 40 findings are present", async () => {
		const findings = Array.from({ length: 41 }, (_, index) => finding(index));
		let calls = 0;
		const post = async (): Promise<JevResponse> => {
			calls += 1;
			return { answers: {} };
		};

		expect(await filterReviewFindings({ findings, post })).toEqual({ kept: findings, dropped: 0 });
		expect(calls).toBe(0);
	});
});
