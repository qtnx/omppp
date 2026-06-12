import { describe, expect, it } from "bun:test";
import { BrowserTool, createBrowserAnnotationListener } from "../../browser";
import type { BrowserAnnotationEntry, ToolSession } from "../../index";
import overlayScript from "../../puppeteer/annotate-overlay.txt" with { type: "text" };
import { validateAnnotationPayload } from "../annotate";
import { type AnnotationRouteState, drainBufferedAnnotations, routeAnnotationSubmission } from "../annotation-router";
import type { AnnotationSubmission } from "../tab-protocol";
import { registerTabForTest, type TabSession } from "../tab-supervisor";

describe("validateAnnotationPayload", () => {
	it("accepts a comment + rects payload and normalizes it", () => {
		const payload = validateAnnotationPayload(
			JSON.stringify({
				comment: "Fix the header",
				rects: [{ x: 10, y: 20, width: 100, height: 40, note: "this button" }],
				url: "https://example.com/page",
				title: "Example",
			}),
		);
		expect(payload).toEqual({
			comment: "Fix the header",
			rects: [{ x: 10, y: 20, width: 100, height: 40, note: "this button" }],
			url: "https://example.com/page",
			title: "Example",
		});
	});

	it("accepts a comment-only payload (no rects)", () => {
		const payload = validateAnnotationPayload(JSON.stringify({ comment: "Just a note", rects: [], url: "u" }));
		expect(payload.comment).toBe("Just a note");
		expect(payload.rects).toEqual([]);
	});

	it("accepts a rects-only payload (empty comment)", () => {
		const payload = validateAnnotationPayload(
			JSON.stringify({ comment: "   ", rects: [{ x: 0, y: 0, width: 5, height: 5 }], url: "u" }),
		);
		expect(payload.rects).toHaveLength(1);
		expect(payload.rects[0]).toEqual({ x: 0, y: 0, width: 5, height: 5 });
	});

	it("rejects non-JSON input", () => {
		expect(() => validateAnnotationPayload("not json {")).toThrow(/not valid JSON/);
	});

	it("rejects a non-object payload", () => {
		expect(() => validateAnnotationPayload("[1,2,3]")).toThrow(/must be an object/);
	});

	it("rejects an empty comment with no rects", () => {
		expect(() => validateAnnotationPayload(JSON.stringify({ comment: "  ", rects: [], url: "u" }))).toThrow(
			/comment or at least one rect/,
		);
	});

	it("rejects non-finite rect coordinates", () => {
		expect(() =>
			validateAnnotationPayload(
				JSON.stringify({ comment: "x", rects: [{ x: 0, y: "NaN-ish", width: 5, height: 5 }], url: "u" }),
			),
		).toThrow(/finite number/);
		expect(() =>
			validateAnnotationPayload(JSON.stringify({ comment: "x", rects: [{ x: 0, y: 0, width: 5 }], url: "u" })),
		).toThrow(/finite number/);
	});

	it("clamps negative rect coordinates to zero", () => {
		const payload = validateAnnotationPayload(
			JSON.stringify({ comment: "x", rects: [{ x: -50, y: -1, width: 10, height: 10 }], url: "u" }),
		);
		expect(payload.rects[0]).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
	});

	it("clamps oversized comment and note strings", () => {
		const payload = validateAnnotationPayload(
			JSON.stringify({
				comment: "c".repeat(12_000),
				rects: [{ x: 0, y: 0, width: 5, height: 5, note: "n".repeat(5_000) }],
				url: "u",
			}),
		);
		expect(payload.comment).toHaveLength(10_000);
		expect(payload.rects[0].note).toHaveLength(1_000);
	});

	it("defaults a missing url to an empty string and omits a missing title", () => {
		const payload = validateAnnotationPayload(JSON.stringify({ comment: "x", rects: [] }));
		expect(payload.url).toBe("");
		expect(payload.title).toBeUndefined();
	});

	it("passes through valid element info and clamps oversized element strings", () => {
		const payload = validateAnnotationPayload(
			JSON.stringify({
				comment: "x",
				rects: [
					{
						x: 1,
						y: 2,
						width: 3,
						height: 4,
						element: {
							selector: "#submit",
							tag: "button",
							id: "submit",
							classes: ["primary", "wide"],
							role: "button",
							name: "n".repeat(200),
							text: "t".repeat(500),
							rect: { x: 10, y: 20, width: 100, height: 40 },
						},
					},
				],
				url: "u",
			}),
		);
		expect(payload.rects[0].element).toEqual({
			selector: "#submit",
			tag: "button",
			id: "submit",
			classes: ["primary", "wide"],
			role: "button",
			name: "n".repeat(120),
			text: "t".repeat(300),
			rect: { x: 10, y: 20, width: 100, height: 40 },
		});
	});

	it("drops malformed element info without rejecting the submission", () => {
		for (const element of [
			"div",
			{ tag: "div", rect: { x: 0, y: 0, width: 1, height: 1 } },
			{ selector: "div", tag: "div", rect: { x: "NaN-ish", y: 0, width: 1, height: 1 } },
		]) {
			const payload = validateAnnotationPayload(
				JSON.stringify({ comment: "x", rects: [{ x: 0, y: 0, width: 5, height: 5, element }], url: "u" }),
			);
			expect(payload.rects[0].element).toBeUndefined();
		}
	});

	it("preserves negative element rect coordinates", () => {
		const payload = validateAnnotationPayload(
			JSON.stringify({
				comment: "x",
				rects: [
					{
						x: -12,
						y: -8,
						width: 5,
						height: 5,
						element: { selector: "div", tag: "div", rect: { x: -12, y: -8, width: 20, height: 10 } },
					},
				],
				url: "u",
			}),
		);
		expect(payload.rects[0]).toMatchObject({ x: 0, y: 0 });
		expect(payload.rects[0].element?.rect).toEqual({ x: -12, y: -8, width: 20, height: 10 });
	});
});

