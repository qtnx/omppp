/** Render workflow progress frames into a phase→agent tree. */
import type { Theme } from "../modes/theme/theme";
import { type RenderAgentProgressOptions, renderAgentProgress } from "../task/render";
import type { AgentProgress } from "../task/types";
import { replaceTabs, truncateToWidth } from "../tools/render-utils";
import type { WorkflowAgentState, WorkflowProgressFrame } from "./types";

type AgentFrame = Extract<WorkflowProgressFrame, { kind: "agent" }>;

export interface WorkflowRenderOptions {
	theme?: Theme;
	expanded?: boolean;
	spinnerFrame?: number;
}

const STATE_GLYPH: Record<WorkflowAgentState, string> = {
	start: "•",
	done: "✓",
	error: "✗",
	cached: "⤿",
};

const WORKFLOW_AGENT_PROGRESS_OPTIONS: RenderAgentProgressOptions = {
	showResolvedModelBadge: true,
	showAgentName: true,
};

function statusForFrame(frame: AgentFrame): AgentProgress["status"] {
	if (frame.state === "start") {
		if (frame.progress?.status === "pending") return "pending";
		return "running";
	}
	if (frame.state === "done" || frame.state === "cached") return "completed";
	return frame.progress?.status === "aborted" ? "aborted" : "failed";
}

function normalizeProgress(frame: AgentFrame): AgentProgress | undefined {
	const progress = frame.progress;
	if (!progress) return undefined;

	const status = statusForFrame(frame);
	const id = frame.agentId ?? progress.id;
	const description = progress.description ?? frame.label;
	const resolvedModel = progress.resolvedModel ?? frame.model;
	if (
		progress.status === status &&
		progress.id === id &&
		progress.description === description &&
		progress.resolvedModel === resolvedModel
	) {
		return progress;
	}
	return {
		...progress,
		status,
		id,
		description,
		resolvedModel,
	};
}

function formatActivitySummary(tool: string, detail: string | undefined): string {
	if (!detail) return tool;
	return `${tool}: ${truncateToWidth(replaceTabs(detail), 40)}`;
}

function latestActivity(progress: AgentProgress | undefined): string | undefined {
	if (!progress) return undefined;
	if (progress.currentTool) {
		return formatActivitySummary(progress.currentTool, progress.lastIntent ?? progress.currentToolArgs);
	}

	const recent = progress.recentTools[0];
	if (!recent) return undefined;
	return formatActivitySummary(recent.tool, progress.lastIntent ?? recent.args);
}

function renderFallbackAgent(frame: AgentFrame): string[] {
	const progress = normalizeProgress(frame);
	const glyph = STATE_GLYPH[frame.state] ?? "·";
	const label = progress?.description ?? frame.label;
	const model = progress?.resolvedModel ?? frame.model;
	const durationSuffix = frame.durationMs != null ? ` ${Math.round(frame.durationMs)}ms` : "";
	const tokenSuffix = frame.tokens != null ? ` ${frame.tokens}tok` : "";
	const errorSuffix = frame.error ? ` — ${replaceTabs(frame.error)}` : "";
	const modelSuffix = model ? ` · ${truncateToWidth(replaceTabs(model), 30)}` : "";
	const agentSuffix = progress?.agent ? ` · ${truncateToWidth(replaceTabs(progress.agent), 30)}` : "";
	const statusSuffix = progress ? ` · ${progress.status}` : "";
	const lines = [
		`  ${glyph} ${label}${statusSuffix}${modelSuffix}${agentSuffix}${durationSuffix}${tokenSuffix}${errorSuffix}`,
	];
	const latest = latestActivity(progress);
	if (latest) lines.push(`    └ ${latest}`);
	return lines;
}

function renderAgentFrame(frame: AgentFrame, isLast: boolean, options: WorkflowRenderOptions): string[] {
	const progress = normalizeProgress(frame);
	if (!progress || !options.theme) return renderFallbackAgent(frame);

	return renderAgentProgress(
		progress,
		isLast,
		options.expanded ?? false,
		options.theme,
		options.spinnerFrame,
		WORKFLOW_AGENT_PROGRESS_OPTIONS,
	).map(line => `  ${line}`);
}

function agentKey(frame: AgentFrame): string {
	return `${frame.runId}\0${frame.index}`;
}

export function renderWorkflowTree(frames: WorkflowProgressFrame[], options: WorkflowRenderOptions = {}): string {
	const phases = new Map<string, AgentFrame[]>();
	const order: string[] = [];
	const latestByIndex = new Map<string, AgentFrame>();
	const logs: string[] = [];

	for (const frame of frames) {
		if (frame.kind === "phase") {
			if (!phases.has(frame.title)) {
				phases.set(frame.title, []);
				order.push(frame.title);
			}
		} else if (frame.kind === "log") {
			logs.push(frame.message);
		} else {
			latestByIndex.set(agentKey(frame), frame);
		}
	}

	const noPhase = "(no phase)";
	for (const frame of latestByIndex.values()) {
		const key = frame.phaseTitle ?? noPhase;
		let agents = phases.get(key);
		if (!agents) {
			agents = [];
			phases.set(key, agents);
			order.push(key);
		}
		agents.push(frame);
	}

	const lines: string[] = [];
	for (const log of logs) lines.push(`» ${log}`);
	for (const title of order) {
		lines.push(`▸ ${title}`);
		const agents = phases.get(title);
		if (!agents) continue;
		for (const [index, frame] of agents.entries()) {
			lines.push(...renderAgentFrame(frame, index === agents.length - 1, options));
		}
	}
	return lines.length > 0 ? lines.join("\n") : "(no workflow activity yet)";
}
