/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgIrcEnabled = register({
	id: "irc.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Execution",
		label: "IRC",
		description: "Enable agent-to-agent messaging for sessions that have addressable peers",
	},
});

export const cfgIrcTimeoutMs = register({
	id: "irc.timeoutMs",
	type: "number",
	default: 120_000,
	ui: {
		tab: "tools",
		group: "Execution",
		label: "IRC Timeout",
		description:
			"Default timeout for irc wait (and send await:true) in milliseconds; 0 means one max window (10m). Hub wait settings remain independent.",
		options: [
			{ value: "0", label: "10-minute max window" },
			{ value: "30000", label: "30 seconds" },
			{ value: "60000", label: "1 minute" },
			{ value: "120000", label: "2 minutes" },
			{ value: "300000", label: "5 minutes" },
		],
	},
});
