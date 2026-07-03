import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";

const doneVerdictSchema = type({
	verdict: type("'approve' | 'reject'").describe(
		"Whether the agent's completion claim is proven by transcript evidence.",
	),
	"missing?": type("string[]").describe(
		"One concrete, actionable item per unproven completion claim. Required when rejecting.",
	),
	"note?": type("string").describe("Optional brief context for the verdict."),
});

export type DoneVerdictParams = typeof doneVerdictSchema.infer;

export interface DoneVerdict {
	verdict: "approve" | "reject";
	missing?: string[];
	note?: string;
}

/**
 * Advisor-only tool (NO builtin registry entry) the advisor calls exactly once
 * during a done-review to record its approve/reject verdict. The session nulls
 * its pending resolver after the first resolution, so `onVerdict` returns
 * `false` for any duplicate call and the tool reports that no review is pending.
 */
export class DoneVerdictTool implements AgentTool<typeof doneVerdictSchema, undefined> {
	readonly name = "done_verdict";
	readonly label = "Done verdict";
	readonly description =
		"Record your done-review verdict. Call this EXACTLY ONCE, and only when the session update contains a done-review request. Approve only when every completion claim is proven by transcript evidence; otherwise reject with one concrete, actionable `missing` item per unproven claim.";
	readonly parameters = doneVerdictSchema;
	readonly intent = "omit" as const;

	constructor(private readonly onVerdict: (verdict: DoneVerdict) => boolean) {}

	async execute(
		_toolCallId: string,
		args: DoneVerdictParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<undefined>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<undefined>> {
		const pending = this.onVerdict({ verdict: args.verdict, missing: args.missing, note: args.note });
		if (!pending) {
			return { content: [{ type: "text", text: "No done-review in progress." }], useless: true };
		}
		return { content: [{ type: "text", text: "Verdict recorded." }], useless: true };
	}
}