describe("annotate-overlay.txt", () => {
	it("is syntactically valid JavaScript", () => {
		// The overlay is injected verbatim into the user's page; a syntax error
		// would silently break browser-side injection.
		expect(() => new Function(overlayScript)).not.toThrow();
	});

	it("uses no console.* (forbidden in the user's page)", () => {
		expect(overlayScript).not.toMatch(/\bconsole\s*\./);
	});

	it("wires the globals the worker/orchestrator depend on", () => {
		// tab-worker/annotate.ts call these exact names across the page boundary.
		expect(overlayScript).toContain("__ompxAnnotateInstalled");
		expect(overlayScript).toContain("__ompxAnnotateEnabled");
		expect(overlayScript).toContain("__ompxAnnotateSubmit");
		expect(overlayScript).toContain("__ompxAnnotateSetChromeVisible");
	});
});

function testSubmission(comment: string): AnnotationSubmission {
	return {
		payload: {
			comment,
			rects: [],
			url: "https://example.test/",
			title: "Example",
		},
		screenshot: { data: "base64-png", mimeType: "image/png" },
		ts: 123,
	};
}

function annotationState(overrides: Partial<AnnotationRouteState> = {}): AnnotationRouteState {
	return {
		annotations: [],
		annotationWaiters: [],
		...overrides,
	};
}

function fakeAnnotationTab(name: string): { tab: TabSession; emit(submission: AnnotationSubmission): void } {
	let handler: ((msg: unknown) => void) | undefined;
	const worker = {
		send(msg: unknown): void {
			if (typeof msg !== "object" || msg === null) return;
			const annotate = msg as { type?: unknown; id?: unknown };
			if (annotate.type !== "annotate" || typeof annotate.id !== "string") return;
			queueMicrotask(() => handler?.({ type: "annotate-ack", id: annotate.id, ok: true }));
		},
		onMessage(next: (msg: unknown) => void): () => void {
			handler = next;
			return () => {
				if (handler === next) handler = undefined;
			};
		},
		onError(): () => void {
			return () => undefined;
		},
		async terminate(): Promise<void> {},
		mode: "inline",
	};
	const tab = {
		name,
		browser: { kind: { kind: "headless", headless: false } },
		targetId: "target",
		worker,
		state: "alive",
		info: {
			url: "https://example.test/",
			title: "Example",
			viewport: { width: 800, height: 600 },
			targetId: "target",
		},
		pending: new Map(),
		annotations: [],
		annotationWaiters: [],
		pendingAnnotates: new Map(),
		kindTag: "headless",
	} as unknown as TabSession;
	return {
		tab,
		emit(submission: AnnotationSubmission): void {
			handler?.({ type: "annotation", submission });
		},
	};
}

