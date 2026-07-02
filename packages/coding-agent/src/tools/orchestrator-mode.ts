import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import orchestratorModeDescription from "../prompts/tools/orchestrator-mode.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const orchestratorModeSchema = type({
	op: "'enter' | 'exit' | 'status'",
});

type OrchestratorModeParams = typeof orchestratorModeSchema.infer;

export interface OrchestratorModeToolDetails {
	enabled: boolean;
	mode: "orchestrator" | "normal";
}

export class OrchestratorModeTool implements AgentTool<typeof orchestratorModeSchema, OrchestratorModeToolDetails> {
	readonly name = "orchestrator_mode";
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly label = "Orchestrator Mode";
	readonly summary = "Enter, exit, or inspect Safe orchestrator mode";
	readonly description: string;
	readonly parameters = orchestratorModeSchema;
	readonly strict = true;
	readonly intent = (args: Partial<OrchestratorModeParams>) => {
		if (args.op === "enter") return "entering orchestrator mode";
		if (args.op === "exit") return "exiting orchestrator mode";
		return "checking orchestrator mode";
	};

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(orchestratorModeDescription);
	}

	async execute(
		_toolCallId: string,
		params: OrchestratorModeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<OrchestratorModeToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<OrchestratorModeToolDetails>> {
		if (params.op === "enter") {
			if (!this.session.setOrchestratorModeState) {
				throw new ToolError("Orchestrator mode is unavailable in this session.");
			}
			if (this.session.getPlanModeState?.()?.enabled) {
				throw new ToolError("Exit plan mode before entering orchestrator mode.");
			}
			if (this.session.getGoalModeState?.() !== undefined) {
				throw new ToolError("Exit goal mode before entering orchestrator mode.");
			}
			await this.session.setOrchestratorModeState({ enabled: true });
			return {
				content: [{ type: "text" as const, text: "Orchestrator mode enabled." }],
				details: { enabled: true, mode: "orchestrator" },
			};
		}

		if (params.op === "exit") {
			if (!this.session.setOrchestratorModeState) {
				throw new ToolError("Orchestrator mode is unavailable in this session.");
			}
			await this.session.setOrchestratorModeState(undefined);
			return {
				content: [{ type: "text" as const, text: "Normal mode restored." }],
				details: { enabled: false, mode: "normal" },
			};
		}

		const enabled = this.session.getOrchestratorModeState?.()?.enabled === true;
		return {
			content: [
				{
					type: "text" as const,
					text: enabled ? "Orchestrator mode is active." : "Orchestrator mode is inactive.",
				},
			],
			details: { enabled, mode: enabled ? "orchestrator" : "normal" },
		};
	}
}
