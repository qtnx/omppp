import { describe, expect, it } from "bun:test";
import reactHookScript from "../react-hook.txt" with { type: "text" };
import vitalsScript from "../vitals.txt" with { type: "text" };

describe("browser vitals injected scripts", () => {
	it("parses injected JavaScript", () => {
		expect(() => new Function(vitalsScript)).not.toThrow();
		expect(() => new Function(reactHookScript)).not.toThrow();
	});

	it("guards vitals installation", () => {
		expect(vitalsScript).toContain("if (globalThis.__ompxVitals) return;");
	});
});
