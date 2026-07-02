import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { parseConfiguredThinkingLevel } from "../../thinking";
import { getDefault } from "../settings-schema";

describe("duo advisor thinking", () => {
	test("xhigh maps to ThinkingLevel.XHigh", () => {
		expect(parseConfiguredThinkingLevel("xhigh")).toBe(ThinkingLevel.XHigh);
	});

	test("duo advisor thinking defaults to xhigh", () => {
		expect(getDefault("duo.advisorThinking")).toBe("xhigh");
	});
});
