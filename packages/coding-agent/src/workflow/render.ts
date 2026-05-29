/** Render a flat list of workflow progress frames into a phase→agent tree (plain text). */
import type { WorkflowProgressFrame } from "./types";

const STATE_GLYPH: Record<string, string> = {
	start: "•",
	done: "✓",
	error: "✗",
	cached: "⤿",
};

export function renderWorkflowTree(frames: WorkflowProgressFrame[]): string {
	const phases = new Map<string, string[]>();
	const order: string[] = [];
	const latestByIndex = new Map<number, Extract<WorkflowProgressFrame, { kind: "agent" }>>();
	const logs: string[] = [];

	for (const f of frames) {
		if (f.kind === "phase") {
			if (!phases.has(f.title)) {
				phases.set(f.title, []);
				order.push(f.title);
			}
		} else if (f.kind === "log") {
			logs.push(f.message);
		} else {
			latestByIndex.set(f.index, f); // last state wins (start → done/error/cached)
		}
	}

	const noPhase = "(no phase)";
	for (const f of latestByIndex.values()) {
		const key = f.phaseTitle ?? noPhase;
		if (!phases.has(key)) {
			phases.set(key, []);
			order.push(key);
		}
		const glyph = STATE_GLYPH[f.state] ?? "·";
		const dur = f.durationMs != null ? ` ${Math.round(f.durationMs)}ms` : "";
		const tok = f.tokens != null ? ` ${f.tokens}tok` : "";
		const err = f.error ? ` — ${f.error}` : "";
		phases.get(key)?.push(`  ${glyph} ${f.label}${dur}${tok}${err}`);
	}

	const lines: string[] = [];
	for (const log of logs) lines.push(`» ${log}`);
	for (const title of order) {
		lines.push(`▸ ${title}`);
		lines.push(...(phases.get(title) ?? []));
	}
	return lines.length > 0 ? lines.join("\n") : "(no workflow activity yet)";
}
