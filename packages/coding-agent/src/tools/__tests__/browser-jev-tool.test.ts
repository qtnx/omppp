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
		rescues: 0,
		shots: [],
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

	test("names the rescue turn and its verdict in the report", () => {
		const text = renderJevReport(
			"g",
			report({
				status: "blocked",
				rescues: 1,
				reason: "the flow needs a payment card the goal does not supply",
				steps: [
					{
						step: 1,
						operation: "CLICK",
						target: { id: 4, role: "button", name: "Close" },
						rescue: "closed the consent dialog",
						pageChanged: true,
						url: "https://example.test/",
					},
				],
			}),
		);
		expect(text).toContain("rescue turns: 1");
		expect(text).toContain('1. CLICK button "Close" [rescue: closed the consent dialog]');
		expect(text).toContain("Blocked after a rescue turn: the flow needs a payment card the goal does not supply");
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

describe("report review and screenshot sections", () => {
	test("lists saved frames and the review findings with their evidence", () => {
		const text = renderJevReport(
			"g",
			report({
				shots: ["/tmp/jev-start.png", "/tmp/jev-final.png"],
				review: {
					summary: "Two clicks reached the results page.",
					findings: [
						{
							severity: "major",
							area: "accessibility",
							finding: "The search field has no visible label.",
							evidence: 'control role=searchbox label=""',
						},
					],
				},
			}),
		);
		expect(text).toContain("screenshots (view them when the run is a visual or responsive claim):");
		expect(text).toContain("- /tmp/jev-start.png");
		expect(text).toContain("review:");
		expect(text).toContain("Two clicks reached the results page.");
		expect(text).toContain(
			'- [major/accessibility] The search field has no visible label. — evidence: control role=searchbox label=""',
		);
	});

	test("says when the review could not run, and says so plainly when it found nothing", () => {
		expect(
			renderJevReport("g", report({ review: { summary: "", findings: [], unavailable: "provider rate limited" } })),
		).toContain("- unavailable: provider rate limited");
		expect(renderJevReport("g", report({ review: { summary: "Clean run.", findings: [] } }))).toContain(
			"- no findings",
		);
	});
});
