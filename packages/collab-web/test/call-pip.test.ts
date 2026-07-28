import { describe, expect, it } from "bun:test";
import { CallPip, type CallPipDeps, type CallPipState, type PipSurface } from "../src/lib/call-pip";

class FakeSurface implements PipSurface {
	readonly draws: CallPipState[] = [];
	entered = 0;
	exited = 0;
	disposed = 0;
	failEnter: Error | undefined;
	#leave: (() => void) | undefined;

	draw(state: CallPipState): void {
		this.draws.push(state);
	}
	async enter(): Promise<void> {
		if (this.failEnter) throw this.failEnter;
		this.entered++;
	}
	async exit(): Promise<void> {
		this.exited++;
	}
	dispose(): void {
		this.disposed++;
	}
	onLeave(listener: () => void): void {
		this.#leave = listener;
	}
	/** The user closed the floating window from the system UI. */
	systemClose(): void {
		this.#leave?.();
	}
}

interface Harness {
	pip: CallPip;
	surfaces: FakeSurface[];
	active: boolean[];
	next: FakeSurface;
}

function harness(overrides: Partial<CallPipDeps> = {}): Harness {
	const surfaces: FakeSurface[] = [];
	const active: boolean[] = [];
	const next = new FakeSurface();
	const deps: CallPipDeps = {
		supported: () => true,
		createSurface: () => {
			const surface = surfaces.length === 0 ? next : new FakeSurface();
			surfaces.push(surface);
			return surface;
		},
		onActiveChange: value => active.push(value),
		...overrides,
	};
	return { pip: new CallPip(deps), surfaces, active, next };
}

const LIVE: CallPipState = { title: "relay audit", status: "Listening", muted: false };

describe("CallPip", () => {
	it("opens a painted floating window and closes it on demand", async () => {
		const h = harness();

		expect(await h.pip.enter(LIVE)).toBe(true);
		expect(h.pip.active).toBe(true);
		expect(h.next.entered).toBe(1);
		expect(h.next.draws).toEqual([LIVE]);

		h.pip.update({ ...LIVE, status: "Muted", muted: true });
		expect(h.next.draws).toHaveLength(2);

		await h.pip.exit();
		expect(h.next.exited).toBe(1);
		expect(h.next.disposed).toBe(1);
		expect(h.pip.active).toBe(false);
		expect(h.active).toEqual([true, false]);
	});

	it("stays out of the way on a browser without picture-in-picture", async () => {
		const h = harness({ supported: () => false });

		expect(await h.pip.enter(LIVE)).toBe(false);
		// Nothing is built, so nothing can leak.
		expect(h.surfaces).toHaveLength(0);
		expect(h.pip.supported).toBe(false);
		await h.pip.exit();
	});

	it("releases the surface when the request is refused", async () => {
		const h = harness();
		h.next.failEnter = new DOMException("gesture required", "NotAllowedError");

		expect(await h.pip.enter(LIVE)).toBe(false);
		expect(h.pip.active).toBe(false);
		expect(h.next.disposed).toBe(1);
		expect(h.active).toEqual([]);
	});

	it("releases the surface when the user closes the window from the system UI", async () => {
		const h = harness();
		await h.pip.enter(LIVE);

		h.next.systemClose();
		expect(h.pip.active).toBe(false);
		expect(h.next.disposed).toBe(1);
		expect(h.active).toEqual([true, false]);

		// The window is already gone: teardown must not ask it to exit again.
		await h.pip.exit();
		expect(h.next.exited).toBe(0);
		expect(h.next.disposed).toBe(1);
	});

	it("ignores repaints once the window is closed", async () => {
		const h = harness();
		await h.pip.enter(LIVE);
		await h.pip.exit();

		h.pip.update({ ...LIVE, status: "Speaking" });
		expect(h.next.draws).toHaveLength(1);
	});
});
