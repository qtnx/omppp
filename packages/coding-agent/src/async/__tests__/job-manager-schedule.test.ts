import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../job-manager";

function createManager(): AsyncJobManager {
	return new AsyncJobManager({ onJobComplete: () => undefined });
}

describe("AsyncJobManager scheduled poll windows", () => {
	test("escalates consecutive poll windows and resets after the idle gap", () => {
		const manager = createManager();
		const ownerId = "scheduled-owner";

		expect(manager.nextPollWaitMs(ownerId, 1_000)).toBe(5_000);
		manager.recordPollWaitEnd(ownerId, 10_000);

		expect(manager.nextPollWaitMs(ownerId, 10_000 + 59_999)).toBe(10_000);
		manager.recordPollWaitEnd(ownerId, 70_010);

		expect(manager.nextPollWaitMs(ownerId, 70_011)).toBe(30_000);
		manager.recordPollWaitEnd(ownerId, 70_020);

		// An idle gap past the reset window drops the ladder back to its floor.
		expect(manager.nextPollWaitMs(ownerId, 130_020)).toBe(5_000);
	});

	test("peek previews the next poll window without advancing the ladder", () => {
		const manager = createManager();
		manager.configurePollSchedule({ ladderMs: [300_000, 600_000, 900_000], resetMs: 120_000 });
		const ownerId = "peek-owner";

		expect(manager.nextPollWaitMs(ownerId, 1_000)).toBe(300_000);
		manager.recordPollWaitEnd(ownerId, 2_000);

		expect(manager.peekNextPollWaitMs(ownerId, 3_000)).toBe(600_000);
		expect(manager.peekNextPollWaitMs(ownerId, 3_001)).toBe(600_000);
		expect(manager.nextPollWaitMs(ownerId, 3_002)).toBe(600_000);
	});

	test("per-instance poll schedule overrides the wait ladder and reset seam", () => {
		const manager = createManager();
		const ownerId = "configured-owner";
		manager.configurePollSchedule({ ladderMs: [30, 60], resetMs: 5_000 });

		expect(manager.nextPollWaitMs(ownerId, 1_000)).toBe(30);
		manager.recordPollWaitEnd(ownerId, 1_030);
		expect(manager.nextPollWaitMs(ownerId, 2_000)).toBe(60);
	});
});
