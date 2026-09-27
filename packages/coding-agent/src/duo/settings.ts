/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgDuoMode = register({
	id: "duo.mode",
	type: "enum",
	values: ["auto", "on", "off"] as const,
	default: "auto",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Mode",
		description:
			"Automatic Fable<->Opus planner/executor pairing; auto activates in orchestrator mode or when the main model is a Fable-family model.",
	},
});

export const cfgDuoOrchestrator = register({
	id: "duo.orchestrator",
	type: "enum",
	values: ["auto", "always"] as const,
	default: "auto",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Orchestrator",
		description:
			"Controls when duo uses orchestrator mode: auto switches by execution scope, always keeps orchestrator mode enabled.",
	},
});

export const cfgDuoPlannerModel = register({
	id: "duo.plannerModel",
	type: "string",
	default: "anthropic/claude-fable-5-1:medium",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Planner Model",
		description:
			"Planner model pattern; supports :thinking suffix. Falls back to the newest Fable/Mythos-family model when the pattern is unavailable; empty auto-detects.",
	},
});

export const cfgDuoExecutorModel = register({
	id: "duo.executorModel",
	type: "string",
	default: "tnx/openrouter/deepseek/deepseek-v4.1-flash:high",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Executor Model",
		description:
			"Executor model pattern; supports :thinking suffix. Falls back to the newest Opus-family model when the pattern is unavailable; empty auto-detects.",
	},
});

export const cfgDuoPlannerThinking = register({
	id: "duo.plannerThinking",
	type: "string",
	default: "auto",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Planner Thinking",
		description: "Planner thinking selector used when the model pattern does not include a :thinking suffix.",
	},
});

export const cfgDuoExecutorThinking = register({
	id: "duo.executorThinking",
	type: "string",
	default: "high",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Executor Thinking",
		description: "Executor thinking selector used when the model pattern does not include a :thinking suffix.",
	},
});

export const cfgDuoAdvisorModel = register({
	id: "duo.advisorModel",
	type: "string",
	default: "",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Advisor Model",
		description:
			"Continuous duo advisor model pattern; empty keeps the advisor on the planner model (Fable). Supports :thinking suffix.",
	},
});

export const cfgDuoAdvisorThinking = register({
	id: "duo.advisorThinking",
	type: "string",
	default: "xhigh",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Advisor Thinking",
		description:
			"Thinking selector for the continuous duo advisor when the model pattern does not include a :thinking suffix.",
	},
});

export const cfgDuoAdvisorEscalationModel = register({
	id: "duo.advisorEscalationModel",
	type: "string",
	default: "",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Advisor Escalation Model",
		description:
			"High-tier advisor model pattern for blocking consult and done-review boundaries. Empty uses the duo planner model.",
	},
});

export const cfgDuoAdvisorEscalationThinking = register({
	id: "duo.advisorEscalationThinking",
	type: "string",
	default: "xhigh",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Advisor Escalation Thinking",
		description:
			"Thinking selector for high-importance duo advisor consults when the escalation model pattern has no :thinking suffix.",
	},
});

export const cfgDuoPhaseModels = register({
	id: "duo.phaseModels",
	type: "record",
	default: {
		preplanning: ["anthropic/claude-opus-5:high"],
		planning: ["openai-codex/gpt-6-astra:high", "anthropic/claude-fable-5-1:medium"],
		implementing: ["tnx/openrouter/deepseek/deepseek-v4.1-flash:high", "anthropic/claude-opus-5:high"],
		verifying: ["openai-codex/gpt-6-astra:medium", "anthropic/claude-fable-5-1:medium"],
		debugging: ["anthropic/claude-opus-5:high", "tnx/openrouter/deepseek/deepseek-v4.1-flash:high"],
		blocked: ["openai-codex/gpt-6-astra:high", "anthropic/claude-fable-5-1:medium"],
		reporting: ["tnx/openrouter/deepseek/deepseek-v4.1-flash:high"],
	} as Record<string, string | string[]>,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Phase Models",
		description:
			'JSON object mapping a work phase (preplanning, planning, implementing, verifying, debugging, blocked, reporting) to a model selector or an ordered list of selectors, e.g. {"debugging":["anthropic/claude-opus-5:high","anthropic/claude-fable-5-1:high"],"reporting":"tnx/openrouter/deepseek/deepseek-v4.1-flash:low"}. The first available selector is used; later entries become rate-limit fallbacks. Phases without an entry keep the executor model (the planner keeps planning and takeovers as before). A configured preplanning phase opens each fresh duo session on its model — the model moves on with the duo_change_phase tool. Requires TypeSafe signals (signals.enabled plus a reachable signals.baseUrl or key).',
	},
});

