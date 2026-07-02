import { describe, expect, it } from "bun:test";
import { resolveAnthropicThinkingDisplayOption } from "@oh-my-pi/pi-ai/stream";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";

describe("Anthropic stream thinking display mapping", () => {
	it("lets explicit summarized override hideThinkingSummary", () => {
		const options: SimpleStreamOptions = {
			thinkingDisplay: "summarized",
			hideThinkingSummary: true,
		};

		expect(resolveAnthropicThinkingDisplayOption(options)).toBe("summarized");
	});

	it("maps hideThinkingSummary to omitted when no explicit display is set", () => {
		const options: SimpleStreamOptions = { hideThinkingSummary: true };

		expect(resolveAnthropicThinkingDisplayOption(options)).toBe("omitted");
	});

	it("leaves display undefined so Anthropic can apply the model-aware default", () => {
		const options: SimpleStreamOptions = {};

		expect(resolveAnthropicThinkingDisplayOption(options)).toBeUndefined();
	});
});
