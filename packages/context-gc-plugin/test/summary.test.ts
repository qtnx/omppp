import { describe, expect, test } from "bun:test";
import { buildFallbackSummary, estimateTokens, limitBytes, normalizeAgentSummary, selectPayload } from "../src/summary";

describe("summary helpers", () => {
	test("estimates tokens deterministically from text length", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("12345")).toBe(2);
	});

	test("limits UTF-8 payloads without exceeding byte budget", () => {
		const limited = limitBytes("alpha βeta gamma", 10);
		expect(new TextEncoder().encode(limited).byteLength).toBeLessThanOrEqual(10);
		expect(limited.endsWith("…")).toBe(true);
		expect(new TextEncoder().encode(limitBytes("abcdef", 2)).byteLength).toBeLessThanOrEqual(2);
	});

	test("selects one-based line ranges", () => {
		const payload = ["one", "two", "three", "four"].join("\n");
		expect(selectPayload(payload, "2")).toBe("two");
		expect(selectPayload(payload, "2-3")).toBe("two\nthree");
	});

	test("search selector returns numbered context slices", () => {
		const payload = ["alpha", "before", "needle here", "after", "omega"].join("\n");
		expect(selectPayload(payload, { type: "search", query: "needle", before: 1, after: 1 })).toBe(
			"2:before\n3:needle here\n4:after",
		);
	});

	test("raw selector returns bounded text", () => {
		const selected = selectPayload("abcdef", { type: "raw", maxBytes: 4 });
		expect(new TextEncoder().encode(selected).byteLength).toBeLessThanOrEqual(4);
	});

	test("summary selector returns bounded normalized summaries", () => {
		expect(selectPayload("ignored payload", { type: "summary", summary: " compact\n summary ", maxBytes: 128 })).toBe(
			"compact summary",
		);
		expect(selectPayload("alpha\n beta", "summary")).toContain("preview: alpha beta");
	});

	test("fallback and agent summaries normalize whitespace and preserve useful preview", () => {
		expect(buildFallbackSummary("alpha\n\n beta", { maxBytes: 128 })).toContain("preview: alpha beta");
		expect(normalizeAgentSummary(" alpha\n beta ", "fallback")).toBe("alpha beta");
		expect(normalizeAgentSummary("  ", "fallback summary")).toBe("fallback summary");
	});
});
