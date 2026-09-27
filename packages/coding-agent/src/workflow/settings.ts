import { register } from "../config/registry";

export const cfgWorkflowEnabled = register({
	id: "workflow.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Workflow Orchestration",
		description:
			"Enable the workflow tool: deterministic multi-subagent orchestration scripts. The model only runs a workflow when you explicitly ask; spawned agents can consume significant tokens.",
	},
});

export const cfgWorkflowMaxConcurrency = register({
	id: "workflow.maxConcurrency",
	type: "number",
	default: 0,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Workflow Max Concurrency",
		description: "Concurrent agent() cap per workflow. 0 = host-aware auto (up to 8, lowered for CPU and memory).",
		options: [
			{ value: "0", label: "Auto" },
			{ value: "2", label: "2" },
			{ value: "4", label: "4" },
			{ value: "8", label: "8" },
			{ value: "16", label: "16" },
		],
	},
});

export const cfgWorkflowTokenBudget = register({
	id: "workflow.tokenBudget",
	type: "number",
	default: 0,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "Workflow Token Budget",
		description: "Hard ceiling on subagent output tokens per workflow. 0 = no budget (budget.total is null).",
	},
});
