import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import requestTakeoverDescription from "../prompts/tools/duo-request-takeover.md" with { type: "text" };
import { ToolError } from "../tools/tool-errors";
import type { TakeoverDecision, TakeoverPurpose } from "./state";

const takeoverSchema = type({
	reason: type("string").describe("Evidence-backed justification for the takeover request."),
	"directive?": type("string").describe("For recover purpose only: what the planner should do first after takeover."),
	"purpose?": type("'recover' | 'plan'").describe(
		"Use recover for failed execution recovery; use plan when the planner must re-plan before execution continues. Defaults to recover.",
	),
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
		private readonly onPlanTakeover?: (reason: string) => Promise<boolean>,
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
		const purpose = args.purpose ?? "recover";
		if (purpose === "plan") {
			if (!this.onPlanTakeover) {
				throw new ToolError(
					"request_takeover purpose plan is unavailable: no duo plan-takeover callback is wired.",
				);
			}
			const accepted = await this.onPlanTakeover(args.reason);
			return {
				content: [
					{
						type: "text",
						text: accepted
							? "Planning takeover accepted: the planner takes the main stream now."
							: "Planning takeover unavailable: duo is not executing, the planner already holds the stream, or no planner is available.",
					},
				],
				useless: true,
			};
		}
		if (!args.directive?.trim()) {
			throw new ToolError("request_takeover purpose recover requires directive.");
		}
		const decision = this.onTakeover("recover", args.reason, args.directive);
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
