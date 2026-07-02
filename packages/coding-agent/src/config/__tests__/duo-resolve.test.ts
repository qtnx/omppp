import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AUTO_THINKING } from "../../thinking";
import type { ModelRegistry } from "../model-registry";
import { resolveDuoConfig } from "../model-resolver";
import { Settings } from "../settings";
import type { SettingPath } from "../settings-schema";

function anthropicModel(id: string): Model {
	const name = id
		.split("-")
		.map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join(" ");
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		},
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const fable4 = anthropicModel("claude-fable-4");
const fable5 = anthropicModel("claude-fable-5");
const opus47 = anthropicModel("claude-opus-4.7");
const opus48 = anthropicModel("claude-opus-4.8");

const registry = {
	hasConfiguredAuth(model: Model) {
		const providerHasAuth = model.provider === "anthropic";
		return providerHasAuth;
	},
} as unknown as ModelRegistry;

function settings(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
	const values: Partial<Record<SettingPath, unknown>> = {
		"duo.mode": "auto",
		"duo.plannerModel": "",
		"duo.executorModel": "",
		"duo.plannerThinking": "auto",
		"duo.executorThinking": "max",
		"duo.doneGate": "strict",
		"duo.takeover.enabled": true,
		"duo.takeover.cooldownTurns": 4,
		"duo.takeover.maxConsecutive": 2,
		...overrides,
	};
	return Settings.isolated(values);
}

describe("resolveDuoConfig", () => {
	test("explicit pattern wins over auto-detect", () => {
		const resolved = resolveDuoConfig(
			settings({ "duo.plannerModel": "anthropic/claude-fable-4" }),
			[fable5, fable4, opus48],
			registry,
		);

		expect(resolved?.planner.id).toBe("claude-fable-4");
		expect(resolved?.executor.id).toBe("claude-opus-4.8");
	});

	test(":thinking suffix produces that explicit level", () => {
		const resolved = resolveDuoConfig(
			settings({ "duo.plannerModel": "claude-fable-5:high" }),
			[fable5, opus48],
			registry,
		);

		expect(resolved?.planner.id).toBe("claude-fable-5");
		expect(resolved?.plannerThinking).toBe(ThinkingLevel.High);
		expect(resolved?.executorThinking).toBe(ThinkingLevel.Max);
	});

	test("auto-detect picks the higher-version fable over a lower one", () => {
		const resolved = resolveDuoConfig(settings(), [fable4, opus48, fable5], registry);

		expect(resolved?.planner.id).toBe("claude-fable-5");
		expect(resolved?.plannerThinking).toBe(AUTO_THINKING);
	});

	test("opus side auto-detects independently", () => {
		const resolved = resolveDuoConfig(settings(), [opus47, fable5, opus48], registry);

		expect(resolved?.planner.id).toBe("claude-fable-5");
		expect(resolved?.executor.id).toBe("claude-opus-4.8");
	});

	test("missing planner family returns undefined", () => {
		const resolved = resolveDuoConfig(settings(), [opus48], registry);

		expect(resolved).toBeUndefined();
	});

	test("missing executor family returns undefined", () => {
		const resolved = resolveDuoConfig(settings(), [fable5], registry);

		expect(resolved).toBeUndefined();
	});

	test("settings numbers and done gate flow through", () => {
		const resolved = resolveDuoConfig(
			settings({
				"duo.takeover.cooldownTurns": 9,
				"duo.takeover.maxConsecutive": 3,
				"duo.doneGate": "inherit",
			}),
			[fable5, opus48],
			registry,
		);

		expect(resolved?.cooldownTurns).toBe(9);
		expect(resolved?.maxConsecutive).toBe(3);
		expect(resolved?.doneGate).toBe("inherit");
	});
});
