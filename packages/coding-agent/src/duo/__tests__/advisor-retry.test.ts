import { describe, expect, it } from "bun:test";
import { ADVISOR_RETRY_CAP_MS, computeAdvisorRetryDelay, parseRetryAfterMs } from "../advisor-retry";

describe("computeAdvisorRetryDelay", () => {
	it("uses exponential backoff capped at ten minutes", () => {
		expect([0, 1, 2, 3, 4, 5].map(attempt => computeAdvisorRetryDelay(attempt))).toEqual([
			30_000,
			60_000,
			120_000,
			240_000,
			480_000,
			ADVISOR_RETRY_CAP_MS,
		]);
	});

	it("honors positive retry-after values with the retry cap", () => {
		expect(computeAdvisorRetryDelay(0, 5_000)).toBe(5_000);
		expect(computeAdvisorRetryDelay(0, 5_790_000)).toBe(ADVISOR_RETRY_CAP_MS);
	});
});

describe("parseRetryAfterMs", () => {
	it("parses retry-after-ms from provider error messages", () => {
		expect(parseRetryAfterMs(new Error("429 Too Many Requests retry-after-ms=5790000"))).toBe(5_790_000);
	});

	it("returns undefined when no retry-after hint exists", () => {
		expect(parseRetryAfterMs("unrelated failure")).toBeUndefined();
	});
});
