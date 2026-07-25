import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LivePanel } from "../src/components/live/LivePanel";
import type { GuestClient, GuestSnapshot } from "../src/lib/client";

function snapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
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

const client = {} as GuestClient;

describe("LivePanel", () => {
	it("tells a read-only guest why voice is unavailable instead of hiding it", () => {
		const html = renderToStaticMarkup(<LivePanel client={client} snapshot={snapshot({ readOnly: true })} />);

		expect(html).toContain("view-only");
		expect(html).not.toContain("Start voice");
	});

	it("offers to start a call and announces the idle phase", () => {
		const html = renderToStaticMarkup(<LivePanel client={client} snapshot={snapshot()} />);

		expect(html).toContain("Start voice");
		expect(html).toContain("Idle");
		expect(html).toContain('aria-live="polite"');
	});

	it("announces the host-reported phase and the latest transcript line", () => {
		const html = renderToStaticMarkup(
			<LivePanel
				client={client}
				snapshot={snapshot({
					live: {
						phase: "working",
						transcript: { role: "assistant", turn: 2, text: "Reading the repo now", final: false },
						ended: null,
					},
				})}
			/>,
		);

		expect(html).toContain("Working on it");
		expect(html).toContain("Reading the repo now");
	});

	it("explains why a finished call stopped", () => {
		const html = renderToStaticMarkup(
			<LivePanel
				client={client}
				snapshot={snapshot({ live: { phase: null, transcript: null, ended: "the guest ended the call" } })}
			/>,
		);

		expect(html).toContain("the guest ended the call");
	});
});
