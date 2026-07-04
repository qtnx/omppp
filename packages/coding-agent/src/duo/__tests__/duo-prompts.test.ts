import { describe, expect, test } from "bun:test";
import doneReview from "../../prompts/advisor/done-review.md" with { type: "text" };
import advisorSystem from "../../prompts/advisor/system.md" with { type: "text" };
import manualPlanBrief from "../prompts/manual-plan-brief.md" with { type: "text" };
import takeoverBrief from "../prompts/takeover-brief.md" with { type: "text" };
import takeoverOverlay from "../prompts/takeover-overlay.md" with { type: "text" };

describe("duo takeover prompts", () => {
	test("takeover brief and overlay do not describe a verify-purpose takeover", () => {
		expect(takeoverBrief).toContain("duo_handoff");
		expect(takeoverOverlay).toContain("duo_handoff");
		expect(takeoverBrief).not.toMatch(/verify|verify-done|re-run the decisive checks|fresh evidence|missing/i);
		expect(takeoverOverlay).not.toMatch(/verify|verify-done|re-run the decisive checks|fresh evidence|missing/i);
	});

	test("done-review prompts require approve or reject-with-missing without escalation", () => {
		for (const content of [doneReview, advisorSystem]) {
			expect(content).toMatch(/approve/);
			expect(content).toMatch(/reject/);
			expect(content).toMatch(/missing/);
			expect(content).not.toContain("escalate_verify");
			expect(content).not.toMatch(/escalate.*takeover|takeover.*escalate/i);
		}
		expect(doneReview).toContain("VERIFY CAREFULLY");
		expect(advisorSystem).toContain("VERIFY CAREFULLY");
	});

	test("manual plan brief is trigger-neutral (covers manual switch AND automatic plan takeover)", () => {
		expect(manualPlanBrief).not.toContain("manually placed");
		expect(manualPlanBrief).toContain("FULL-PLAN INTENT");
		expect(manualPlanBrief).toContain("COMPLETE");
	});
});
