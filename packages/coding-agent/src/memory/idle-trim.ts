import { logger } from "@oh-my-pi/pi-utils";
import { type AgentRef, MAIN_AGENT_ID } from "../registry/agent-registry";

export interface IdleTrimDeps {
	readonly config: {
		enabled(): boolean;
		idleSeconds(): number;
		trimMcp(): boolean;
	};
	readonly lifecycle: { parkAll(): Promise<void> };
	readonly mcp: { sleepAll(): Promise<void> } | null;
	readonly workers: { terminateAll(): Promise<void> };
	readonly caches: { clear(): void };
	readonly statusLine: { setHookStatus(key: string, text: string | undefined): void } | null;
	readonly isActive: () => boolean;
	readonly now?: () => number;
}

const MIN_IDLE_SECONDS = 60;
const MAX_IDLE_SECONDS = 3_600;

/**
 * True when any agent other than Main has a turn in flight. Main is registered
 * `running` for its whole lifetime and never flips to `idle` on agent_end
 * (sdk.ts registration), so counting it would suppress the trim forever —
 * main-session activity is already covered by isStreaming/isCompacting.
 * Subagent and advisor runs DO count: trimming under a live turn would park
 * or dispose state that turn is using.
 */
export function hasRunningAgents(refs: readonly AgentRef[]): boolean {
	return refs.some(ref => ref.id !== MAIN_AGENT_ID && ref.status === "running");
}

export class IdleMemoryTrim {
	#timer: NodeJS.Timeout | undefined;
	#generation = 0;
	#disposed = false;
	#trimming = false;
	#deps: IdleTrimDeps;

	constructor(deps: IdleTrimDeps) {
		this.#deps = deps;
	}

	notifyActivityEnd(): void {
		if (this.#disposed) return;
		this.#clearTimer();
		if (!this.#deps.config.enabled()) return;

		const idleSeconds = Math.max(MIN_IDLE_SECONDS, Math.min(MAX_IDLE_SECONDS, this.#deps.config.idleSeconds()));
		const generation = this.#generation;
		let timer: NodeJS.Timeout;
		timer = setTimeout(() => {
			void this.#trimFromTimer(timer, generation);
		}, idleSeconds * 1_000);
		this.#timer = timer;
		timer.unref?.();
	}

	notifyActivityStart(): void {
		this.#cancelForActivity();
	}

	async trimNow(): Promise<void> {
		const generation = this.#generation;
		this.#clearTimer();
		await this.#trim(generation);
	}

	dispose(): void {
		this.#disposed = true;
		this.#cancelForActivity();
	}

	async #trimFromTimer(timer: NodeJS.Timeout, generation: number): Promise<void> {
		if (this.#timer !== timer) return;
		await this.#trim(generation, timer);
	}

	async #trim(generation: number, expectedTimer?: NodeJS.Timeout): Promise<void> {
		if (this.#trimming || !this.#canContinue(generation, expectedTimer)) return;
		this.#trimming = true;
		try {
			if (expectedTimer) this.#timer = undefined;

			const rssBefore = process.memoryUsage().rss;
			let completedSteps = 0;
			let parked = false;
			let mcpSlept = false;
			let workers = false;
			let cachesCleared = false;

			parked = await this.#runStep("park subagents", () => this.#deps.lifecycle.parkAll());
			if (parked) completedSteps++;
			if (!this.#canContinue(generation)) return;

			if (this.#deps.config.trimMcp() && this.#deps.mcp) {
				mcpSlept = await this.#runStep("sleep MCP servers", () => this.#deps.mcp?.sleepAll());
				if (mcpSlept) completedSteps++;
			}
			if (!this.#canContinue(generation)) return;

			workers = await this.#runStep("terminate background workers", () => this.#deps.workers.terminateAll());
			if (workers) completedSteps++;
			if (!this.#canContinue(generation)) return;

			cachesCleared = await this.#runStep("clear process caches", () => this.#deps.caches.clear());
			if (cachesCleared) completedSteps++;
			if (!this.#canContinue(generation)) return;

			const collected = await this.#runStep("collect garbage", () => Bun.gc(true));
			if (collected) completedSteps++;
			if (!this.#canContinue(generation)) return;

			const rssAfter = process.memoryUsage().rss;
			if (completedSteps > 0) this.#deps.statusLine?.setHookStatus("memory", "low-mem");
			logger.info("idle memory trim", { rssBefore, rssAfter, parked, mcpSlept, workers, cachesCleared });
		} finally {
			this.#trimming = false;
		}
	}

	#canContinue(generation: number, expectedTimer?: NodeJS.Timeout): boolean {
		return (
			!this.#disposed &&
			this.#deps.config.enabled() &&
			!this.#deps.isActive() &&
			this.#generation === generation &&
			(expectedTimer === undefined || this.#timer === expectedTimer)
		);
	}

	async #runStep(name: string, operation: () => Promise<void> | void): Promise<boolean> {
		try {
			await operation();
			return true;
		} catch (error) {
			logger.warn("idle memory trim step failed", {
				step: name,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	#cancelForActivity(): void {
		this.#generation++;
		this.#clearTimer();
		this.#deps.statusLine?.setHookStatus("memory", undefined);
	}

	#clearTimer(): void {
		if (!this.#timer) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
