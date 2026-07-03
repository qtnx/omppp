import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import type { ToolSession } from "./index";

const consultSchema = type({
	question: type("string").describe(
		"What you are weighing and why you are unsure. The advisor has watched the whole session, so reference the context rather than re-explaining it.",
	),
});

type ConsultParams = typeof consultSchema.infer;

/**
 * "Phone a friend": ask the always-watching advisor a question mid-turn and
 * block until it answers. The advisor has the full session transcript, so the
 * question can reference context rather than restate it. Interruptible — ESC /
 * steering aborts the wait so the primary is never wedged behind a slow advisor.
 */
export class ConsultTool implements AgentTool<typeof consultSchema, undefined> {
	readonly name = "consult";
	readonly label = "Consult advisor";
	readonly loadMode = "essential";
	readonly description =
		"Ask the always-watching advisor for a second opinion when you are genuinely torn — stuck between two or more approaches, weighing a high-risk or hard-to-reverse decision, or doubting your own conclusion. The advisor has watched the whole session, so state what you are weighing and why, referencing context rather than re-explaining it. Blocks until it answers. Advice to weigh, not an order.";
	readonly parameters = consultSchema;
	readonly interruptible = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		args: ConsultParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const consult = this.session.consultAdvisor;
		if (!consult) {
			return {
				content: [{ type: "text", text: "Advisor is not active in this session." }],
				useless: true,
			};
		}
		const answer = await consult(args.question, signal);
		if (answer !== null) {
			return { content: [{ type: "text", text: answer }] };
		}
		// Distinguish "advisor never ran" (inactive) from "ran but no answer in
		// time" so the agent knows whether to expect one at all.
		if (!this.session.isAdvisorActive?.()) {
			return {
				content: [{ type: "text", text: "Advisor is not active in this session." }],
				useless: true,
			};
		}
		return {
			content: [{ type: "text", text: "The advisor did not answer in time. Proceed with your own judgment." }],
			useless: true,
		};
	}
}
