import type { WorkflowProgressFrame } from "./types";

export interface WorkflowRunAgentEntry {
	id: string;
	label?: string;
	phase?: string;
	state: string;
	model?: string;
	tokensIn?: number;
	tokensOut?: number;
	durationMs?: number;
	sessionFile?: string;
	updatedAt: number;
}

export interface WorkflowRunPhaseEntry {
	title: string;
	startedAt: number;
}

export interface WorkflowRunLogEntry {
	phase?: string;
	message: string;
	at: number;
}

export interface WorkflowRunRecord {
	runId: string;
	name?: string;
	status: "running" | "completed" | "failed";
	startedAt: number;
	endedAt?: number;
	phases: WorkflowRunPhaseEntry[];
	logs: WorkflowRunLogEntry[];
	agents: WorkflowRunAgentEntry[];
	lastFrameAt: number;
}

export class WorkflowRunRegistry {
	#records = new Map<string, WorkflowRunRecord>();
	#ingestedFrames = new WeakSet<object>();
	#lastTimestamp = 0;

	ingest(frame: WorkflowProgressFrame): void {
		if (this.#ingestedFrames.has(frame)) return;
		this.#ingestedFrames.add(frame);

		const at = this.#nextTimestamp();
		const record = this.#recordFor(frame.runId, at);
		record.lastFrameAt = at;

		switch (frame.kind) {
			case "phase":
				record.phases.push({ title: frame.title, startedAt: at });
				return;
			case "log":
				record.logs.push({ phase: record.phases.at(-1)?.title, message: frame.message, at });
				return;
			case "agent":
				this.#ingestAgent(record, frame, at);
				return;
			case "done":
				record.status = frame.ok ? "completed" : "failed";
				record.endedAt = at;
		}
	}

	list(): WorkflowRunRecord[] {
		return Array.from(this.#records.values()).sort((left, right) => right.lastFrameAt - left.lastFrameAt);
	}

	get(runId: string): WorkflowRunRecord | undefined {
		return this.#records.get(runId);
	}

	clear(): void {
		this.#records.clear();
		this.#ingestedFrames = new WeakSet<object>();
	}

	#nextTimestamp(): number {
		this.#lastTimestamp = Math.max(Date.now(), this.#lastTimestamp + 1);
		return this.#lastTimestamp;
	}

	#recordFor(runId: string, at: number): WorkflowRunRecord {
		const existing = this.#records.get(runId);
		if (existing) return existing;

		const record: WorkflowRunRecord = {
			runId,
			status: "running",
			startedAt: at,
			phases: [],
			logs: [],
			agents: [],
			lastFrameAt: at,
		};
		this.#records.set(runId, record);
		return record;
	}

	#ingestAgent(record: WorkflowRunRecord, frame: Extract<WorkflowProgressFrame, { kind: "agent" }>, at: number): void {
		if (!frame.agentId) return;

		const progress = frame.progress;
		const current = record.agents.find(agent => agent.id === frame.agentId);
		const entry: WorkflowRunAgentEntry = {
			id: frame.agentId,
			label: frame.label,
			phase: frame.phaseTitle ?? record.phases.at(-1)?.title,
			state: frame.state,
			model: frame.model ?? current?.model,
			tokensIn: progress?.inputTokens ?? current?.tokensIn,
			tokensOut: progress?.outputTokens ?? frame.tokens ?? current?.tokensOut,
			durationMs: frame.durationMs ?? progress?.durationMs ?? current?.durationMs,
			sessionFile: frame.sessionFile ?? current?.sessionFile,
			updatedAt: at,
		};

		if (current) {
			Object.assign(current, entry);
			return;
		}
		record.agents.push(entry);
	}
}
