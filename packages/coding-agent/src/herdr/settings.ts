import { register } from "../config/registry";

export const cfgHerdrNotifyDone = register({
	id: "herdr.notify.done",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Herdr",
		label: "Notify When Done",
		description: "Show a herdr notification when a turn finishes after unseen background work",
	},
});

export const cfgHerdrNotifyBlocked = register({
	id: "herdr.notify.blocked",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Herdr",
		label: "Notify When Blocked",
		description: "Show a herdr notification when the agent asks a question or waits for approval",
	},
});

export const cfgHerdrNotifySound = register({
	id: "herdr.notify.sound",
	type: "enum",
	values: ["none", "done", "request"] as const,
	default: "done",
	ui: {
		tab: "interaction",
		group: "Herdr",
		label: "Notification Sound",
		description: "Sound played with herdr notifications",
	},
});

export const cfgHerdrNotifyMinWorkMs = register({
	id: "herdr.notify.minWorkMs",
	type: "number",
	default: 20_000,
	ui: {
		tab: "interaction",
		group: "Herdr",
		label: "Done Notification Minimum Work",
		description:
			"Only notify on done when the turn ran at least this many milliseconds (avoids spam on quick replies)",
	},
});

export const cfgHerdrMetadataEnabled = register({
	id: "herdr.metadata.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Herdr",
		label: "Report Pane Metadata",
		description: "Report title, model, token spend and session identity to the herdr pane surface",
	},
});
