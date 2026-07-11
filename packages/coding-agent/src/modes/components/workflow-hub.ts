import { Container, matchesKey } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { WorkflowRunAgentEntry, WorkflowRunRecord } from "../../workflow/run-registry";
import type { Theme, ThemeColor } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";

const AGE_TICK_MS = 5_000;

interface WorkflowHubRow {
	kind: "run" | "phase" | "agent";
	run: WorkflowRunRecord;
	agent?: WorkflowRunAgentEntry;
	phase?: string;
}

export interface WorkflowHubDeps {
	registry: { list(): WorkflowRunRecord[]; get(id: string): WorkflowRunRecord | undefined };
	openTranscript: (agentId: string, sessionFile?: string) => void;
	close: () => void;
	theme: Theme;
	requestRender?: () => void;
}

/** In-session workflow run browser with transcript drill-through for agent rows. */
export class WorkflowHubOverlayComponent extends Container {
	#registry: WorkflowHubDeps["registry"];
	#openTranscript: (agentId: string, sessionFile?: string) => void;
	#close: () => void;
	#theme: Theme;
	#requestRender: () => void;
	#rows: WorkflowHubRow[] = [];
	#selectedRow = 0;
	#ageTimer: NodeJS.Timeout;
	#selectedAgentId: string | undefined;
	#disposed = false;

	constructor(deps: WorkflowHubDeps) {
		super();
		this.#registry = deps.registry;
		this.#openTranscript = deps.openTranscript;
		this.#close = deps.close;
		this.#theme = deps.theme;
		this.#requestRender = deps.requestRender ?? (() => {});
		this.#refreshRows();
		this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
		this.#ageTimer.unref?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#ageTimer);
		super.dispose();
	}

	refresh(): void {
		this.#refreshRows();
		this.#requestRender();
	}

