import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import shakeDescription from "../prompts/tools/shake.md" with { type: "text" };
import type { ShakeMode } from "../session/shake-types";
import { renderStatusLine } from "../tui";
import type { ToolSession, ToolShakeRequest } from ".";
import type { OutputMeta } from "./output-meta";
import { Ellipsis, formatErrorMessage, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const shakeSchema = z.object({
	mode: z.enum(["elide", "images"]).optional().describe("shake mode to run; defaults to elide"),
	reason: z.string().min(1).max(500).describe("why shake is appropriate now — the phase or task transition"),
});

type ShakeParams = z.infer<typeof shakeSchema>;

export interface ShakeToolDetails {
	mode: ShakeMode;
	reason: string;
	status: "scheduled" | "already-scheduled";
	meta?: OutputMeta;
}

export class ShakeTool implements AgentTool<typeof shakeSchema, ShakeToolDetails> {
	readonly name = "shake";
	readonly approval = "read" as const;
	readonly label = "Shake";
	readonly summary = "Shed stale bulky context after the current turn ends";
	readonly description: string;
	readonly parameters = shakeSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<ShakeParams>) => (args.reason ? `shaking: ${args.reason}` : "shaking");

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(shakeDescription);
	}

	static createIf(session: ToolSession): ShakeTool | null {
		if (session.requestShake === undefined) return null;
		return new ShakeTool(session);
	}

	async execute(
		_toolCallId: string,
		params: ShakeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ShakeToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ShakeToolDetails>> {
		const requestShake = this.session.requestShake;
		if (requestShake === undefined) {
			throw new ToolError("Shake is not available in this session.");
		}

		const mode = params.mode ?? "elide";
		const result: ToolShakeRequest = requestShake(mode);
		if (result.status === "unavailable") {
			throw new ToolError(`Cannot shake: ${result.detail}`);
		}

		const details: ShakeToolDetails = { mode, reason: params.reason, status: result.status };
		if (result.status === "already-scheduled") {
			return toolResult<ShakeToolDetails>(details)
				.text("Shake already scheduled — it runs when the current turn ends. Do not call again.")
				.done();
		}

		return toolResult<ShakeToolDetails>(details)
			.text(
				"Shake scheduled. It runs automatically when this turn ends — finish in-flight work and yield. Older bulky tool results and large blocks may be replaced with artifact recovery links; images mode drops images.",
			)
			.done();
	}
}

interface ShakeRenderArgs {
	mode?: ShakeMode;
	reason?: string;
}

export const shakeToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: ShakeRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const trimmedReason = replaceTabs((args.reason ?? "").trim());
		const description = trimmedReason
			? truncateToWidth(trimmedReason, TRUNCATE_LENGTHS.CONTENT, Ellipsis.Unicode)
			: undefined;
		return new Text(
			renderStatusLine({ icon: "pending", title: "Shake", titleColor: "toolTitle", description }, theme),
			0,
			0,
		);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ShakeToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		theme: Theme,
		args?: ShakeRenderArgs,
	): Component {
		if (result.isError) {
			const text = (result.content?.find(c => c.type === "text")?.text ?? "").trim();
			return new Text(formatErrorMessage(text || "Shake failed", theme), 0, 0);
		}
		const trimmedReason = replaceTabs((result.details?.reason ?? args?.reason ?? "").trim());
		const description = trimmedReason
			? truncateToWidth(trimmedReason, TRUNCATE_LENGTHS.CONTENT, Ellipsis.Unicode)
			: undefined;
		const status = result.details?.status;
		const mode = result.details?.mode ?? args?.mode ?? "elide";
		const meta = status === "already-scheduled" ? [mode, "already scheduled"] : [mode, "scheduled"];
		return new Text(
			renderStatusLine(
				{
					icon: status === "already-scheduled" ? "warning" : "success",
					title: "Shake",
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
