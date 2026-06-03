import { beforeAll, describe, expect, test } from "bun:test";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

type TestPr = NonNullable<SegmentContext["git"]["pr"]>;

function createCtx(pr: TestPr): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			workspaceRoots: [],
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		loopMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		sessionStartTime: 0,
		git: {
			branch: "feature/pr-status",
			status: null,
			pr,
		},
		usage: null,
	};
}

describe("pr status line segment", () => {
	test("shows draft before mergeability status", () => {
		const rendered = renderSegment(
			"pr",
			createCtx({
				number: 42,
				url: "https://github.com/can1357/oh-my-pi/pull/42",
				state: "OPEN",
				isDraft: true,
				mergeStateStatus: "BLOCKED",
			}),
		);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("#42");
		expect(rendered.content).toContain("draft");
		expect(rendered.content).not.toContain("blocked");
	});

	test("shows blocked mergeability for open PRs", () => {
		const rendered = renderSegment(
			"pr",
			createCtx({
				number: 77,
				url: "https://github.com/can1357/oh-my-pi/pull/77",
				state: "OPEN",
				isDraft: false,
				mergeStateStatus: "BLOCKED",
			}),
		);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("#77");
		expect(rendered.content).toContain("blocked");
	});

	test("shows closed terminal state instead of stale mergeability", () => {
		const rendered = renderSegment(
			"pr",
			createCtx({
				number: 99,
				url: "https://github.com/can1357/oh-my-pi/pull/99",
				state: "MERGED",
				isDraft: false,
				mergeStateStatus: "UNKNOWN",
			}),
		);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("#99");
		expect(rendered.content).toContain("merged");
		expect(rendered.content).not.toContain("unknown");
	});

	test("falls back to open when mergeability is unknown", () => {
		const rendered = renderSegment(
			"pr",
			createCtx({
				number: 101,
				url: "https://github.com/can1357/oh-my-pi/pull/101",
				state: "OPEN",
				isDraft: false,
				mergeStateStatus: "UNKNOWN",
			}),
		);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("#101");
		expect(rendered.content).toContain("open");
		expect(rendered.content).not.toContain("unknown");
	});

	test("does not render raw control bytes from unexpected status values", () => {
		const rendered = renderSegment(
			"pr",
			createCtx({
				number: 102,
				url: "https://github.com/can1357/oh-my-pi/pull/102",
				state: "CLOSED\u001b",
				isDraft: false,
				mergeStateStatus: "DIRTY\u0007",
				reviewDecision: "APPROVED\u001b",
			}),
		);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("#102");
		expect(rendered.content).not.toContain("closed");
		expect(rendered.content).not.toContain("conflict");
		expect(rendered.content).not.toContain("approved");
		expect(rendered.content).not.toContain("\u0007");
	});

	test("does not render unknown printable status values", () => {
		const rendered = renderSegment(
			"pr",
			createCtx({
				number: 104,
				url: "https://github.com/can1357/oh-my-pi/pull/104",
				state: "OPEN",
				isDraft: false,
				mergeStateStatus: "QUEUED",
				reviewDecision: "MAYBE",
			}),
		);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("#104");
		expect(rendered.content).toContain("open");
		expect(rendered.content).not.toContain("queued");
		expect(rendered.content).not.toContain("maybe");
	});

	test("does not emit OSC 8 hyperlinks for unsafe PR URLs", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		terminalState.hyperlinks = true;
		try {
			const rendered = renderSegment(
				"pr",
				createCtx({
					number: 103,
					url: "https://github.com/can1357/oh-my-pi/pull/103\u0007evil",
					state: "OPEN",
					isDraft: false,
				}),
			);

			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain("#103");
			expect(rendered.content).not.toContain("\u001b]8;;");
			expect(rendered.content).not.toContain("\u0007");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	test("does not emit OSC 8 hyperlinks for unsafe PR URL schemes", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		terminalState.hyperlinks = true;
		try {
			const rendered = renderSegment(
				"pr",
				createCtx({
					number: 105,
					url: "javascript:alert(1)",
					state: "OPEN",
					isDraft: false,
				}),
			);

			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain("#105");
			expect(rendered.content).not.toContain("\u001b]8;;");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	test("emits OSC 8 hyperlinks for safe PR URLs", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		terminalState.hyperlinks = true;
		try {
			const rendered = renderSegment(
				"pr",
				createCtx({
					number: 106,
					url: "https://github.com/can1357/oh-my-pi/pull/106",
					state: "OPEN",
					isDraft: false,
				}),
			);

			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain("\u001b]8;;https://github.com/can1357/oh-my-pi/pull/106\u0007");
			expect(rendered.content).toContain("#106 open");
			expect(rendered.content).toContain("\u001b]8;;\u0007");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});
});
