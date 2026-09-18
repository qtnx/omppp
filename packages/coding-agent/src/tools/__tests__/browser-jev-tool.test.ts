import { afterEach, describe, expect, test } from "bun:test";
import { type JevRunReport, jevRunCode, renderJevReport } from "../browser-jev-tool";
import { jevApiKey } from "../browser/jev";

const ORIGINAL_KEY = Bun.env.TYPESAFE_API_KEY;

afterEach(() => {
	if (ORIGINAL_KEY === undefined) delete Bun.env.TYPESAFE_API_KEY;
	else Bun.env.TYPESAFE_API_KEY = ORIGINAL_KEY;
});

function report(overrides: Partial<JevRunReport> = {}): JevRunReport {
	return {
		status: "done",
		steps: [
			{
				step: 1,
				operation: "TYPE_TEXT",
				target: { id: 3, role: "searchbox", name: "City" },
				text: "Hanoi",
				pageChanged: true,
				url: "https://example.test/",
			},
			{
				step: 2,
				operation: "CLICK",
				target: { id: 7, role: "button", name: "Search" },
				pageChanged: false,
				url: "https://example.test/results",
			},
		],
		url: "https://example.test/results",
		title: "Results",
		elapsedMs: 4200,
		pageText: "Two hotels found",
		...overrides,
	};
}

describe("jevRunCode", () => {
	test("navigates only when a url is supplied and passes maxSteps through to tab.act", () => {
		const withUrl = jevRunCode({ goal: 'open "x"', url: "https://example.test/", max_steps: 5 });
		expect(withUrl).toContain('await tab.goto("https://example.test/", { waitUntil: "domcontentloaded" });');
		expect(withUrl).toContain('await tab.act("open \\"x\\"", {"maxSteps":5})');

		const withoutUrl = jevRunCode({ goal: "continue" });
		expect(withoutUrl).not.toContain("tab.goto");
		expect(withoutUrl).toContain('await tab.act("continue", {})');
		expect(withoutUrl).toContain('pageText = await tab.extract("text")');
	});
});

describe("renderJevReport", () => {
	test("reports each executed step with its target, typed text, and unchanged-page marker", () => {
		const text = renderJevReport("Find a hotel in Hanoi", report());
		expect(text).toContain("status: done — 2 action(s) in 4.2s");
		expect(text).toContain("goal: Find a hotel in Hanoi");
		expect(text).toContain("url: https://example.test/results");
		expect(text).toContain('1. TYPE_TEXT searchbox "City" = "Hanoi"');
		expect(text).toContain('2. CLICK button "Search" (page unchanged)');
		expect(text).toContain("page text:\nTwo hotels found");
		expect(text).not.toContain("browser_use");
	});

	test("tells the caller how to take over on blocked and how to resume on max_steps", () => {
		expect(renderJevReport("g", report({ status: "blocked" }))).toContain(
			"Handle that step with `browser_use` (canvas/gesture) or the `browser` prelude",
		);
		expect(renderJevReport("g", report({ status: "max_steps" }))).toContain(
			"Re-run with the remaining work as the goal",
		);
	});
});

describe("jevApiKey", () => {
	test("treats an absent or blank TypeSafe key as no key — the tool's availability gate", () => {
		delete Bun.env.TYPESAFE_API_KEY;
		expect(jevApiKey()).toBeUndefined();
		Bun.env.TYPESAFE_API_KEY = "   ";
		expect(jevApiKey()).toBeUndefined();
		Bun.env.TYPESAFE_API_KEY = "apikey_test";
		expect(jevApiKey()).toBe("apikey_test");
	});
});
