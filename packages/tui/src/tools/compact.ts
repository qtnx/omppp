/**
 * Tool renderer for the agent-requestable `compact` tool: the model schedules
 * context compaction at the next turn boundary, and the transcript shows the
 * scheduled boundary inline.
 */
import type { Component } from "../tui";
import { Text } from "../components/text";
import { Ellipsis, formatErrorMessage, replaceTabs, TRUNCATE_LENGTHS } from "../render/render-utils";
import { renderStatusLine, truncateToWidth } from "../render/index";
import type { Theme } from "../theme/theme";
import type { OutputMeta } from "./output-meta";
import type { RenderResultOptions, ToolRenderResult, ToolRenderer } from "./renderer";

/** Details carried by a `compact` tool result. */
export interface CompactToolDetails {
	reason: string;
	status: "scheduled" | "already-scheduled";
	meta?: OutputMeta;
}

interface CompactRenderArgs {
	reason?: string;
}

/** Renders the `compact` call and its scheduled/already-scheduled result. */
export const compactToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: CompactRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const trimmedReason = replaceTabs((args.reason ?? "").trim());
		const description = trimmedReason
			? truncateToWidth(trimmedReason, TRUNCATE_LENGTHS.CONTENT, Ellipsis.Unicode)
			: undefined;
		return new Text(
			renderStatusLine({ icon: "pending", title: "Compact", titleColor: "toolTitle", description }, uiTheme),
			0,
			0,
		);
	},
	renderResult(
		result: ToolRenderResult<CompactToolDetails>,
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: CompactRenderArgs,
	): Component {
		if (result.isError) {
			const text = (result.content?.find(c => c.type === "text")?.text ?? "").trim();
			return new Text(formatErrorMessage(text || "Compaction failed", uiTheme), 0, 0);
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
				uiTheme,
			),
			0,
			0,
		);
	},
} satisfies ToolRenderer<CompactRenderArgs, CompactToolDetails>;
