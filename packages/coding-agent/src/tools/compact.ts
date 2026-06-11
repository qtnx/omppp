import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import compactDescription from "../prompts/tools/compact.md" with { type: "text" };
import { renderStatusLine } from "../tui";
import type { ToolCompactionRequest, ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { Ellipsis, formatErrorMessage, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const compactSchema = z.object({
	reason: z.string().min(1).max(500).describe("why compaction is appropriate now — the boundary just reached"),
});

type CompactParams = z.infer<typeof compactSchema>;

export interface CompactToolDetails {
	reason: string;
	status: "scheduled" | "already-scheduled";
	meta?: OutputMeta;
}

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
		if (session.settings.get("compaction.strategy") === "off") return null;
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

		const result: ToolCompactionRequest = requestCompaction(params.reason);
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

interface CompactRenderArgs {
	reason?: string;
}

export const compactToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: CompactRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const trimmedReason = replaceTabs((args.reason ?? "").trim());
		const description = trimmedReason
			? truncateToWidth(trimmedReason, TRUNCATE_LENGTHS.CONTENT, Ellipsis.Unicode)
			: undefined;
		return new Text(
			renderStatusLine({ icon: "pending", title: "Compact", titleColor: "toolTitle", description }, theme),
			0,
			0,
		);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: CompactToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		theme: Theme,
		args?: CompactRenderArgs,
	): Component {
		if (result.isError) {
			const text = (result.content?.find(c => c.type === "text")?.text ?? "").trim();
			return new Text(formatErrorMessage(text || "Compaction failed", theme), 0, 0);
		}
		const trimmedReason = replaceTabs((result.details?.reason ?? args?.reason ?? "").trim());
		const description = trimmedReason
			? truncateToWidth(trimmedReason, TRUNCATE_LENGTHS.CONTENT, Ellipsis.Unicode)
			: undefined;
		const status = result.details?.status;
		const meta = status === "already-scheduled" ? ["already scheduled"] : ["scheduled"];
		return new Text(
			renderStatusLine(
				{
					icon: status === "already-scheduled" ? "warning" : "success",
					title: "Compact",
					titleColor: "toolTitle",
					description,
					meta,
				},
				theme,
			),
			0,
			0,
		);
	},
};
