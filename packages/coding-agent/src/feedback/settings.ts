/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgFeedbackRatingPrompt = register({
	id: "feedback.ratingPrompt",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: "Session Rating Prompt",
		description:
			"After the agent finishes and the terminal has been idle, ask once per session for a 1-5 rating (low ratings ask what went wrong). Stored locally; see /feedback.",
	},
});

export const cfgFeedbackRatingIdleSeconds = register({
	id: "feedback.ratingIdleSeconds",
	type: "number",
	default: 90,
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: "Session Rating Delay",
		description: "Seconds to wait while idle before asking for a session rating",
		options: [
			{ value: "30", label: "30 seconds" },
			{ value: "60", label: "1 minute" },
			{ value: "90", label: "90 seconds" },
			{ value: "180", label: "3 minutes" },
			{ value: "300", label: "5 minutes" },
		],
	},
});
