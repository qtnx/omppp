/**
 * WorkflowRun — orchestrates one execution of a workflow script. Every agent()
 * funnels through spawn(): caps → journal cache → semaphore → allocate id →
 * runSubprocess → token accounting → progress frames. parallel()/pipeline() build
 * on spawn() and inherit its concurrency/agent caps.
 */
import * as os from "node:os";
import type { ExecutorOptions } from "../task/executor";
import { Semaphore } from "../task/parallel";
import type { AgentDefinition, SingleResult } from "../task/types";
import { computeCacheKey, type WorkflowJournal } from "./journal";
import { MAX_WORKFLOW_AGENTS, type WorkflowAgentOpts, type WorkflowProgressFrame } from "./types";

/** Concurrent agent() cap per workflow: min(16, cores-2), floored at 2. */
export function workflowConcurrency(): number {
	return Math.min(16, Math.max(2, os.cpus().length - 2));
}

export interface WorkflowRunBudget {
	total: number | null;
	spent(): number;
	remaining(): number;
}

export interface WorkflowRunOptions {
	runId: string;
	cwd: string;
	concurrency: number;
	budgetTotal: number | null;
	signal: AbortSignal;
	allocateId: (label: string) => Promise<string>;
	emit: (frame: WorkflowProgressFrame) => void;
	resolveAgent: (agentType: string | undefined) => AgentDefinition;
	/** Build per-spawn executor options and run the subagent. Injected for testability. */
	runSubprocess: (options: ExecutorOptions) => Promise<SingleResult>;
	/** Optional journal enabling cached-prefix resume. */
	journal?: WorkflowJournal;
}

export class WorkflowAgentCapError extends Error {
	constructor() {
		super(
			`Workflow agent() call cap reached (${MAX_WORKFLOW_AGENTS}). This usually means a budget.remaining() loop never terminates (remaining() is Infinity with no budget). Add a hard iteration cap or set a budget.`,
		);
		this.name = "WorkflowAgentCapError";
	}
}
export class WorkflowBudgetError extends Error {
	constructor(spent: number, total: number) {
		super(`Workflow token budget exhausted: spent ${spent} >= budget ${total}. Further agent() calls are blocked.`);
		this.name = "WorkflowBudgetError";
	}
}

export class WorkflowRun {
	readonly runId: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly budget: WorkflowRunBudget;
	#agentCount = 0;
	#spawnIndex = 0;
	#phaseIndex = 0;
	#currentPhase: string | undefined;
	#tokensSpent = 0;
	#prevKey = "";
	readonly #semaphore: Semaphore;
	readonly #opts: WorkflowRunOptions;

	constructor(opts: WorkflowRunOptions) {
		this.#opts = opts;
		this.runId = opts.runId;
		this.cwd = opts.cwd;
		this.signal = opts.signal;
		this.#semaphore = new Semaphore(opts.concurrency);
		this.budget = {
			total: opts.budgetTotal,
			spent: () => this.#tokensSpent,
			remaining: () =>
				opts.budgetTotal == null ? Number.POSITIVE_INFINITY : Math.max(0, opts.budgetTotal - this.#tokensSpent),
		};
	}

	/** Test-only: pre-set the agent counter to exercise the cap. */
	forceAgentCountForTest(n: number): void {
		this.#agentCount = n;
	}

	nextPhase(title: string): void {
		this.#currentPhase = title;
		this.#phaseIndex += 1;
		this.#opts.emit({ kind: "phase", runId: this.runId, index: this.#phaseIndex, title });
	}

	log(message: string): void {
		this.#opts.emit({ kind: "log", runId: this.runId, message });
	}

	#checkCaps(): void {
		if (this.#agentCount >= MAX_WORKFLOW_AGENTS) throw new WorkflowAgentCapError();
		if (this.budget.total != null && this.#tokensSpent >= this.budget.total) {
			throw new WorkflowBudgetError(this.#tokensSpent, this.budget.total);
		}
	}

	#labelFor(prompt: string, opts: WorkflowAgentOpts): string {
		return (opts.label ?? prompt.slice(0, 60)).replace(/\s+/g, " ").trim() || "agent";
	}

	async spawn(prompt: string, opts: WorkflowAgentOpts): Promise<string | null> {
		if (this.signal.aborted) return null;
		const iso = opts.isolation as string | undefined;
		if (iso) {
			throw new Error(
				`agent({isolation:'${iso}'}) is not yet supported in omp workflows. Omit isolation to run in the shared workspace.`,
			);
		}
		this.#checkCaps();

		const label = this.#labelFor(prompt, opts);
		const phaseTitle = opts.phase ?? this.#currentPhase;

		// Journal cache: chained key over (prompt, opts, prevKey). A hit returns instantly.
		const cacheKey = this.#opts.journal ? computeCacheKey(prompt, opts, this.#prevKey) : "";
		if (this.#opts.journal) this.#prevKey = cacheKey;
		const cached = this.#opts.journal?.lookup(cacheKey);
		if (cached) {
			const idx = ++this.#spawnIndex;
			this.#agentCount += 1;
			this.#opts.emit({
				kind: "agent",
				runId: this.runId,
				index: idx,
				label,
				phaseTitle,
				state: "cached",
				agentId: cached.agentId,
			});
			return cached.result;
		}

		const index = ++this.#spawnIndex;
		this.#agentCount += 1;

		await this.#semaphore.acquire();
		if (this.signal.aborted) {
			this.#semaphore.release();
			return null;
		}
		const agentId = await this.#opts.allocateId(label);
		const startedAt = Date.now();
		const agent = this.#opts.resolveAgent(opts.agentType);
		this.#opts.emit({
			kind: "agent",
			runId: this.runId,
			index,
			label,
			phaseTitle,
			state: "start",
			agentId,
			model: opts.model,
		});

		try {
			const result = await this.#opts.runSubprocess({
				cwd: this.cwd,
				agent,
				task: prompt,
				index,
				id: agentId,
				modelOverride: opts.model,
				outputSchema: opts.schema,
				signal: this.signal,
			});

			const tokens = result.usage?.output ?? 0;
			this.#tokensSpent += tokens;
			if (result.aborted) {
				this.#opts.emit({
					kind: "agent",
					runId: this.runId,
					index,
					label,
					phaseTitle,
					state: "error",
					agentId,
					error: "aborted",
					durationMs: Date.now() - startedAt,
				});
				return null;
			}
			if (this.#opts.journal && typeof result.output === "string") {
				await this.#opts.journal.recordResult(cacheKey, agentId, result.output);
			}
			this.#opts.emit({
				kind: "agent",
				runId: this.runId,
				index,
				label,
				phaseTitle,
				state: "done",
				agentId,
				tokens,
				durationMs: Date.now() - startedAt,
			});
			return result.output;
		} catch (error) {
			this.#opts.emit({
				kind: "agent",
				runId: this.runId,
				index,
				label,
				phaseTitle,
				state: "error",
				agentId,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startedAt,
			});
			throw error;
		} finally {
			this.#semaphore.release();
		}
	}
}
