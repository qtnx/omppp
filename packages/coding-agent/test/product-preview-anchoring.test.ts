import { describe, expect, it } from "bun:test";
import { buildAnchor, resolveAnchor } from "../src/product-preview/client/anchoring";

describe("comment text anchors", () => {
	it("resolves an exact unique match", () => {
		const text = "Start a focused selection and finish.";
		const anchor = buildAnchor(text, 8, 27);
		expect(resolveAnchor(text, anchor)).toEqual({ start: 8, end: 27 });
	});

	it("uses prefix and suffix to disambiguate duplicate quotes", () => {
		const text = "Before alpha after. Other alpha later.";
		const anchor = buildAnchor(text, 7, 12);
		expect(resolveAnchor(text, anchor)).toEqual({ start: 7, end: 12 });
	});

	it("returns null when duplicate candidates have the same score", () => {
		expect(resolveAnchor("alpha and alpha", { quote: "alpha", prefix: "", suffix: "" })).toBeNull();
	});

	it("returns null when the quote is absent", () => {
		expect(resolveAnchor("A document", { quote: "missing", prefix: "", suffix: "" })).toBeNull();
	});

	it("preserves empty context at document edges", () => {
		const text = "edge text";
		expect(buildAnchor(text, 0, 4)).toEqual({ quote: "edge", prefix: "", suffix: " text" });
		expect(buildAnchor(text, 5, 9)).toEqual({ quote: "text", prefix: "edge ", suffix: "" });
	});

	it("counts unicode by JavaScript text offsets", () => {
		const text = "前置 café ✓ 後置";
		const start = text.indexOf("café");
		const anchor = buildAnchor(text, start, start + "café".length);
		expect(resolveAnchor(text, anchor)).toEqual({ start, end: start + "café".length });
	});
});