	override render(width: number): readonly string[] {
		return this.#renderTable(width).map(line =>
			truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width - 2)),
		);
	}

	handleInput(keyData: string): void {
		if (this.#disposed) return;
		if (matchesKey(keyData, "escape")) {
			this.#close();
			return;
		}
		if (keyData === "r") {
			this.refresh();
			return;
		}
		if (matchesKey(keyData, "left")) {
			this.#close();
			return;
		}
		if (keyData === "j" || matchesSelectDown(keyData)) {
			this.#moveSelection(1);
			return;
		}
		if (keyData === "k" || matchesSelectUp(keyData)) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			const agent = this.#rows[this.#selectedRow]?.agent;
			if (agent) this.#openTranscript(agent.id, agent.sessionFile);
		}
	}

	#refreshRows(): void {
		const selectedAgentId = this.#selectedAgentId ?? this.#rows[this.#selectedRow]?.agent?.id;
		const rows: WorkflowHubRow[] = [];
		for (const run of this.#registry.list()) {
			rows.push({ kind: "run", run });
			for (const phase of run.phases) rows.push({ kind: "phase", run, phase: phase.title });
			for (const agent of run.agents) rows.push({ kind: "agent", run, agent });
		}
		this.#rows = rows;
		const keptIndex = selectedAgentId ? rows.findIndex(row => row.agent?.id === selectedAgentId) : -1;
		this.#selectedRow =
			keptIndex >= 0
				? keptIndex
				: Math.max(
						0,
						this.#rows.findIndex(row => row.kind === "agent"),
					);
		const selectedAgent = this.#rows[this.#selectedRow]?.agent;
		if (selectedAgent) this.#selectedAgentId = selectedAgent.id;
	}

	#moveSelection(direction: 1 | -1): void {
		const agentIndexes = this.#rows.flatMap((row, index) => (row.kind === "agent" ? [index] : []));
		if (agentIndexes.length === 0) return;
		const currentIndex = agentIndexes.indexOf(this.#selectedRow);
		const nextIndex = Math.min(
			Math.max((currentIndex < 0 ? 0 : currentIndex) + direction, 0),
			agentIndexes.length - 1,
		);
		this.#selectedRow = agentIndexes[nextIndex];
		this.#selectedAgentId = this.#rows[this.#selectedRow]?.agent?.id;
		this.#requestRender();
	}

	#renderTable(width: number): string[] {
		const lines = [this.#border(width), ` ${this.#theme.fg("accent", "Workflow Hub")}`, this.#border(width)];
		if (this.#rows.length === 0) {
			lines.push(` ${this.#theme.fg("dim", "No workflow runs in this session.")}`);
		} else {
			const maxVisible = Math.max(3, (process.stdout.rows || 40) - 7);
			const { start, end } = this.#viewport(maxVisible);
			for (let index = start; index < end; index++)
				lines.push(this.#renderRow(this.#rows[index], index === this.#selectedRow, width));
			if (start > 0) lines.splice(3, 0, ` ${this.#theme.fg("dim", `... ${start} above`)}`);
			if (end < this.#rows.length) lines.push(` ${this.#theme.fg("dim", `... ${this.#rows.length - end} more`)}`);
		}
		lines.push(
			"",
			` ${this.#theme.fg("dim", "↑/↓ j/k:select  Enter:open  ←:back  r:refresh  Esc:close")}`,
			this.#border(width),
		);
		return lines;
	}

	#viewport(maxVisible: number): { start: number; end: number } {
		if (this.#rows.length <= maxVisible) return { start: 0, end: this.#rows.length };
		const start = Math.min(
			Math.max(0, this.#selectedRow - Math.floor(maxVisible / 2)),
			this.#rows.length - maxVisible,
		);
		return { start, end: start + maxVisible };
	}

	#renderRow(row: WorkflowHubRow, selected: boolean, width: number): string {
		const cursor = selected ? this.#theme.fg("accent", this.#theme.nav.cursor) : " ";
		switch (row.kind) {
			case "run":
				return this.#line(
					`${this.#runStatus(row.run.status)} ${this.#theme.bold(this.#sanitize(row.run.name || row.run.runId, TRUNCATE_LENGTHS.TITLE))} ${this.#dim(formatDuration(Math.max(0, (row.run.endedAt ?? Date.now()) - row.run.startedAt)))}`,
					width,
				);
			case "phase":
				return this.#line(
					`    ${this.#theme.fg("muted", `phase: ${this.#sanitize(row.phase ?? "", TRUNCATE_LENGTHS.TITLE)}`)}`,
					width,
				);
			case "agent":
				return this.#line(
					` ${cursor}   ${this.#agentStatus(row.agent!.state)} ${this.#displayAgent(row.agent!)}`,
					width,
				);
		}
	}

	#displayAgent(agent: WorkflowRunAgentEntry): string {
		const details = [
			this.#theme.bold(this.#sanitize(agent.label || agent.id, TRUNCATE_LENGTHS.TITLE)),
			agent.model ? this.#dim(this.#sanitize(agent.model, TRUNCATE_LENGTHS.SHORT)) : undefined,
			agent.tokensIn === undefined && agent.tokensOut === undefined
				? undefined
				: this.#dim(`in ${formatNumber(agent.tokensIn ?? 0)} / out ${formatNumber(agent.tokensOut ?? 0)}`),
			agent.durationMs === undefined ? undefined : this.#dim(formatDuration(agent.durationMs)),
		].filter((part): part is string => part !== undefined);
		return details.join(this.#theme.sep.dot);
	}

	#runStatus(status: WorkflowRunRecord["status"]): string {
		switch (status) {
			case "running":
				return this.#coloredStatus("accent", `${this.#theme.status.running} running`);
			case "completed":
				return this.#coloredStatus("success", `${this.#theme.status.done} completed`);
			case "failed":
				return this.#coloredStatus("error", `${this.#theme.status.error} failed`);
		}
	}

	#agentStatus(state: string): string {
		const safeState = this.#sanitize(state, TRUNCATE_LENGTHS.SHORT);
		if (state === "start" || state === "running")
			return this.#coloredStatus("accent", `${this.#theme.status.running} ${safeState}`);
		if (state === "done" || state === "cached" || state === "completed")
			return this.#coloredStatus("success", `${this.#theme.status.done} ${safeState}`);
		if (state === "error" || state === "failed")
			return this.#coloredStatus("error", `${this.#theme.status.error} ${safeState}`);
		return this.#coloredStatus("muted", `${this.#theme.status.shadowed} ${safeState}`);
	}

	#coloredStatus(color: ThemeColor, text: string): string {
		return this.#theme.fg(color, text);
	}

	#dim(text: string): string {
		return this.#theme.fg("dim", text);
	}

	#line(text: string, width: number): string {
		return truncateToWidth(replaceTabs(text).replace(/[\r\n]+/g, " "), Math.max(1, width - 1));
	}

	#sanitize(text: string, maxWidth: number): string {
		return truncateToWidth(replaceTabs(text).replace(/[\r\n]+/g, " "), maxWidth);
	}

	#border(width: number): string {
		return this.#theme.fg("border", this.#theme.boxRound.horizontal.repeat(Math.max(1, width)));
	}
}
