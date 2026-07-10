import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveAgentModelPatterns, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";

// The fork pins plan/reviewer reasoning instead of upstream's role-inheritance
// contract (#4761): frontmatter locks `thinking-level: high` and plan's
// Fable-first route list. The executor picks `agent.thinkingLevel ??
// resolvedThinkingLevel` (task/executor.ts), so these pins deliberately mask a
// user's modelRoles effort suffix — a dropped pin (e.g. a clean auto-merge
// deleting `thinking-level: high` from reviewer.md) silently hands reasoning
// control back to role suffixes, which is exactly what these tests trip on.
describe("bundled agent parsing", () => {
	it("pins reviewer to the locked slow route with high thinking", () => {
		const reviewer = getBundledAgent("reviewer");

		expect(reviewer).toBeDefined();
		expect(reviewer?.source).toBe("bundled");
		expect(reviewer?.model).toEqual(["pi/slow"]);
		expect(reviewer?.thinkingLevel).toBe(Effort.High);
	});

	it("pins plan to the locked Fable-first route list with high thinking", () => {
		const plan = getBundledAgent("plan");

		expect(plan).toBeDefined();
		expect(plan?.source).toBe("bundled");
		expect(plan?.model).toEqual(["anthropic/claude-fable-5:low", "openai-codex/gpt-5.5:high", "pi/plan", "pi/slow"]);
		expect(plan?.thinkingLevel).toBe(Effort.High);
	});

	// Issue #4761 machinery still holds under the fork's pinned frontmatter: an
	// explicit effort suffix survives agent-pattern expansion and model
	// resolution. Reviewer reaches the configured slow role (`:xhigh`); plan's
	// own `openai-codex/gpt-5.5:high` route outranks its `pi/plan`/`pi/slow`
	// role fallbacks when Fable is unavailable. Either way the frontmatter pin
	// (asserted above) is what the executor runs the subagent at.
	it("resolves explicit effort suffixes through the fork's locked routes", () => {
		const gpt55 = buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const settings = Settings.isolated({
			modelRoles: { slow: "openai-codex/gpt-5.5:xhigh", plan: "openai-codex/gpt-5.5:xhigh" },
		});
		const registry = { getAvailable: () => [gpt55] } as Parameters<typeof resolveModelOverride>[1];

		const expectations = [
			{ name: "reviewer", level: Effort.XHigh },
			{ name: "plan", level: Effort.High },
		] as const;
		for (const { name, level } of expectations) {
			const agent = getBundledAgent(name);
			expect(agent?.thinkingLevel).toBe(Effort.High);
			const patterns = resolveAgentModelPatterns({ agentModel: agent?.model, settings });
			const resolved = resolveModelOverride(patterns, registry, settings);
			expect(resolved.model?.provider).toBe("openai-codex");
			expect(resolved.model?.id).toBe("gpt-5.5");
			expect(resolved.thinkingLevel).toBe(level);
			expect(resolved.explicitThinkingLevel).toBe(true);
		}
	});
});
