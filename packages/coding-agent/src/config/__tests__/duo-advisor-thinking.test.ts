import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { parseConfiguredThinkingLevel } from "../../thinking";
import { Settings } from "../settings";
import { getDefault } from "../settings-schema";

describe("duo advisor thinking", () => {
	test("xhigh maps to ThinkingLevel.XHigh", () => {
		expect(parseConfiguredThinkingLevel("xhigh")).toBe(ThinkingLevel.XHigh);
	});

	test("duo advisor thinking defaults to xhigh", () => {
		expect(getDefault("duo.advisorThinking")).toBe("xhigh");
	});

	test("advisor is enabled by default for fresh settings", () => {
		expect(getDefault("advisor.enabled")).toBe(true);
		expect(Settings.isolated({}).get("advisor.enabled")).toBe(true);
	});
});
