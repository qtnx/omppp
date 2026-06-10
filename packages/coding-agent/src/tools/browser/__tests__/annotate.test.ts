import { describe, expect, it } from "bun:test";
import overlayScript from "../../puppeteer/annotate-overlay.txt" with { type: "text" };
import { validateAnnotationPayload } from "../annotate";

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
