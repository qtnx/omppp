/** Type definitions for the workflow orchestration subsystem. */
import * as z from "zod/v4";
import type { AgentProgress, AgentSource } from "../task/types";

/** EventBus channel for live workflow progress frames. */
export const WORKFLOW_PROGRESS_CHANNEL = "workflow:progress";
/** Lifetime backstop on total agent() calls in a single run. */
export const MAX_WORKFLOW_AGENTS = 1000;
/** Per-agent stall timeout (ms) before a spawn is surfaced as stalled. */
export const WORKFLOW_AGENT_STALL_MS = 180_000;
/** Maximum persisted workflow script size (bytes). */
export const MAX_WORKFLOW_SCRIPT_BYTES = 524_288;

export interface WorkflowMeta {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: Array<string | { title: string; model?: string }>;
}

export interface WorkflowAgentOpts {
	label?: string;
	phase?: string;
	/** JTD schema object (same format as the task tool's `schema`); forces structured output. */
	schema?: unknown;
	model?: string | string[];
	/** Reserved for worktree isolation. */
	isolation?: "worktree";
	/** Named agent type from discovered agents; defaults to bundled `workflow-subagent`. */
	agentType?: string;
}

export const workflowSchema = z.object({
	script: z.string().optional().describe("Inline JavaScript workflow script."),
	scriptPath: z.string().optional().describe("Path to a persisted workflow script (overrides `script`)."),
	name: z.string().optional().describe("Name of a saved/bundled workflow to run."),
	args: z.unknown().optional().describe("Value exposed to the script as the `args` global."),
	resumeFromRunId: z.string().optional().describe("Resume from a previous run id (same session)."),
});
export type WorkflowParams = z.infer<typeof workflowSchema>;

export type WorkflowAgentState = "start" | "done" | "error" | "cached";

export type WorkflowProgressFrame =
	| { kind: "phase"; runId: string; index: number; title: string }
	| { kind: "log"; runId: string; message: string }
	| {
			kind: "agent";
			runId: string;
			index: number;
			label: string;
			phaseTitle?: string;
			state: WorkflowAgentState;
			agentId?: string;
			model?: string;
			error?: string;
			tokens?: number;
			durationMs?: number;
			progress?: AgentProgress;
	  };

export interface WorkflowToolDetails {
	runId: string;
	scriptPath?: string;
	meta?: WorkflowMeta;
	async?: { state: "running" | "completed" | "failed"; jobId: string; type: "workflow" };
	phases: Array<{ index: number; title: string }>;
	agents: Array<{
		index: number;
		label: string;
		phaseTitle?: string;
		state: WorkflowAgentState;
		agentId?: string;
		error?: string;
		tokens?: number;
		durationMs?: number;
	}>;
	logs: string[];
}

export type WorkflowSource = AgentSource;
