import { describe, expect, it } from "bun:test";
import {
	type ScreenWakeDeps,
	ScreenWakeGuard,
	type ScreenWakeMode,
	type SilentVideoLoop,
	type WakeLockSentinelLike,
} from "../src/lib/screen-wake";

class FakeSentinel implements WakeLockSentinelLike {
	released = false;
	readonly #listeners = new Set<() => void>();

	async release(): Promise<void> {
		this.released = true;
	}
	addEventListener(_type: "release", listener: () => void): void {
		this.#listeners.add(listener);
	}
	removeEventListener(_type: "release", listener: () => void): void {
		this.#listeners.delete(listener);
	}
	/** The browser dropping the lock on its own — what backgrounding does. */
	drop(): void {
		this.released = true;
		for (const listener of [...this.#listeners]) listener();
	}
}

class FakeVideo implements SilentVideoLoop {
	playing = false;
	resumes = 0;
	stops = 0;

	resume(): void {
		this.playing = true;
		this.resumes++;
	}
	stop(): void {
		this.playing = false;
		this.stops++;
	}
}

interface Harness {
	deps: ScreenWakeDeps;
	sentinels: FakeSentinel[];
	videos: FakeVideo[];
	modes: ScreenWakeMode[];
	/** Flip `document.visibilityState` and fire `visibilitychange`. */
	setVisible(visible: boolean): void;
	listenerCount(): number;
}

function harness(overrides: Partial<ScreenWakeDeps> = {}): Harness {
	const sentinels: FakeSentinel[] = [];
	const videos: FakeVideo[] = [];
	const modes: ScreenWakeMode[] = [];
	const listeners = new Set<() => void>();
	let visible = true;

	const deps: ScreenWakeDeps = {
		requestWakeLock: async () => {
			const sentinel = new FakeSentinel();
			sentinels.push(sentinel);
			return sentinel;
		},
		createSilentVideo: () => {
			const video = new FakeVideo();
			videos.push(video);
			return video;
		},
		isVisible: () => visible,
		onVisibilityChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onMode: mode => modes.push(mode),
		...overrides,
	};

	return {
		deps,
		sentinels,
		videos,
		modes,
		setVisible(next) {
			visible = next;
			for (const listener of [...listeners]) listener();
		},
		listenerCount: () => listeners.size,
	};
}

describe("ScreenWakeGuard", () => {
	it("holds a screen wake lock for the call and releases it when the call ends", async () => {
		const h = harness();
		const guard = new ScreenWakeGuard(h.deps);

		await guard.start();
		expect(guard.mode).toBe("wake-lock");
		expect(h.sentinels).toHaveLength(1);
		// The lock is the whole mechanism: no video is created alongside it.
		expect(h.videos).toHaveLength(0);

		await guard.stop();
		expect(h.sentinels[0]?.released).toBe(true);
		expect(guard.mode).toBeNull();
		// No listener survives the call, so a later visibility flip cannot revive it.
		expect(h.listenerCount()).toBe(0);
	});

	it("re-acquires the lock when the page becomes visible again after the browser dropped it", async () => {
		const h = harness();
		const guard = new ScreenWakeGuard(h.deps);
		await guard.start();

		// Backgrounding: the page hides, then the browser releases the lock.
		h.setVisible(false);
		h.sentinels[0]?.drop();
		await guard.settled();
		expect(guard.mode).toBeNull();
		expect(h.sentinels).toHaveLength(1);

		h.setVisible(true);
		await guard.settled();
		expect(h.sentinels).toHaveLength(2);
		expect(guard.mode).toBe("wake-lock");

		await guard.stop();
		expect(h.sentinels[1]?.released).toBe(true);
	});

	it("falls back to the silent looping video when the browser has no Wake Lock API", async () => {
		const h = harness({ requestWakeLock: undefined });
		const guard = new ScreenWakeGuard(h.deps);

		await guard.start();
		expect(guard.mode).toBe("video");
		expect(h.videos).toHaveLength(1);
		expect(h.videos[0]?.playing).toBe(true);
		expect(h.sentinels).toHaveLength(0);

		await guard.stop();
		expect(h.videos[0]?.playing).toBe(false);
		expect(h.videos[0]?.stops).toBe(1);
		expect(guard.mode).toBeNull();
	});

	it("falls back when the request is refused, then drops the video once a retry is granted", async () => {
		let granted = false;
		const sentinels: FakeSentinel[] = [];
		const h = harness({
			requestWakeLock: async () => {
				if (!granted) throw new DOMException("denied", "NotAllowedError");
				const sentinel = new FakeSentinel();
				sentinels.push(sentinel);
				return sentinel;
			},
		});
		const guard = new ScreenWakeGuard(h.deps);

		await guard.start();
		expect(guard.mode).toBe("video");
		expect(h.videos[0]?.playing).toBe(true);

		// Foregrounding retries the better mechanism; only one may be live at a time.
		granted = true;
		h.setVisible(true);
		await guard.settled();
		expect(guard.mode).toBe("wake-lock");
		expect(h.videos[0]?.playing).toBe(false);
		expect(h.videos[0]?.stops).toBe(1);

		await guard.stop();
		expect(sentinels[0]?.released).toBe(true);
	});

	it("does nothing when neither mechanism exists, and never throws at the call", async () => {
		const h = harness({ requestWakeLock: undefined, createSilentVideo: () => undefined });
		const guard = new ScreenWakeGuard(h.deps);

		await guard.start();
		expect(guard.mode).toBeNull();
		await guard.stop();
		expect(h.listenerCount()).toBe(0);
	});

	it("releases a lock granted after the call already ended", async () => {
		const h = harness();
		const guard = new ScreenWakeGuard(h.deps);

		const starting = guard.start();
		// The call dies mid-request — the sentinel still arrives afterwards.
		await guard.stop();
		await starting;
		await guard.settled();

		expect(h.sentinels[0]?.released).toBe(true);
		expect(guard.mode).toBeNull();
		expect(h.videos).toHaveLength(0);
	});

	it("stays torn down when stop is called twice", async () => {
		const h = harness({ requestWakeLock: undefined });
		const guard = new ScreenWakeGuard(h.deps);

		await guard.start();
		await guard.stop();
		await guard.stop();

		expect(h.videos[0]?.stops).toBe(1);
		expect(guard.active).toBe(false);
		expect(h.listenerCount()).toBe(0);
	});
});
