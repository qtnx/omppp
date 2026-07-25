import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceSession } from "../src/components/live/VoiceSession";
import type { GuestClient, GuestSnapshot } from "../src/lib/client";

function snapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: { title: "relay reconnect audit" } as GuestSnapshot["header"],
		entries: [],
		state: { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] },
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: false,
		readOnly: false,
		uiRequest: null,
		notices: [],
		live: { phase: null, transcript: null, ended: null },
		...overrides,
	};
}

/** `useGuestSnapshot` reads through the client's subscribe/getSnapshot pair. */
function clientFor(snap: GuestSnapshot): GuestClient {
	return {
		subscribe: () => () => {},
		getSnapshot: () => snap,
	} as unknown as GuestClient;
}

const noop = (): void => {};

describe("VoiceSession", () => {
	it("mounts the call controls and the session name, without transcript or composer", () => {
		const html = renderToStaticMarkup(
			<VoiceSession client={clientFor(snapshot())} onLeave={noop} onRejoin={noop} />,
		);

		expect(html).toContain("relay reconnect audit");
		expect(html).toContain("Start voice");
		// The heavy surfaces of the full client stay unmounted — that is the point of this view.
		expect(html).not.toContain("sh-transcript");
		expect(html).not.toContain("sh-composer-input");
		expect(html).not.toContain("ag-dot");
	});

	it("explains a read-only link instead of offering a dead call button", () => {
		const html = renderToStaticMarkup(
			<VoiceSession client={clientFor(snapshot({ readOnly: true }))} onLeave={noop} onRejoin={noop} />,
		);

		expect(html).toContain("view-only");
		expect(html).not.toContain("Start voice");
	});
});
