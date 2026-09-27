/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { ADVISOR_DEFAULT_BUDGET_PER_UPDATE } from "./emission-guard";

// Advisor is interactive-session assistance: protocol hosts opt in explicitly instead of inheriting the
// user's local preference, and get the default tuning rather than the user's local tuning.
export const cfgAdvisorEnabled = register({
	id: "advisor.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Enable Advisor",
		description:
			"Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes. Unset, this stays off on Claude Opus 5, Claude Fable 5, and GPT-5.6 sessions; set it explicitly to force the advisor on or off everywhere.",
	},
});

export const cfgAdvisorFallbackModel = register({
	id: "advisor.fallbackModel",
	type: "string",
	default: "gpt-5.6-sol",
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Fallback Model",
		description:
			"Model the advisor falls back to when the primary is blocked by a provider safeguard refusal; the primary is retried first on every subsequent request.",
	},
});

export const cfgAdvisorThinkingGist = register({
	id: "advisor.thinkingGist",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Thinking Gist",
		description:
			"Summarize elided middles of large thinking blocks with the tiny/smol model in the advisor feed. Off: middles are elided with a pointer to the full artifact only.",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorThinkingClampChars = register({
	id: "advisor.thinkingClampChars",
	type: "number",
	default: 0,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Thinking Clamp Chars",
		description:
			"Max characters of a primary thinking block fed to the advisor before it is clamped (middle elided behind a gist marker, full text spilled to an artifact). 0 = pass full thinking untruncated (default); set e.g. 2000 to re-enable clamping.",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorConsult = register({
	id: "advisor.consult",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Consult Tool",
		description:
			"Expose a consult tool so the main agent can ask the advisor for guidance mid-task (blocks until the advisor answers).",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorDoneGate = register({
	id: "advisor.doneGate",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Done Review",
		description:
			"Before the main agent concludes a response that claims completion of mutating work, ask the advisor to verify the claim against transcript evidence; a reject sends the agent back with the missing items (max 2 rounds).",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorSyncBacklog = register({
	id: "advisor.syncBacklog",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "1", "3", "5"] as const,
	default: "off",
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Sync Backlog",
		description:
			"Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorImmuneTurns = register({
	id: "advisor.immuneTurns",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 3,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Immune Turns",
		description:
			"After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.",
		options: [
			{ value: "0", label: "0 turns", description: "Allow every concern/blocker to interrupt." },
			{ value: "1", label: "1 turn" },
			{ value: "2", label: "2 turns" },
			{ value: "3", label: "3 turns", description: "Default." },
			{ value: "4", label: "4 turns" },
			{ value: "5", label: "5 turns" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorMaxNotesPerUpdate = register({
	id: "advisor.maxNotesPerUpdate",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: ADVISOR_DEFAULT_BUDGET_PER_UPDATE,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Max Notes Per Update",
		description:
			"Maximum non-blocker advice notes accepted per advisor prompt update (1–32; UI offers 1–5 quick picks). Blockers are exempt.",
		options: [
			{ value: "1", label: "1 note", description: "Anti-flood (strict)." },
			{ value: "2", label: "2 notes" },
			{ value: "3", label: "3 notes" },
			{ value: "4", label: "4 notes", description: "Default." },
			{ value: "5", label: "5 notes" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorEvictStaleResults = register({
	id: "advisor.evictStaleResults",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Evict Stale Results",
		description:
			"Before each review, replace the advisor's read/grep/glob output from older reviews with a short placeholder. The latest review is kept.",
		condition: "advisorEnabled",
	},
});