export const cfgDuoRoutingModels = register({
	id: "duo.routing.models",
	type: "array",
	default: [
		"tnx/openrouter/deepseek/deepseek-v4.1-flash",
		"anthropic/claude-opus-5",
		"openai-codex/gpt-6-astra",
		"anthropic/claude-fable-5-1",
	],
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Routing Ladder",
		description:
			"Order models from least to most capable. Jev adapts the model and thinking level as work progresses, skipping unavailable models. The first model is for implementation only; brainstorming and planning use higher models. Leave empty to use Duo Phase Models instead.",
		ordered: true,
	},
});

export const cfgDuoRoutingThinking = register({
	id: "duo.routing.thinking",
	type: "record",
	default: { easy: "medium", moderate: "high", hard: "high", extreme: "xhigh" } as Record<string, string>,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Routing Thinking",
		description:
			'Default thinking levels when no Jev effort choice is available, e.g. {"easy":"medium","moderate":"high","hard":"high","extreme":"xhigh"}. A :thinking suffix on a model overrides Jev. Effort on the current model follows one confident judgment and applies to the next request; a model change waits for two agreeing judgments.',
	},
});

export const cfgDuoExtendedContext = register({
	id: "duo.extendedContext",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Extended Context",
		description:
			"Give every duo-routed model its full context window instead of the standard-pricing cap, so switching model mid-task does not immediately force a compaction (GPT-6 Astra: 1.05M instead of 272K; its Codex SKU: 922K instead of 372K). Requests above the standard threshold bill at the provider's long-context rate, and a smaller explicit `contextWindow` override for a duo model is raised too — turn this off to keep it. Leaving duo restores the registry window.",
	},
});

export const cfgDuoPhaseSwitchMinConfidence = register({
	id: "duo.phaseSwitch.minConfidence",
	type: "number",
	default: 0.7,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Phase Switch Confidence",
		description:
			"Minimum phase-detection confidence (0-1) before duo switches the executor to the phase's model. The phase must also hold for two consecutive turns, except blocked which switches immediately.",
	},
});

export const cfgDuoAdvisorPromptReview = register({
	id: "duo.advisorPromptReview",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Advisor Prompt Review",
		description: "Advisor reviews each user prompt to decide a plan-first takeover.",
	},
});

export const cfgDuoDoneGate = register({
	id: "duo.doneGate",
	type: "enum",
	values: ["strict", "inherit"] as const,
	default: "strict",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Done Gate",
		description: "Strict forces the advisor done-review while duo is executing.",
	},
});

export const cfgDuoTakeoverEnabled = register({
	id: "duo.takeover.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Takeover",
		description: "Allow the planner advisor to request takeover from the executor.",
	},
});

export const cfgDuoTakeoverCooldownTurns = register({
	id: "duo.takeover.cooldownTurns",
	type: "number",
	default: 4,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Takeover Cooldown Turns",
		description: "Executor turns to wait before another recover takeover can be accepted.",
	},
});

export const cfgDuoTakeoverMaxConsecutive = register({
	id: "duo.takeover.maxConsecutive",
	type: "number",
	default: 2,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Takeover Max Consecutive",
		description: "Maximum consecutive planner takeovers before requiring manual handoff.",
	},
});

export const cfgDuoManualSwitchIntent = register({
	id: "duo.manualSwitchIntent",
	type: "enum",
	values: ["plan", "summon"] as const,
	default: "plan",
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Manual Switch Intent",
		description:
			"What a manual switch to the planner model during duo executing means. plan = enter the duo planning phase to write a complete locked plan (duo_handoff hands it to the executor); summon = transient advisory summon that returns to the executor quickly.",
	},
});

export const cfgDuoTakeoverSignalsEnabled = register({
	id: "duo.takeover.signals.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Takeover Signals",
		description:
			"Automatically request planner takeover from per-turn executor signals: tool-failure streaks, loops, and unverified done claims.",
	},
});

export const cfgDuoTakeoverSignalsSentiment = register({
	id: "duo.takeover.signals.sentiment",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Sentiment Signal",
		description:
			"Include negative user sentiment (scolding) in automatic takeover signals; combined with a failure streak or loop it bypasses the recover cooldown.",
	},
});

export const cfgDuoTakeoverSignalsFailureThreshold = register({
	id: "duo.takeover.signals.failureThreshold",
	type: "number",
	default: 3,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Failure Signal Threshold",
		description: "Consecutive failed tool results that trigger an automatic recover takeover request.",
	},
});

export const cfgDuoTakeoverSignalsLoopThreshold = register({
	id: "duo.takeover.signals.loopThreshold",
	type: "number",
	default: 3,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Loop Signal Threshold",
		description: "Identical tool calls (same name and arguments) since the last user prompt that count as a loop.",
	},
});

export const cfgDuoTakeoverSignalsPlanningNeeded = register({
	id: "duo.takeover.signals.planningNeeded",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Duo",
		label: "Duo Planning-Needed Signal",
		description:
			"Automatically enter the duo planning phase (planner takeover) when an incoming user message is plan-shaped: imperative build language plus scope markers such as lists, multiple clauses, or multiple file mentions.",
	},
});
