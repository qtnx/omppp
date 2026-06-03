/**
 * Model-scoped usage gating for Anthropic credentials. Claude usage reports
 * expose shared windows (`anthropic:5h`, `anthropic:7d`) PLUS tier-specific
 * windows (`anthropic:7d:opus`, `anthropic:7d:sonnet`). Without model scoping,
 * an exhausted Opus tier window parks the credential for Sonnet/Haiku too —
 * the same usage-limit hang fixed for the Codex spark pool. These tests pin the
 * contract: `selectGatingLimits` only returns the tier window matching the
 * model, and `backoffScope` partitions parking by tier.
 */
import { describe, expect, it } from "bun:test";
import type { UsageLimit, UsageReport } from "../src/usage";
import { claudeRankingStrategy } from "../src/usage/claude";

function buildLimit(args: {
	id: string;
	label: string;
	windowId: string;
	usedFraction: number;
	tier?: string;
	shared?: boolean;
}): UsageLimit {
	const used = args.usedFraction * 100;
	return {
		id: args.id,
		label: args.label,
		scope: {
			provider: "anthropic",
			windowId: args.windowId,
			tier: args.tier,
			shared: args.shared,
		},
		window: {
			id: args.windowId,
			label: args.windowId === "5h" ? "5 Hour" : "7 Day",
			durationMs: args.windowId === "5h" ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000,
			resetsAt: 2_000_000_000,
		},
		amount: {
			used,
			limit: 100,
			remaining: Math.max(0, 100 - used),
			usedFraction: args.usedFraction,
			remainingFraction: Math.max(0, 1 - args.usedFraction),
			unit: "percent",
		},
		status: args.usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function buildReport(): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			buildLimit({ id: "anthropic:5h", label: "Claude 5 Hour", windowId: "5h", usedFraction: 0, shared: true }),
			buildLimit({ id: "anthropic:7d", label: "Claude 7 Day", windowId: "7d", usedFraction: 0, shared: true }),
			buildLimit({
				id: "anthropic:7d:opus",
				label: "Claude 7 Day (Opus)",
				windowId: "7d",
				usedFraction: 1,
				tier: "opus",
			}),
			buildLimit({
				id: "anthropic:7d:sonnet",
				label: "Claude 7 Day (Sonnet)",
				windowId: "7d",
				usedFraction: 0,
				tier: "sonnet",
			}),
		],
	};
}

const isExhausted = (limit: UsageLimit): boolean => limit.status === "exhausted";

describe("claudeRankingStrategy.selectGatingLimits", () => {
	it("gates a Sonnet model on shared windows + its own tier, never the exhausted Opus window", () => {
		const report = buildReport();
		const limits = claudeRankingStrategy.selectGatingLimits!(report, "claude-sonnet-4-5");
		expect(limits.map(l => l.id).sort()).toEqual(["anthropic:5h", "anthropic:7d", "anthropic:7d:sonnet"]);
		// Sonnet must not be blocked by Opus tier exhaustion.
		expect(limits.some(isExhausted)).toBe(false);
	});

	it("gates an Opus model on its own (exhausted) tier and excludes the Sonnet tier", () => {
		const report = buildReport();
		const ids = claudeRankingStrategy.selectGatingLimits!(report, "claude-opus-4-1").map(l => l.id);
		expect(ids).toContain("anthropic:7d:opus");
		expect(ids).not.toContain("anthropic:7d:sonnet");
		// Opus IS blocked by its own exhausted tier window.
		const limits = claudeRankingStrategy.selectGatingLimits!(report, "claude-opus-4-1");
		expect(limits.some(isExhausted)).toBe(true);
	});

	it("gates an unknown/Haiku model on shared windows only (no tier windows)", () => {
		const report = buildReport();
		const ids = claudeRankingStrategy.selectGatingLimits!(report, "claude-haiku-4-5")
			.map(l => l.id)
			.sort();
		expect(ids).toEqual(["anthropic:5h", "anthropic:7d"]);
	});

	it("gates an undefined model on shared windows only", () => {
		const report = buildReport();
		const ids = claudeRankingStrategy.selectGatingLimits!(report, undefined)
			.map(l => l.id)
			.sort();
		expect(ids).toEqual(["anthropic:5h", "anthropic:7d"]);
	});
});

describe("claudeRankingStrategy.backoffScope", () => {
	it("partitions parking by tier", () => {
		expect(claudeRankingStrategy.backoffScope!("claude-opus-4-1")).toBe("opus");
		expect(claudeRankingStrategy.backoffScope!("claude-sonnet-4-5")).toBe("sonnet");
		expect(claudeRankingStrategy.backoffScope!("claude-haiku-4-5")).toBe("default");
		expect(claudeRankingStrategy.backoffScope!(undefined)).toBe("default");
	});
});
