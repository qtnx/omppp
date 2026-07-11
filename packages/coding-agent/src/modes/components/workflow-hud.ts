import { stripVTControlCharacters } from "node:util";

import { Container } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { WorkflowRunAgentEntry, WorkflowRunRecord } from "../../workflow/run-registry";
import { theme } from "../theme/theme";

/** Keep the live HUD compact enough to leave room for the composer. */
export const WORKFLOW_HUD_VISIBLE_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

export interface WorkflowHudDeps {
	registry: { list(): WorkflowRunRecord[] };
}

/** Passive anchored HUD for workflow runs that are still receiving progress frames. */
export class WorkflowHudComponent extends Container {
	#registry: WorkflowHudDeps["registry"];

	constructor(deps: WorkflowHudDeps) {
		super();
		this.#registry = deps.registry;
	}

	override render(width: number): readonly string[] {
		const activeRuns = this.#registry.list().filter(run => run.status === "running" || run.status === "failed");
		if (activeRuns.length === 0) return [];

		const lines = ["", theme.bold(theme.fg("accent", "Workflows"))];
		let remaining = WORKFLOW_HUD_VISIBLE_LIMIT;
		for (const run of activeRuns) {
			if (remaining <= 0) break;
			lines.push(this.#line(this.#renderRun(run), width));
			remaining--;
			for (const agent of run.agents) {
				if (remaining <= 0) break;
				if (isTerminalAgentState(agent.state) && !isFailedAgent(agent)) continue;
				lines.push(this.#line(`  ${this.#renderAgent(agent)}`, width));
				remaining--;
			}
		}
		const hidden = countVisibleRows(activeRuns) - (WORKFLOW_HUD_VISIBLE_LIMIT - remaining);
		if (hidden > 0)
			lines.push(this.#line(theme.fg("dim", `  ... ${hidden} more active rows — open /workflows`), width));
		return lines;
	}

	#renderRun(run: WorkflowRunRecord): string {
		const phase = run.phases.at(-1)?.title;
		const label = this.#sanitize(run.name || shortRunId(run.runId), TRUNCATE_LENGTHS.SHORT);
		const failed = run.status === "failed";
		const details = [
			theme.styledSymbol(failed ? "status.error" : "status.running", failed ? "error" : "accent"),
			theme.fg(failed ? "error" : "accent", theme.bold(label)),
			phase ? theme.fg("muted", `phase: ${this.#sanitize(phase, TRUNCATE_LENGTHS.SHORT)}`) : undefined,
			theme.fg("dim", formatDuration(Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt))),
		].filter((part): part is string => part !== undefined);
		return details.join(theme.sep.dot);
	}

	#renderAgent(agent: WorkflowRunAgentEntry): string {
		const error = agent.error
			? stripVTControlCharacters(agent.error).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
			: undefined;
		const details = [
			this.#agentStatus(agent.state),
			theme.bold(this.#sanitize(agent.label || agent.id, TRUNCATE_LENGTHS.SHORT)),
			agent.model ? theme.fg("dim", this.#sanitize(agent.model, TRUNCATE_LENGTHS.SHORT)) : undefined,
			agent.tokensIn === undefined && agent.tokensOut === undefined
				? undefined
				: theme.fg("dim", `in ${formatNumber(agent.tokensIn ?? 0)} / out ${formatNumber(agent.tokensOut ?? 0)}`),
			agent.durationMs === undefined ? undefined : theme.fg("dim", formatDuration(agent.durationMs)),
			error ? theme.fg("error", `Error: ${this.#sanitize(error, TRUNCATE_LENGTHS.SHORT)}`) : undefined,
		].filter((part): part is string => part !== undefined);
		return details.join(theme.sep.dot);
	}

	#agentStatus(state: string): string {
		const safeState = this.#sanitize(state, TRUNCATE_LENGTHS.SHORT);
		if (state === "error" || state === "failed") return theme.fg("error", `${theme.status.error} ${safeState}`);
		if (state === "done" || state === "cached" || state === "completed")
			return theme.fg("success", `${theme.status.done} ${safeState}`);
		return theme.fg("accent", `${theme.status.running} ${safeState}`);
	}

	#line(text: string, width: number): string {
		return truncateToWidth(replaceTabs(text).replace(/[\r\n]+/g, " "), Math.max(1, width - 1));
	}
	#sanitize(text: string, maxWidth: number): string {
		return truncateToWidth(replaceTabs(text).replace(/[\r\n]+/g, " "), maxWidth);
	}
}

function shortRunId(runId: string): string {
	return runId.length > 12 ? `${runId.slice(0, 12)}...` : runId;
}

function isTerminalAgentState(state: string): boolean {
	return state === "done" || state === "error" || state === "cached" || state === "completed" || state === "failed";
}

function isFailedAgent(agent: WorkflowRunAgentEntry): boolean {
	return agent.state === "error" || agent.state === "failed";
}

function countVisibleRows(runs: WorkflowRunRecord[]): number {
	return runs.reduce(
		(count, run) =>
			count + 1 + run.agents.filter(agent => !isTerminalAgentState(agent.state) || isFailedAgent(agent)).length,
		0,
	);
}
