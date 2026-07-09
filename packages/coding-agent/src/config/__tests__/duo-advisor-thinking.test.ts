import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseConfiguredThinkingLevel } from "../../thinking";
import type { ModelRegistry } from "../model-registry";
import { resolveDuoConfig } from "../model-resolver";
import { Settings } from "../settings";
import { getDefault, type SettingPath } from "../settings-schema";

function model(provider: string, id: string, reasoning = false): Model {
	return buildModel({
		id,
		name: id,
		api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
		provider,
		baseUrl: `https://${provider}.example.com`,
		reasoning,
		thinking: reasoning
			? { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] }
			: undefined,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	});
}

const fable5 = model("anthropic", "claude-fable-5", true);
const opus48 = model("anthropic", "claude-opus-4.8", true);
const gpt55 = model("openai", "gpt-5.5");

const registry = {
	hasConfiguredAuth() {
		return true;
	},
} as unknown as ModelRegistry;
function duoSettings(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
	const values: Partial<Record<SettingPath, unknown>> = {
		"duo.mode": "auto",
		"duo.orchestrator": "auto",
		"duo.plannerModel": "",
		"duo.executorModel": "",
		"duo.plannerThinking": "auto",
		"duo.executorThinking": "max",
		"duo.advisorModel": "gpt-5.5",
		"duo.advisorEscalationModel": "",
		"duo.advisorEscalationThinking": "xhigh",
		"duo.doneGate": "strict",
		"duo.takeover.enabled": true,
		"duo.takeover.cooldownTurns": 4,
		"duo.takeover.maxConsecutive": 2,
		"duo.manualSwitchIntent": "plan",
		"duo.takeover.signals.enabled": true,
		"duo.takeover.signals.sentiment": true,
		"duo.takeover.signals.failureThreshold": 3,
		"duo.takeover.signals.loopThreshold": 3,
		"duo.takeover.signals.planningNeeded": true,
		...overrides,
	};
	return Settings.isolated(values);
}

describe("duo advisor thinking", () => {
	test("xhigh maps to ThinkingLevel.XHigh", () => {
		expect(parseConfiguredThinkingLevel("xhigh")).toBe(ThinkingLevel.XHigh);
	});

	test("duo advisor thinking defaults to xhigh", () => {
		expect(getDefault("duo.advisorThinking")).toBe("xhigh");
	});

	test("duo advisor model defaults to gpt-5.5 when available", () => {
		const resolved = resolveDuoConfig(duoSettings(), [fable5, opus48, gpt55], registry);

		expect(resolved?.advisor).toBeDefined();
		if (!resolved?.advisor) throw new Error("duo advisor model did not resolve");
		expect(resolved.advisor.id).toBe("gpt-5.5");
		expect(resolved.advisor.provider).toBe("openai");
	});

	test("duo advisor escalation model defaults to planner when unspecified", () => {
		const resolved = resolveDuoConfig(duoSettings(), [fable5, opus48, gpt55], registry);
		expect(resolved?.advisorEscalation).toBeDefined();
		if (!resolved?.advisorEscalation) throw new Error("duo advisor escalation model did not resolve");
		expect(resolved.advisorEscalation.id).toBe("claude-fable-5");
		expect(resolved.advisorEscalation.provider).toBe("anthropic");
		expect(resolved?.advisorEscalationThinking).toBe(ThinkingLevel.XHigh);
	});

	test("advisor is enabled by default for fresh settings", () => {
		expect(getDefault("advisor.enabled")).toBe(true);
		expect(Settings.isolated({}).get("advisor.enabled")).toBe(true);
	});
});
