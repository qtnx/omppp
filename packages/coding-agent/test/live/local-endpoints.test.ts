import { describe, expect, test } from "bun:test";
import { LiveInputDeviceError, type LivePeerLike, LocalMediaEndpoint } from "../../src/live/local-endpoints";

function pcm(level: number, length = 160): Float32Array {
	return new Float32Array(length).fill(level);
}

function fakePeer(pushed: Float32Array[]): LivePeerLike {
	return {
		createOffer: async () => "offer",
		acceptAnswer: async () => {},
		waitForOpen: async () => {},
		pushAudio: samples => pushed.push(samples),
		setMuted: () => {},
		close: async () => {},
	};
}

describe("LocalMediaEndpoint echo gate", () => {
	test("drops mic frames below the barge-in threshold while output is active, forwards above", async () => {
		const pushed: Float32Array[] = [];
		let onLevel: ((error: Error | null, level: number) => void) | undefined;
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;

		const media = new LocalMediaEndpoint({
			createPeer: (_event, level) => {
				onLevel = level;
				return fakePeer(pushed);
			},
			createCapture: (_rate, audio) => {
				onAudio = audio;
				return { stop: () => {} };
			},
		});

		await media.createOffer();
		await media.acceptAnswer("answer");
		await media.waitForOpen();
		expect(onAudio).toBeDefined();

		// Assistant speaking loudly: echo threshold = max(0.04, 0.5 * 0.65) = 0.325.
		onLevel?.(null, 0.5);
		onAudio?.(null, pcm(0.1)); // below threshold — treated as echo, dropped
		expect(pushed).toHaveLength(0);

		onAudio?.(null, pcm(0.5)); // above threshold — genuine barge-in, forwarded
		expect(pushed).toHaveLength(1);
		expect(pushed[0]?.[0]).toBeCloseTo(0.5);
	});

	test("forwards a quiet mic frame when the assistant is silent", async () => {
		const pushed: Float32Array[] = [];
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const media = new LocalMediaEndpoint({
			createPeer: () => fakePeer(pushed),
			createCapture: (_rate, audio) => {
				onAudio = audio;
				return { stop: () => {} };
			},
		});

		await media.createOffer();
		await media.waitForOpen();
		onAudio?.(null, pcm(0.02)); // quiet, but no active output → forwarded
		expect(pushed).toHaveLength(1);
	});

	test("reports the microphone input level to the visualizer handler", async () => {
		const levels: number[] = [];
		let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
		const media = new LocalMediaEndpoint({
			createPeer: () => fakePeer([]),
			createCapture: (_rate, audio) => {
				onAudio = audio;
				return { stop: () => {} };
			},
		});
		media.onInputLevel(level => levels.push(level));

		await media.createOffer();
		await media.waitForOpen();
		onAudio?.(null, pcm(0.3));
		expect(levels.at(-1)).toBeCloseTo(0.3);
	});
});

describe("LocalMediaEndpoint device failure", () => {
	test("wraps a capture-open failure as actionable guidance", async () => {
		const media = new LocalMediaEndpoint({
			createPeer: () => fakePeer([]),
			createCapture: () => {
				throw new Error("cpal: no default input device");
			},
		});

		await media.createOffer();
		let caught: unknown;
		try {
			await media.waitForOpen();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(LiveInputDeviceError);
		expect(caught instanceof Error ? caught.message : "").toContain("ompx live --attach");
	});
});
