import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import requestTakeoverDescription from "../prompts/tools/duo-request-takeover.md" with { type: "text" };
import type { TakeoverDecision, TakeoverPurpose } from "./state";

const takeoverSchema = type({
	purpose: type("'recover' | 'verify'").describe(
		"recover = executor is off-track or looping; verify = completion claim needs independent verification.",
	),
	reason: type("string").describe("Evidence-backed justification for the takeover request."),
	directive: type("string").describe("What the planner should do first after taking over."),
});

type RequestTakeoverParams = typeof takeoverSchema.infer;

export class RequestTakeoverTool implements AgentTool<typeof takeoverSchema, undefined> {
	readonly name = "request_takeover";
	readonly label = "Request takeover";
	readonly description: string;
	readonly parameters = takeoverSchema;
	readonly intent = "omit" as const;

	constructor(
		private readonly onTakeover: (purpose: TakeoverPurpose, reason: string, directive: string) => TakeoverDecision,
	) {
		this.description = prompt.render(requestTakeoverDescription);
	}

	async execute(
		_toolCallId: string,
		args: RequestTakeoverParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const decision = this.onTakeover(args.purpose, args.reason, args.directive);
		if (decision === "accepted") {
			return {
				content: [
					{
						type: "text",
						text: "Takeover scheduled — the Fable model takes the main stream at the next turn boundary.",
					},
				],
				useless: true,
			};
		}
		if (decision === "cooldown-advice") {
			return {
				content: [
					{
						type: "text",
						text: "Cooldown active — request converted to a high-severity advisory instead.",
					},
				],
				useless: true,
			};
		}
		return {
			content: [
				{
					type: "text",
					text: "Takeover limit reached — surface your findings as advice; manual /duo exec is required to hand off again.",
				},
			],
			useless: true,
		};
	}
}
