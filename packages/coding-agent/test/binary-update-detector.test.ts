import { describe, expect, it } from "bun:test";
import { BinaryUpdateDetector } from "@oh-my-pi/pi-coding-agent/binary-update-detector";

describe("BinaryUpdateDetector", () => {
	it("reports an installed binary change once and includes the new version", async () => {
		let signature = { size: 10, mtimeMs: 100 };
		const version = "15.5.15";
		const detector = new BinaryUpdateDetector({
			path: "/tmp/omp",
			currentVersion: "15.5.14",
			stat: async () => signature,
			readInstalledVersion: async () => version,
		});

		expect(await detector.check()).toBeUndefined();

		signature = { size: 11, mtimeMs: 200 };
		expect(await detector.check()).toEqual({
			path: "/tmp/omp",
			currentVersion: "15.5.14",
			installedVersion: "15.5.15",
		});
		expect(await detector.check()).toBeUndefined();
	});
});
