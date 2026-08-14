import { describe, expect, test } from "bun:test";
import { normalizeIrcTimeoutMs } from "../../src/tools/irc";

describe("normalizeIrcTimeoutMs", () => {
	test("normalizes bounded wait timeouts for IRC waits", () => {
		expect(normalizeIrcTimeoutMs(0)).toBe(600_000);
		expect(normalizeIrcTimeoutMs(10_000_000)).toBe(600_000);
		expect(normalizeIrcTimeoutMs(-5)).toBe(120_000);
		expect(normalizeIrcTimeoutMs(Number.NaN)).toBe(120_000);
		expect(normalizeIrcTimeoutMs(5_000)).toBe(5_000);
	});
});
