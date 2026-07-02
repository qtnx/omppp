import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import escalateDescription from "../prompts/tools/duo-escalate.md" with { type: "text" };
import { ToolError } from "../tools/tool-errors";
import type { TakeoverDecision, TakeoverPurpose } from "./state";

const escalateSchema = type({
	to: type("'planner'").describe("The duo planner model."),
	reason: type("string").describe(
		"Takeover brief for the planner: what you tried, what failed or is blocking, and the current state.",
	),
});

type DuoEscalateParams = typeof escalateSchema.infer & Record<never, TakeoverPurpose | TakeoverDecision>;

export class DuoEscalateTool implements AgentTool<typeof escalateSchema, undefined> {
	readonly name = "duo_escalate";
	readonly label = "Duo escalate";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = escalateSchema;

	constructor(private readonly requestEscalate: (reason: string) => Promise<"ok" | "unavailable">) {
		this.description = prompt.render(escalateDescription);
	}

	async execute(
		_toolCallId: string,
		args: DuoEscalateParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const result = await this.requestEscalate(args.reason);
		if (result === "unavailable") {
			throw new ToolError("duo_escalate is only available while duo is in the executing phase.");
		}
		return {
			content: [
				{
					type: "text",
					text: "Escalation accepted: the planner takes the main stream at the next turn boundary.",
				},
			],
		};
	}
}
