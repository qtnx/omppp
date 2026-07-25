import { describe, expect, test } from "bun:test";
import { Settings } from "../../config/settings";
import { advisorDefaultsOffForModel, resolveAdvisorEnabled } from "../session-advisors";

describe("advisor default enablement", () => {
	test.each([
		["claude-opus-5", true],
		["global.anthropic.claude-opus-5", true],
		["claude-fable-5", true],
		["eu.anthropic.claude-fable-5", true],
		["gpt-5.6-sol", true],
		["openai.gpt-5.6-terra", true],
		["gpt-5.6-luna-pro", true],
		["claude-sonnet-4-5", false],
		["gpt-5.5", false],
		["claude-opus-4-1", false],
	])("%s opts out of the advisor by default: %p", (id, expected) => {
		expect(advisorDefaultsOffForModel({ id })).toBe(expected);
	});

	test("an unset setting leaves the advisor on for models that did not opt out", () => {
		const settings = Settings.isolated({});
		expect(resolveAdvisorEnabled(settings, { id: "claude-sonnet-4-5" })).toBe(true);
		expect(resolveAdvisorEnabled(settings, undefined)).toBe(true);
	});

	test("an unset setting turns the advisor off for opted-out models", () => {
		const settings = Settings.isolated({});
		expect(resolveAdvisorEnabled(settings, { id: "claude-opus-5" })).toBe(false);
		expect(resolveAdvisorEnabled(settings, { id: "claude-fable-5" })).toBe(false);
		expect(resolveAdvisorEnabled(settings, { id: "gpt-5.6-sol" })).toBe(false);
	});

	test("an explicit setting wins over the per-model default in both directions", () => {
		expect(resolveAdvisorEnabled(Settings.isolated({ "advisor.enabled": true }), { id: "claude-opus-5" })).toBe(true);
		expect(resolveAdvisorEnabled(Settings.isolated({ "advisor.enabled": false }), { id: "claude-sonnet-4-5" })).toBe(
			false,
		);
	});
});
