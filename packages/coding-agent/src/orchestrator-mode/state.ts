export interface OrchestratorModeState {
	enabled: true;
}

export const ORCHESTRATOR_MODE_CONTROL_TOOL_NAMES = ["orchestrator_mode"] as const;

export const ORCHESTRATOR_MODE_SAFE_TOOL_NAMES = [
	"task",
	"todo",
	"workflow",
	"job",
	"irc",
	"read",
	"grep",
	"glob",
	"lsp",
	"web_search",
	"search_tool_bm25",
	"duo_handoff",
	"duo_escalate",
	"consult",
] as const;

export const ORCHESTRATOR_MODE_CONTEXT_TOOL_NAMES = [
	"compact",
	"shake",
	"context_inventory",
	"context_unload",
	"context_recall",
	"context_pin",
] as const;

export const ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES = [
	...ORCHESTRATOR_MODE_CONTROL_TOOL_NAMES,
	...ORCHESTRATOR_MODE_SAFE_TOOL_NAMES,
	...ORCHESTRATOR_MODE_CONTEXT_TOOL_NAMES,
] as const;
