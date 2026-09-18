/**
 * Eval tasks for `browser_jev` against the XLords game app.
 *
 * Each task is one explicit goal that a single `browser_jev` call should finish
 * in one shot, including clearing whatever blocks the page puts in the way (a
 * modal, an end-of-round gate, a consent banner). The `expect` block encodes the
 * observable outcome, never a selector: a task passes when the tool's own report
 * matches the expected status and shows the evidence marker, with no main-model
 * hand-holding in between.
 *
 * The app publishes its own accessibility mirror for sprite-based content:
 * `div#a11y-layer` holds real `<button aria-label="Mines level 13, idle">`
 * controls (invisible, `pointer-events: auto`) whose boxes are the building
 * positions on the canvas. `data-a11y-id` on those buttons (e.g.
 * `building:mines`) is the machine-readable identity to assert on when a label
 * alone is ambiguous.
 */

export type EvalViewport = "desktop" | "tablet" | "mobile" | "mobile-landscape";

export interface EvalTask {
	id: string;
	title: string;
	url: string;
	/** The goal handed to `browser_jev`; must state every literal value it needs. */
	goal: string;
	/** Viewports this task is meaningful under. */
	viewports: EvalViewport[];
	expect: {
		status: "done" | "blocked" | "max_steps";
		/** Substrings that must appear in the report (URL fragment, page text, step label). */
		markers: string[];
		/** True when the task is expected to need a rescue turn to finish. */
		needsRescue?: boolean;
	};
	/** Why this task exists and what it stresses. */
	notes: string;
}

export const TASKS: EvalTask[] = [
	{
		id: "upgrade-building",
		title: "Upgrade a building to its next level",
		url: "http://dev.xlords.tnx.local/app",
		goal: "Upgrade the Mines to its next level: open the Mines building from the city, then use the upgrade control for the next level and confirm the upgrade. Report the level shown after the action.",
		viewports: ["desktop", "tablet", "mobile"],
		expect: {
			status: "done",
			markers: ["Mines", "level"],
			needsRescue: true,
		},
		notes: "City buildings live on the canvas but expose DOM mirror buttons in #a11y-layer; the upgrade panel is a normal DOM dialog. Stresses canvas-to-DOM target discovery plus the confirm step.",
	},
	{
		id: "collect-rss",
		title: "Collect a resource tile on the world map",
		url: "http://dev.xlords.tnx.local/app",
		goal: "Go to the world map and collect one resource tile: open the map view, select a resource node (RSS) on the map, and collect it.",
		viewports: ["desktop", "tablet", "mobile"],
		expect: {
			status: "done",
			markers: ["collect"],
			needsRescue: true,
		},
		notes: "Map interaction is canvas-driven with sprite nodes; expects mirror controls or a map panel to expose the node. Stresses a flow where the target is only visible after a view switch.",
	},
	{
		id: "send-chat",
		title: "Send a chat message",
		url: "http://dev.xlords.tnx.local/app",
		goal: 'Send the message "eval ping" to the current chat channel: open the chat input, type exactly "eval ping", and send it.',
		viewports: ["desktop", "tablet", "mobile"],
		expect: {
			status: "done",
			markers: ["eval ping"],
		},
		notes: "Pure DOM flow with a literal value the helper model must copy verbatim — the cheapest end-to-end probe of the text helper and the send path.",
	},
	{
		id: "claim-quest",
		title: "Claim a completed quest reward",
		url: "http://dev.xlords.tnx.local/app",
		goal: "Claim the completed quest reward: open the quest panel, find the quest whose reward is ready, and press its claim control.",
		viewports: ["desktop", "tablet", "mobile"],
		expect: {
			status: "done",
			markers: ["quest"],
			needsRescue: true,
		},
		notes: "The city HUD shows a claim entry point; the reward panel may open as a modal over the canvas, which is exactly the blocker class the rescue turn exists for.",
	},
];

export function tasksFor(taskId?: string, viewport?: EvalViewport): Array<{ task: EvalTask; viewport: EvalViewport }> {
	const selected = taskId ? TASKS.filter(task => task.id === taskId) : TASKS;
	const rows: Array<{ task: EvalTask; viewport: EvalViewport }> = [];
	for (const task of selected) {
		for (const candidate of task.viewports) {
			if (viewport && candidate !== viewport) continue;
			rows.push({ task, viewport: candidate });
		}
	}
	return rows;
}
