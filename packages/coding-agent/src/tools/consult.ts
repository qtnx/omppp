import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import type { AdvisorConsultResult } from "../advisor";
import type { ToolSession } from "./index";

const consultSchema = type({
	question: type("string").describe(
		"What you are weighing and why you are unsure. The advisor has watched the whole session, so reference the context rather than re-explaining it.",
	),
	"async?": type("boolean").describe(
		"Fire-and-forget: dispatch without blocking; the advisor replies later through an advisory note (its advise channel). Default false = block until it answers. Use only for non-gating background questions.",
	),
});

type ConsultParams = typeof consultSchema.infer;

/**
 * "Phone a friend": ask the always-watching advisor a question mid-turn and
 * block until it answers by default. With `async: true`, dispatch the question
 * without blocking; the advisor replies later through its normal advisory note
 * channel. Interruptible — ESC / steering aborts the wait so the primary is
 * never wedged behind a slow advisor.
 */
export class ConsultTool implements AgentTool<typeof consultSchema> {
	readonly name = "consult";
	readonly label = "Consult advisor";
	readonly loadMode = "essential";
	readonly description =
		"Ask the always-watching advisor for a second opinion when you are genuinely torn — stuck between two or more approaches, weighing a high-risk or hard-to-reverse decision, or doubting your own conclusion. The advisor has watched the whole session, so state what you are weighing and why, referencing context rather than re-explaining it. Blocks until it answers by default; pass `async: true` to dispatch without blocking (the advisor then replies through an advisory note). Advice to weigh, not an order.";
	readonly parameters = consultSchema;
	readonly interruptible = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		rawArgs: unknown,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		// Tool arguments are schema-validated before execution; accepting unknown
		// keeps this live-registered tool assignable to the erased AgentTool registry.
		const args = rawArgs as ConsultParams;
		const consult = this.session.consultAdvisor;
		if (!consult) {
			return {
				content: [{ type: "text", text: "Advisor is not active in this session." }],
				useless: true,
			};
		}
		if (args.async) {
			// Async consults are background-only: dispatch and let the advisor
			// answer later through the normal advisory-note channel.
			const dispatched = this.session.consultAdvisorAsync?.(args.question);
			if (!dispatched) {
				return {
					content: [{ type: "text", text: "Advisor is not active in this session." }],
					useless: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: "Question dispatched to the advisor asynchronously — it will reply through an advisory note when ready. Keep working; do not block on it.",
					},
				],
			};
		}
		const result = await consult(args.question, signal);
		if (result.status === "answered") {
			const failed = failedAttempts(result.attempts);
			if (failed.length === 0) {
				return { content: [{ type: "text", text: result.answer }] };
			}
			const report = [
				`Advisor answered after ${result.attempts.length} attempts (${failed.length} failed):`,
				...failed,
				"",
				result.answer,
			].join("\n");
			return { content: [{ type: "text", text: report }] };
		}
		return {
			content: [{ type: "text", text: formatConsultFailure(result) }],
			useless: true,
		};
	}
}

function failedAttempts(attempts: readonly { attempt: number; error?: string }[]): string[] {
	return attempts.filter(a => a.error !== undefined).map(a => `- attempt ${a.attempt}: ${a.error}`);
}

function attemptSummary(attempts: readonly { attempt: number; error?: string }[]): string {
	const failed = failedAttempts(attempts);
	if (attempts.length === 0) return "No advisor prompt attempt was made.";
	const head = `${attempts.length} attempt${attempts.length === 1 ? "" : "s"} made${failed.length > 0 ? `, ${failed.length} failed:` : "."}`;
	return failed.length > 0 ? [head, ...failed].join("\n") : head;
}

function formatConsultFailure(result: Exclude<AdvisorConsultResult, { status: "answered" }>): string {
	const attempts = attemptSummary(result.attempts);
	switch (result.status) {
		case "unavailable":
			return `Advisor is unavailable — no advisor runtime for this session. Enable/configure the advisor, then retry. ${attempts}`;
		case "paused":
			return `Advisor is paused. Resume or reset the advisor, then retry the consult. ${attempts}`;
		case "disposed":
			return `Advisor session was disposed. Start or rebuild the advisor session before consulting again. ${attempts}`;
		case "aborted":
			return `Consult was aborted; it will not be retried automatically. Restart the consult from a live turn if still needed. ${attempts}`;
		case "timed_out":
			return `Consult timed out after ${Math.round(result.elapsedMs / 1000)}s (ceiling ${Math.round(result.timeoutMs / 1000)}s). Retry manually or proceed with your own judgment. ${attempts}`;
		case "queue_cleared":
			return `Consult was dropped when the advisor queue was cleared (${result.reason}). Retry after the advisor lifecycle action completes. ${attempts}`;
		case "rate_limited":
			return `Advisor rate-limited, requeued — ${result.error}. Wait for quota/provider recovery; the advisor will answer via an advisory note when possible. ${attempts}`;
		case "provider_error":
			return `Advisor provider error: ${result.error}. ${result.retryable ? "Retry later." : "Fix the advisor provider/model configuration before retrying."} ${attempts}`;
		case "empty_response":
			return `Advisor responded with no text. Retry once or proceed with your own judgment. ${attempts}`;
	}
}
