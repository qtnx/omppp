import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { CompactToolDetails } from "@oh-my-pi/pi-tui/tools/compact";
import { prompt } from "@oh-my-pi/pi-utils";
import compactDescription from "../prompts/tools/compact.md" with { type: "text" };
import type { ToolCompactionRequest, ToolSession } from ".";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const compactSchema = type({
	reason: type("string")
		.atLeastLength(1)
		.atMostLength(500)
		.describe("why compaction is appropriate now — the boundary just reached"),
	"focus?": type("string")
		.atLeastLength(1)
		.atMostLength(2000)
		.describe("what the compaction summary must preserve or emphasize"),
});

type CompactParams = typeof compactSchema.infer;

export class CompactTool implements AgentTool<typeof compactSchema, CompactToolDetails> {
	readonly name = "compact";
	readonly approval = "read" as const;
	readonly label = "Compact";
	readonly summary = "Archive older conversation history to free context space";
	readonly description: string;
	readonly parameters = compactSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<CompactParams>) => (args.reason ? `compacting: ${args.reason}` : "compacting");

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(compactDescription);
	}

	static createIf(session: ToolSession): CompactTool | null {
		if (session.settings.getGroup("compaction").methodOrder.length === 0) return null;
		if (session.requestCompaction === undefined) return null;
		return new CompactTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CompactParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CompactToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CompactToolDetails>> {
		const requestCompaction = this.session.requestCompaction;
		if (requestCompaction === undefined) {
			throw new ToolError("Compaction is not available in this session.");
		}

		const result: ToolCompactionRequest = requestCompaction(params.reason, { focus: params.focus });
		if (result.status === "unavailable") {
			throw new ToolError(`Cannot compact: ${result.detail}`);
		}

		const details: CompactToolDetails = { reason: params.reason, status: result.status };
		if (result.status === "already-scheduled") {
			return toolResult<CompactToolDetails>(details)
				.text("Compaction already scheduled — it runs when the current turn ends. Do not call again.")
				.done();
		}

		return toolResult<CompactToolDetails>(details)
			.text(
				"Compaction scheduled. It runs automatically when this turn ends — finish in-flight work and yield. Recent messages survive; older history is archived.",
			)
			.done();
	}
}
