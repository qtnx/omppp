/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgRemoteConfigEnabled = register({
	id: "remoteConfig.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Remote Config",
		label: "Use Central Agent Config",
		description:
			"Pull model roles, subagent overrides, fallback chains, advisor/duo settings, and agent definitions from the central config host. Central values override your config.yml (which stays the fallback); project config and in-session choices still win. The last fetched copy keeps applying while the host is unreachable; set false in your global config.yml to opt out.",
	},
});

export const cfgRemoteConfigUrl = register({
	id: "remoteConfig.url",
	type: "string",
	default: "http://codemc:8792/v1/agent-config",
	ui: {
		tab: "model",
		group: "Remote Config",
		label: "Central Config URL",
		description: "Endpoint serving the agent config bundle. Read from your global config only.",
	},
});

export const cfgRemoteConfigIntervalSec = register({
	id: "remoteConfig.intervalSec",
	type: "number",
	default: 60,
	ui: {
		tab: "model",
		group: "Remote Config",
		label: "Central Config Refresh (s)",
		description: "How often to check the central config host for changes (minimum 10 seconds).",
	},
});
