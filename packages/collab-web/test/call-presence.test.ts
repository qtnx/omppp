import { describe, expect, it } from "bun:test";
import {
	CallPresence,
	type CallPresenceActions,
	type CallPresenceDeps,
	type CallPresenceState,
	type MediaSessionLike,
} from "../src/lib/call-presence";

/** `MediaMetadata` has no constructor outside a browser; only its fields matter here. */
function fakeMetadata(state: CallPresenceState): MediaMetadata {
	return { title: state.title, artist: state.status } as unknown as MediaMetadata;
}

class FakeSession implements MediaSessionLike {
	metadata: MediaMetadata | null = null;
	playbackState: MediaSessionPlaybackState = "none";
	readonly handlers = new Map<string, (() => void) | null>();
	/** Actions this browser refuses — the Chrome-only ones throw elsewhere. */
	readonly unsupported = new Set<string>();

	setActionHandler(action: string, handler: (() => void) | null): void {
		if (this.unsupported.has(action)) throw new TypeError(`unsupported action: ${action}`);
		this.handlers.set(action, handler);
	}
}

interface Harness {
	presence: CallPresence;
	session: FakeSession;
	/** Every `setMuted` the system controls asked for, in order. */
	muted: boolean[];
	hangups: { count: number };
	actions: CallPresenceActions;
	/** Invoke a registered system-control handler. */
	fire(action: string): void;
}

function harness(overrides: Partial<CallPresenceDeps> = {}): Harness {
	const session = new FakeSession();
	const muted: boolean[] = [];
	const hangups = { count: 0 };
	const presence = new CallPresence({ session, createMetadata: fakeMetadata, ...overrides });
	return {
		presence,
		session,
		muted,
		hangups,
		actions: {
			setMuted: next => muted.push(next),
			hangup: () => {
				hangups.count++;
			},
		},
		fire(action) {
			const handler = session.handlers.get(action);
			if (!handler) throw new Error(`no handler registered for ${action}`);
			handler();
		},
	};
}

const LIVE: CallPresenceState = { title: "relay audit", status: "Listening", muted: false };

describe("CallPresence", () => {
	it("publishes the call to the system UI and wires the call controls", () => {
		const h = harness();
		h.presence.start(LIVE, h.actions);

		expect(h.session.metadata?.title).toBe("relay audit");
		expect(h.session.playbackState).toBe("playing");
		expect([...h.session.handlers.keys()].sort()).toEqual(["hangup", "pause", "play", "stop", "togglemicrophone"]);
	});

	it("maps the system transport buttons onto mute and hang-up", () => {
		const h = harness();
		h.presence.start(LIVE, h.actions);

		h.fire("pause");
		h.fire("play");
		h.fire("togglemicrophone");
		expect(h.muted).toEqual([true, false, true]);

		h.fire("hangup");
		h.fire("stop");
		expect(h.hangups.count).toBe(2);
	});

	it("reflects mute as a paused session so the system button shows the right state", () => {
		const h = harness();
		h.presence.start(LIVE, h.actions);
		h.presence.update({ title: "relay audit", status: "Muted", muted: true });

		expect(h.session.playbackState).toBe("paused");
		expect(h.session.metadata?.artist).toBe("Muted");
		// The toggle reads live state, so from muted it asks to unmute.
		h.fire("togglemicrophone");
		expect(h.muted).toEqual([false]);
	});

	it("keeps the supported actions when the browser rejects a call-specific one", () => {
		const h = harness();
		h.session.unsupported.add("hangup");
		h.session.unsupported.add("togglemicrophone");
		h.presence.start(LIVE, h.actions);

		expect([...h.session.handlers.keys()].sort()).toEqual(["pause", "play", "stop"]);
		h.fire("stop");
		expect(h.hangups.count).toBe(1);
	});

	it("clears every handler and the metadata when the call ends", () => {
		const h = harness();
		h.presence.start(LIVE, h.actions);
		h.presence.stop();

		expect(h.session.metadata).toBeNull();
		expect(h.session.playbackState).toBe("none");
		// A stale handler would leave a dead notification steering a finished call.
		expect([...h.session.handlers.values()].every(handler => handler === null)).toBe(true);
		expect(h.presence.state).toBeUndefined();
	});

	it("is inert on a browser without a media session", () => {
		const h = harness({ session: undefined });
		h.presence.start(LIVE, h.actions);
		h.presence.update({ title: "relay audit", status: "Speaking", muted: false });
		h.presence.stop();

		expect(h.session.handlers.size).toBe(0);
		expect(h.presence.state).toBeUndefined();
	});
});
