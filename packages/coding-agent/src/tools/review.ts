/**
 * Fork-only `report_finding` tool: reviewers report each blocking issue as they
 * inspect the diff, and the subprocess tool registry renders the collected
 * findings on the reviewer's transcript.
 *
 * The shared finding shapes and priority helpers now live in
 * `@oh-my-pi/pi-tui/tools/task` (TUI decoupling); they are re-exported here so
 * existing `../tools/review` consumers keep their import path.
 */
// ─────────────────────────────────────────────────────────────────────────────

import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme";
import {
	type FindingDetails,
	type FindingPriority,
	getPriorityInfo,
	parseFindingDetails,
} from "@oh-my-pi/pi-tui/tools/task";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ReviewFinding } from "../task/types";

export {
	type FindingDetails,
	type FindingPriority,
	type FindingPriorityInfo,
	getPriorityInfo,
	isFindingPriority,
	PRIORITY_LABELS,
	parseFindingDetails,
	type SubmitReviewDetails,
} from "@oh-my-pi/pi-tui/tools/task";

/** Validated finding payload reported by the reviewer subagent. */
export type ReportFindingDetails = FindingDetails;

/** Legacy parser name retained for the subprocess tool registry. */
export const parseReportFindingDetails = parseFindingDetails;

function getPriorityDisplay(
	priority: FindingPriority,
	theme: Theme,
): { label: string; icon: string; color: ThemeColor } {
	const meta = getPriorityInfo(priority);
	return { label: priority, icon: theme.styledSymbol(meta.symbol, meta.color), color: meta.color };
}

const reportFindingParams = type({
	title: type("string").describe("prefixed imperative title"),
	body: type("string").describe("problem explanation"),
	priority: type("'P0' | 'P1' | 'P2' | 'P3'").describe("priority 0-3"),
	confidence: type("number >= 0 & number <= 1").describe("confidence score"),
	file_path: type("string").describe("file path"),
	line_start: type("number").describe("start line"),
	line_end: type("number").describe("end line"),
});

export function toReviewFinding(details: ReportFindingDetails): ReviewFinding {
	return {
		title: details.title,
		body: details.body,
		priority: getPriorityInfo(details.priority).ord,
		confidence: details.confidence,
		file_path: details.file_path,
		line_start: details.line_start,
		line_end: details.line_end,
	};
}

export const reportFindingTool: AgentTool<typeof reportFindingParams, ReportFindingDetails, Theme> = {
	name: "report_finding",
	label: "Report Finding",
	approval: "read",
	description: "Report a code review finding. Use this for each issue found. Call yield when done.",
	parameters: reportFindingParams,
	intent: "omit",
	async execute(_toolCallId, params) {
		const { title, body, priority, confidence, file_path, line_start, line_end } = params;
		const location = `${file_path}:${line_start}${line_end !== line_start ? `-${line_end}` : ""}`;
		return {
			content: [
				{
					type: "text",
					text: `Finding recorded: ${priority} ${title}\nLocation: ${location}\nConfidence: ${(confidence * 100).toFixed(0)}%`,
				},
			],
			details: { title, body, priority, confidence, file_path, line_start, line_end },
		};
	},
	renderCall(args, _options, theme): Component {
		const { label, icon, color } = getPriorityDisplay(args.priority, theme);
		const title = String(args.title).replace(/^\[P\d\]\s*/, "");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("report_finding "))}${icon} ${theme.fg(color, `[${label}]`)} ${theme.fg("dim", title)}`,
			0,
			0,
		);
	},
	renderResult(result, _options, theme): Component {
		const details = result.details;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}
		const { label, icon, color } = getPriorityDisplay(details.priority, theme);
		const location = `${details.file_path}:${details.line_start}${details.line_end !== details.line_start ? `-${details.line_end}` : ""}`;
		return new Text(
			`${theme.styledSymbol("tool.review", "accent")} ${icon} ${theme.fg(color, `[${label}]`)} ${theme.fg("dim", location)}`,
			0,
			0,
		);
	},
};

subprocessToolRegistry.register<ReportFindingDetails>("report_finding", {
	extractData: event => {
		if (event.isError) return undefined;
		return parseReportFindingDetails(event.result?.details);
	},
	renderInline: (data, theme) => {
		const { label, icon, color } = getPriorityDisplay(data.priority, theme);
		const title = data.title.replace(/^\[P\d\]\s*/, "");
		return new Text(
			`${icon} ${theme.fg(color, `[${label}]`)} ${title} ${theme.fg("dim", `${path.basename(data.file_path)}:${data.line_start}`)}`,
			0,
			0,
		);
	},
	renderFinal: (allData, theme, expanded) => {
		const container = new Container();
		const displayCount = expanded ? allData.length : Math.min(3, allData.length);
		for (const data of allData.slice(0, displayCount)) {
			const { label, icon, color } = getPriorityDisplay(data.priority, theme);
			const title = data.title.replace(/^\[P\d\]\s*/, "");
			container.addChild(
				new Text(
					`  ${icon} ${theme.fg(color, `[${label}]`)} ${title} ${theme.fg("dim", `${path.basename(data.file_path)}:${data.line_start}`)}`,
					0,
					0,
				),
			);
			if (expanded && data.body) container.addChild(new Text(`    ${theme.fg("dim", data.body)}`, 0, 0));
		}
		if (allData.length > displayCount) {
			container.addChild(new Text(theme.fg("dim", `  … ${allData.length - displayCount} more findings`), 0, 0));
		}
		return container;
	},
});
