import { describe, expect, test } from "bun:test";
import { mergeGenerationEvents } from "../src/client/components/ReviewFindingsView";
import type { ReviewFindingLessonGenerationEvent } from "../src/shared-types";

function event(sequence: number, message: string): ReviewFindingLessonGenerationEvent {
	return {
		sequence,
		jobId: "job-1",
		findingId: "finding-1",
		kind: "progress",
		message,
		progress: null,
		createdAt: sequence,
	};
}

describe("review finding generation event UI helpers", () => {
	test("merges streamed generation events by sequence without duplicating poll overlaps", () => {
		const merged = mergeGenerationEvents(
			[event(1, "queued"), event(3, "reading source")],
			[event(2, "started"), event(3, "reading source updated"), event(4, "saved")],
		);

		expect(merged.map(item => [item.sequence, item.message])).toEqual([
			[1, "queued"],
			[2, "started"],
			[3, "reading source updated"],
			[4, "saved"],
		]);
	});
});