describe("annotation submission routing", () => {
	it("delivers a submission to an active waiter before the background listener", () => {
		let waited: AnnotationSubmission | undefined;
		const delivered: string[] = [];
		const state = annotationState({
			annotationWaiters: [
				{
					resolve: submission => {
						waited = submission;
					},
					reject: () => undefined,
				},
			],
			annotationListener: submission => delivered.push(submission.payload.comment),
		});

		routeAnnotationSubmission(state, testSubmission("first"));

		expect(waited?.payload.comment).toBe("first");
		expect(delivered).toEqual([]);
		expect(state.annotations).toHaveLength(0);
	});

	it("delivers to the background listener when no waiter is active", () => {
		const delivered: string[] = [];
		const state = annotationState({
			annotationListener: submission => delivered.push(submission.payload.comment),
		});

		routeAnnotationSubmission(state, testSubmission("background"));

		expect(delivered).toEqual(["background"]);
		expect(state.annotations).toHaveLength(0);
	});

	it("buffers only the newest submissions while no waiter or listener is present", () => {
		const state = annotationState();
		for (let index = 0; index < 25; index++) {
			routeAnnotationSubmission(state, testSubmission(`comment-${index}`));
		}

		expect(state.annotations).toHaveLength(20);
		expect(state.annotations[0]?.payload.comment).toBe("comment-5");
		expect(state.annotations[19]?.payload.comment).toBe("comment-24");
	});

	it("drains buffered submissions in order when a listener is registered", () => {
		const delivered: string[] = [];
		const state = annotationState({
			annotations: [testSubmission("one"), testSubmission("two")],
			annotationListener: submission => delivered.push(submission.payload.comment),
		});

		drainBufferedAnnotations(state);

		expect(delivered).toEqual(["one", "two"]);
		expect(state.annotations).toHaveLength(0);
	});

	it("continues draining buffered submissions after a listener failure", () => {
		let calls = 0;
		const delivered: string[] = [];
		const state = annotationState({
			annotations: [testSubmission("bad"), testSubmission("good")],
			annotationListener: submission => {
				if (calls++ === 0) throw new Error("boom");
				delivered.push(submission.payload.comment);
			},
		});

		drainBufferedAnnotations(state);

		expect(calls).toBe(2);
		expect(delivered).toEqual(["good"]);
		expect(state.annotations).toHaveLength(0);
	});

	it("drops a listener failure without blocking later routed submissions", () => {
		let calls = 0;
		const state = annotationState({
			annotationListener: () => {
				calls++;
				throw new Error("boom");
			},
		});

		routeAnnotationSubmission(state, testSubmission("bad"));
		routeAnnotationSubmission(state, testSubmission("next"));

		expect(calls).toBe(2);
		expect(state.annotations).toHaveLength(0);
	});
});
describe("createBrowserAnnotationListener", () => {
	it("queues browser annotation entries with formatted text and screenshots", () => {
		let queued:
			| {
					tab: string;
					url: string;
					title?: string;
					text: string;
					screenshot: { data: string; mimeType: string };
					timestamp: number;
			  }
			| undefined;
		const listener = createBrowserAnnotationListener(
			{
				queueBrowserAnnotation: entry => {
					queued = entry;
				},
			},
			"review",
		);
		if (!listener) throw new Error("listener missing");

		listener(testSubmission("queued"));

		expect(queued?.tab).toBe("review");
		expect(queued?.url).toBe("https://example.test/");
		expect(queued?.title).toBe("Example");
		expect(queued?.text).toContain("Human feedback from https://example.test/ — Example");
		expect(queued?.text).toContain("Comment: queued");
		expect(queued?.screenshot).toEqual({ data: "base64-png", mimeType: "image/png" });
		expect(queued?.timestamp).toBe(123);
	});
});

describe("BrowserTool annotate background delivery", () => {
	it("re-registers background delivery after a waited submission", async () => {
		const queued: BrowserAnnotationEntry[] = [];
		const { tab, emit } = fakeAnnotationTab("review");
		const unregister = registerTabForTest(tab);
		try {
			const session: Pick<ToolSession, "queueBrowserAnnotation"> = {
				queueBrowserAnnotation: entry => {
					queued.push(entry);
				},
			};
			const tool = new BrowserTool(session as ToolSession);
			const pending = tool.execute("call", { action: "annotate", name: "review", timeout: 1 });
			await Bun.sleep(0);
			emit(testSubmission("first"));

			const result = await pending;
			const waitedText = result.content[0];
			if (waitedText?.type !== "text") throw new Error("waited text missing");
			expect(waitedText.text).toContain("Comment: first");
			expect(result.content[1]).toEqual({ type: "image", data: "base64-png", mimeType: "image/png" });
			expect(queued).toHaveLength(0);

			routeAnnotationSubmission(tab, testSubmission("second"));

			expect(queued).toHaveLength(1);
			expect(queued[0]?.tab).toBe("review");
			expect(queued[0]?.text).toContain("Comment: second");
			expect(queued[0]?.screenshot).toEqual({ data: "base64-png", mimeType: "image/png" });
		} finally {
			unregister();
		}
	});
});
