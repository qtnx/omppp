import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { applyModelOverride } from "../../src/config/model-patch";
import type { ModelRegistry } from "../../src/config/model-registry";
import { resolveDuoConfig } from "../../src/config/model-resolver";
import { Settings } from "../../src/config/settings";
import type { SettingPath } from "../../src/config/settings-schema";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";

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
const openaiSol = buildModel({
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
	contextWindow: 200000,
	maxTokens: 8192,
});

const registry = {
	hasConfiguredAuth(model: Model) {
		const providerHasAuth = model.provider === "anthropic";
		return providerHasAuth;
	},
} as unknown as ModelRegistry;

function settings(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
	const values: Partial<Record<SettingPath, unknown>> = {
		"duo.mode": "auto",
		"duo.orchestrator": "auto",
		"duo.plannerModel": "",
		"duo.executorModel": "",
		"duo.plannerThinking": "auto",
		"duo.executorThinking": "max",
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

	test("duo recovers the full window of a premium-tier-capped model, for both Astra SKUs", () => {
		for (const [provider, cappedWindow, fullWindow] of [
			["openai", 272_000, 1_050_000],
			["openai-codex", 372_000, 922_000],
		] as const) {
			const catalogAstra = getBundledModel(provider, "gpt-6-astra");
			if (!catalogAstra) throw new Error(`Expected a bundled ${provider} gpt-6-astra`);
			// Exactly what ModelRegistry leaves on the model with extendedContext off.
			const astra = applyModelOverride(catalogAstra, { contextWindow: cappedWindow });
			expect(astra.contextWindow).toBe(cappedWindow);
			const anyAuth = { hasConfiguredAuth: () => true } as unknown as ModelRegistry;

			const extended = resolveDuoConfig(
				settings({ "duo.executorModel": `${provider}/gpt-6-astra` }),
				[fable5, astra],
				anyAuth,
			);
			expect(`${extended?.executor.provider}/${extended?.executor.id}`).toBe(`${provider}/gpt-6-astra`);
			expect(extended?.executor.contextWindow).toBe(fullWindow);

			const standard = resolveDuoConfig(
				settings({ "duo.executorModel": `${provider}/gpt-6-astra`, "duo.extendedContext": false }),
				[fable5, astra],
				anyAuth,
			);
			expect(standard?.executor.contextWindow).toBe(cappedWindow);
		}
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

	test("the recovered window is what the compaction gate reads at 400K tokens", () => {
		const catalogAstra = getBundledModel("openai", "gpt-6-astra");
		if (!catalogAstra) throw new Error("Expected a bundled openai gpt-6-astra");
		const astra = applyModelOverride(catalogAstra, { contextWindow: 272_000 });
		const anyAuth = { hasConfiguredAuth: () => true } as unknown as ModelRegistry;
		const compaction = Settings.isolated().getGroup("compaction");
		const contextTokens = 400_000;

		const capped = resolveDuoConfig(
			settings({ "duo.executorModel": "openai/gpt-6-astra", "duo.extendedContext": false }),
			[fable5, astra],
			anyAuth,
		)?.executor.contextWindow;
		const extended = resolveDuoConfig(
			settings({ "duo.executorModel": "openai/gpt-6-astra" }),
			[fable5, astra],
			anyAuth,
		)?.executor.contextWindow;
		if (capped === undefined || capped === null || extended === undefined || extended === null) {
			throw new Error("duo executor did not resolve");
		}

		// A switch onto the capped model lands over the threshold and compacts on
		// arrival; the recovered window is what makes the switch survivable.
		expect(shouldCompact(contextTokens, capped, compaction)).toBe(true);
		expect(shouldCompact(contextTokens, extended, compaction)).toBe(false);
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

	test("unavailable explicit executor pattern degrades to the newest Opus instead of disabling duo", () => {
		const resolved = resolveDuoConfig(
			settings({ "duo.executorModel": "tnx/ds/deepseek-v4-flash:high" }),
			[fable5, opus47, opus48],
			registry,
		);

		expect(resolved?.executor.id).toBe("claude-opus-4.8");
		expect(resolved?.executorThinking).toBe(ThinkingLevel.Max);
	});

	test("schema defaults resolve duo from Anthropic-only auth", () => {
		const resolved = resolveDuoConfig(Settings.isolated(), [fable5, opus48], registry);

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

	test("orchestrator defaults to auto", () => {
		const resolved = resolveDuoConfig(settings(), [fable5, opus48], registry);
		const resolvedOrchestrator: "auto" | "always" | undefined = resolved?.orchestrator;

		expect(resolvedOrchestrator).toBe("auto");
	});

	test("an explicit pattern resolves from the full registry even when the auth-filtered pool omits it", () => {
		const tnxDeepseek = buildModel({
			id: "ds/deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-responses",
			provider: "tnx",
			baseUrl: "https://tnx.test/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 200000,
			maxTokens: 8192,
		});
		const poolRegistry = {
			hasConfiguredAuth: (model: Model) => model.provider === "anthropic",
			find: (provider: string, id: string) =>
				provider === "tnx" && id === "ds/deepseek-v4-flash" ? tnxDeepseek : undefined,
		} as unknown as ModelRegistry;

		const resolved = resolveDuoConfig(
			settings({ "duo.executorModel": "tnx/ds/deepseek-v4-flash" }),
			[fable5, opus48],
			poolRegistry,
		);

		expect(resolved?.planner.id).toBe("claude-fable-5");
		expect(resolved?.executor.id).toBe("ds/deepseek-v4-flash");
	});

	test("advisor stays on the planner (Fable) even when a codex model is authed", () => {
		const anyAuth = { hasConfiguredAuth: () => true } as unknown as ModelRegistry;
		const resolved = resolveDuoConfig(settings(), [fable5, opus48, openaiSol], anyAuth);

		expect(resolved?.planner.id).toBe("claude-fable-5");
		expect(resolved?.advisor?.id).toBe("claude-fable-5");
	});

	test("duo.advisorModel overrides the advisor without moving the planner", () => {
		const anyAuth = { hasConfiguredAuth: () => true } as unknown as ModelRegistry;
		const resolved = resolveDuoConfig(
			settings({ "duo.advisorModel": "gpt-5.6-sol" }),
			[fable5, opus48, openaiSol],
			anyAuth,
		);

		expect(resolved?.planner.id).toBe("claude-fable-5");
		expect(resolved?.advisor?.id).toBe("gpt-5.6-sol");
	});

	test("orchestrator resolves explicit always", () => {
		const resolved = resolveDuoConfig(settings({ "duo.orchestrator": "always" }), [fable5, opus48], registry);

		expect(resolved?.orchestrator).toBe("always");
	});

	test("orchestrator falls back to auto for absent or invalid values", () => {
		const absent = resolveDuoConfig(Settings.isolated(), [fable5, opus48], registry);
		const invalid = resolveDuoConfig(settings({ "duo.orchestrator": "sometimes" }), [fable5, opus48], registry);

		expect(absent?.orchestrator).toBe("auto");
		expect(invalid?.orchestrator).toBe("auto");
	});

	test("settings numbers, done gate, manual intent, and takeover signals flow through", () => {
		const resolved = resolveDuoConfig(
			settings({
				"duo.takeover.cooldownTurns": 9,
				"duo.takeover.maxConsecutive": 3,
				"duo.doneGate": "inherit",
				"duo.manualSwitchIntent": "summon",
				"duo.takeover.signals.enabled": false,
				"duo.takeover.signals.sentiment": false,
				"duo.takeover.signals.failureThreshold": 5,
				"duo.takeover.signals.loopThreshold": 6,
				"duo.takeover.signals.planningNeeded": false,
			}),
			[fable5, opus48],
			registry,
		);

		expect(resolved?.cooldownTurns).toBe(9);
		expect(resolved?.maxConsecutive).toBe(3);
		expect(resolved?.doneGate).toBe("inherit");
		expect(resolved?.manualSwitchIntent).toBe("summon");
		expect(resolved?.signals).toEqual({
			enabled: false,
			sentiment: false,
			failureThreshold: 5,
			loopThreshold: 6,
			planningNeeded: false,
		});
	});

	test("manual intent and takeover signals resolve from schema defaults", () => {
		const resolved = resolveDuoConfig(Settings.isolated(), [fable5, opus48], registry);

		expect(resolved?.manualSwitchIntent).toBe("plan");
		expect(resolved?.signals).toEqual({
			enabled: true,
			sentiment: true,
			failureThreshold: 3,
			loopThreshold: 3,
			planningNeeded: true,
		});
	});

	test("phase models resolve array and string values, keep order, and split the thinking suffix", () => {
		const resolved = resolveDuoConfig(
			settings({
				"duo.phaseModels": {
					debugging: [
						"anthropic/claude-fable-5:high",
						"anthropic/claude-opus-4.8",
						"anthropic/claude-fable-5:high",
					],
					reporting: "anthropic/claude-fable-4:max",
				},
			}),
			[fable5, fable4, opus48],
			registry,
		);

		expect(resolved?.phaseModels.debugging?.map(candidate => candidate.selector)).toEqual([
			"anthropic/claude-fable-5",
			"anthropic/claude-opus-4.8",
		]);
		expect(resolved?.phaseModels.debugging?.[0]?.thinkingLevel).toBe(ThinkingLevel.High);
		expect(resolved?.phaseModels.debugging?.[1]?.thinkingLevel).toBeUndefined();
		expect(resolved?.phaseModels.reporting?.map(candidate => candidate.selector)).toEqual([
			"anthropic/claude-fable-4",
		]);
		expect(resolved?.phaseModels.reporting?.[0]?.thinkingLevel).toBe(ThinkingLevel.Max);
	});

	test("an unauthenticated phase model is skipped and the remaining candidates survive", () => {
		const resolved = resolveDuoConfig(
			settings({
				"duo.phaseModels": {
					verifying: ["anthropic/claude-fable-5:high", "openai/gpt-5.6-sol", "anthropic/claude-opus-4.8"],
				},
			}),
			[fable5, openaiSol, opus48],
			registry,
		);

		expect(resolved?.phaseModels.verifying?.map(candidate => candidate.selector)).toEqual([
			"anthropic/claude-fable-5",
			"anthropic/claude-opus-4.8",
		]);
	});

	test("unknown phase keys and unresolvable phases are dropped", () => {
		const unknown = resolveDuoConfig(
			settings({ "duo.phaseModels": { shipping: "anthropic/claude-fable-5" } }),
			[fable5, opus48],
			registry,
		);
		const unresolvable = resolveDuoConfig(
			settings({ "duo.phaseModels": { debugging: ["openai/gpt-5.6-sol"] } }),
			[fable5, openaiSol, opus48],
			registry,
		);

		expect(unknown?.phaseModels).toEqual({});
		expect(unresolvable?.phaseModels).toEqual({});
	});

	test("default phase models resolve when their selectors are authenticated", () => {
		const astra = buildModel({
			id: "gpt-6-astra",
			name: "GPT 6 Astra",
			api: "openai-responses",
			provider: "openai-codex",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 200000,
			maxTokens: 8192,
		});
		const fable51 = anthropicModel("claude-fable-5-1");
		const opus5 = anthropicModel("claude-opus-5");
		const deepseek = buildModel({
			id: "openrouter/deepseek/deepseek-v4.1-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			provider: "tnx",
			baseUrl: "http://localhost:20128/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1050000,
			maxTokens: 64000,
		});
		const registryWithAuth = {
			hasConfiguredAuth(model: Model) {
				return ["anthropic", "openai-codex", "tnx"].includes(model.provider);
			},
		} as unknown as ModelRegistry;

		const resolved = resolveDuoConfig(
			settings(),
			[astra, fable51, opus5, deepseek, fable5, opus48],
			registryWithAuth,
		);

		expect(resolved?.phaseModels.preplanning?.map(candidate => candidate.selector)).toEqual([
			"anthropic/claude-opus-5",
		]);
		expect(resolved?.phaseModels.preplanning?.[0]?.thinkingLevel).toBe(ThinkingLevel.High);
		expect(resolved?.phaseModels.planning?.map(candidate => candidate.selector)).toEqual([
			"openai-codex/gpt-6-astra",
			"anthropic/claude-fable-5-1",
		]);
		expect(resolved?.phaseModels.planning?.[0]?.thinkingLevel).toBe(ThinkingLevel.High);
		expect(resolved?.phaseModels.implementing?.map(candidate => candidate.selector)).toEqual([
			"tnx/openrouter/deepseek/deepseek-v4.1-flash",
			"anthropic/claude-opus-5",
		]);
		expect(resolved?.phaseModels.verifying?.map(candidate => candidate.selector)).toEqual([
			"openai-codex/gpt-6-astra",
			"anthropic/claude-fable-5-1",
		]);
		expect(resolved?.phaseModels.debugging?.[0]?.selector).toBe("anthropic/claude-opus-5");
		expect(resolved?.phaseModels.blocked?.[0]?.selector).toBe("openai-codex/gpt-6-astra");
		expect(resolved?.phaseModels.reporting?.map(candidate => candidate.selector)).toEqual([
			"tnx/openrouter/deepseek/deepseek-v4.1-flash",
		]);
		// Scouting is not a signal work phase; it folds into planning.
		expect((resolved?.phaseModels as Record<string, unknown> | undefined)?.["scouting"]).toBeUndefined();
	});

	test("default phase models stay empty while their selectors are unauthenticated", () => {
		const resolved = resolveDuoConfig(settings(), [fable5, opus48], registry);

		expect(resolved?.phaseModels).toEqual({});
	});
});
