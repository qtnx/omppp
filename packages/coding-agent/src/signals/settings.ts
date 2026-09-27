/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgSignalsEnabled = register({
	id: "signals.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Signals",
		label: "TypeSafe Turn Signals",
		description:
			"Classify each primary turn with TypeSafe System One (work phase, needs-review, stuck, done-without-evidence). Active when an endpoint or TYPESAFE_API_KEY / signals.apiKey is set; off or unavailable means every consumer behaves as before.",
	},
});

export const cfgSignalsApiKey = register({
	id: "signals.apiKey",
	type: "string",
	default: "",
	credential: true,
	ui: {
		tab: "model",
		group: "Signals",
		label: "TypeSafe API Key",
		description: "TypeSafe API key. The TYPESAFE_API_KEY environment variable takes precedence.",
		secret: true,
	},
});

export const cfgSignalsBaseUrl = register({
	id: "signals.baseUrl",
	type: "string",
	default: "http://codemc:8791/v1/systemone",
	ui: {
		tab: "model",
		group: "Signals",
		label: "System One Endpoint",
		description:
			"System One endpoint. Defaults to the tailnet proxy on codemc, which holds the API key; set https://api.typesafe.ai/v1/systemone to call TypeSafe directly (an API key is then required), or leave empty to disable signals without a key. TYPESAFE_SYSTEMONE_URL overrides this.",
	},
});

export const cfgSignalsModel = register({
	id: "signals.model",
	type: "string",
	default: "jev-latest",
	ui: {
		tab: "model",
		group: "Signals",
		label: "TypeSafe Model",
		description: "System One model name or alias sent in the request model field.",
	},
});

export const cfgSignalsTimeoutMs = register({
	id: "signals.timeoutMs",
	type: "number",
	default: 4000,
	ui: {
		tab: "model",
		group: "Signals",
		label: "TypeSafe Timeout (ms)",
		description: "Per-request timeout. A timed-out classification is treated as unavailable (fail-open).",
	},
});

export const cfgSignalsScoutSourceDetail = register({
	id: "signals.scoutSourceDetail",
	type: "string",
	default: "headers",
	ui: {
		tab: "model",
		group: "Signals",
		label: "Scout Source Detail",
		description:
			"Choose how much source code Scout may share. Names and paths are shared in every mode; recognized secrets are hidden.",
		options: [
			{
				value: "headers",
				label: "Names only",
				description: "Share declaration names and locations, without source bodies or literal values",
			},
			{
				value: "outline",
				label: "Outline",
				description: "Declarations plus unfolded bodies; a short file may go out whole",
			},
			{
				value: "bodies",
				label: "Bodies on retry",
				description: "Outline first; a rejected ranking is retried with full bodies of files up to 400 lines",
			},
		],
	},
});

export const cfgSignalsAdvisorGateEnabled = register({
	id: "signals.advisorGate.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Signals",
		label: "Advisor Review Gate",
		description:
			"Let the advisor skip turns TypeSafe rates as not worth its attention (chit-chat, short answers, routine progress), whether in-progress or just yielded. Only a consult or an unclassified turn bypasses the classifier's verdict.",
	},
});

export const cfgSignalsAdvisorGateReviewThreshold = register({
	id: "signals.advisorGate.reviewThreshold",
	type: "number",
	default: 0.5,
	ui: {
		tab: "model",
		group: "Signals",
		label: "Advisor Review Threshold",
		description: "Advisor-needed probability (0-1) at or above which a turn is sent to the advisor.",
	},
});

export const cfgSignalsStuckThreshold = register({
	id: "signals.stuckThreshold",
	type: "number",
	default: 0.6,
	ui: {
		tab: "model",
		group: "Signals",
		label: "Stuck Threshold",
		description:
			"Stuck score (0 advancing, 1 stuck) at or above which, for two consecutive turns, duo raises an automatic recover takeover signal.",
	},
});
