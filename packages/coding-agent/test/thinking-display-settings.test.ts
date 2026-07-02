import { describe, expect, it } from "bun:test";
import { resolveThinkingDisplay, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("resolveThinkingDisplay", () => {
	it("lets legacy omitThinking force omitted", () => {
		for (const thinkingDisplay of ["auto", "summarized", "omitted"] as const) {
			const settings = Settings.isolated({ omitThinking: true, thinkingDisplay });

			expect(resolveThinkingDisplay(settings)).toBe("omitted");
		}
	});

	it("maps thinkingDisplay values when omitThinking is false", () => {
		expect(
			resolveThinkingDisplay(Settings.isolated({ omitThinking: false, thinkingDisplay: "auto" })),
		).toBeUndefined();
		expect(resolveThinkingDisplay(Settings.isolated({ omitThinking: false, thinkingDisplay: "summarized" }))).toBe(
			"summarized",
		);
		expect(resolveThinkingDisplay(Settings.isolated({ omitThinking: false, thinkingDisplay: "omitted" }))).toBe(
			"omitted",
		);
	});
});
