import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import handoffDescription from "../prompts/tools/duo-handoff.md" with { type: "text" };
import { ToolError } from "../tools/tool-errors";
import type { DuoHandoffResult } from "./controller";
import type { DuoExecutionScope, TakeoverDecision, TakeoverPurpose } from "./state";

const handoffSchema = type({
	to: type("'executor'").describe("The duo executor model."),
	resolution: type("string").describe(
		"Brief for the executor and advisor: what was planned or resolved, current state, and next steps.",
	),
	"scope?": type("'single' | 'multi'").describe(
		"Task scope for the executor: 'single' = one-phase task, executor works directly with full tools; 'multi' = multi-phase work, executor runs in Safe orchestrator mode and delegates. Omit to keep the current scope.",
	),
});

type DuoHandoffParams = typeof handoffSchema.infer & Record<never, TakeoverPurpose | TakeoverDecision>;

export class DuoHandoffTool implements AgentTool<typeof handoffSchema, undefined> {
	readonly name = "duo_handoff";
	readonly label = "Duo handoff";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = handoffSchema;

	constructor(
		private readonly requestHandoff: (resolution: string, scope?: DuoExecutionScope) => Promise<DuoHandoffResult>,
	) {
		this.description = prompt.render(handoffDescription);
	}

	async execute(
		_toolCallId: string,
		args: DuoHandoffParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const result = await this.requestHandoff(args.resolution, args.scope);
		if (result === "no-controller") {
			throw new ToolError("duo_handoff is unavailable: no duo controller is active in this session.");
		}
		if (result === "wrong-phase") {
			throw new ToolError(
				"duo_handoff is unavailable: duo is not in a phase that can hand off (only planning, takeover, executing, or degraded).",
			);
		}
		if (result === "already-executor") {
			throw new ToolError("duo_handoff: the resolved executor already holds the main stream — nothing to hand off.");
		}
		if (result === "switch-failed") {
			throw new ToolError("duo_handoff failed: could not switch the main-stream model (see logs).");
		}
		return { content: [{ type: "text", text: "Handoff to executor scheduled at the next turn boundary." }] };
	}
}
