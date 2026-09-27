/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgCodegraphEnabled = register({
	id: "codegraph.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "CodeGraph",
		label: "CodeGraph",
		description: "Enable CodeGraph tools and background workspace indexing",
	},
});

export const cfgCodegraphAutoIndex = register({
	id: "codegraph.autoIndex",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "CodeGraph",
		label: "Auto Index",
		description: "Automatically initialize or sync the CodeGraph index when a session starts",
	},
});
