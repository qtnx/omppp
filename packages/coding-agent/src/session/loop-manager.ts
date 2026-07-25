import { logger } from "@oh-my-pi/pi-utils";

export interface ScheduleLoopOptions {
	prompt: string;
	intervalMs: number;
	count: number;
}

export interface LoopHandle {
	readonly id: string;
}

interface LoopEntry {
	id: string;
	prompt: string;
	intervalMs: number;
	count: number;
	iteration: number;
	cancelled: boolean;
	controller: AbortController;
	timer: Timer | undefined;
}

/**
 * Session-scoped scheduler that delivers loop iterations as follow-up turns.
 * Uses chained `setTimeout` (never `setInterval`): exactly one live timer per loop.
 * Iteration 1 fires immediately; subsequent ticks wait `intervalMs`.
 */
export class LoopManager {
	readonly #followUp: (text: string, signal: AbortSignal) => Promise<void>;
	readonly #loops = new Map<string, LoopEntry>();
	#seq = 0;

	constructor(followUp: (text: string, signal: AbortSignal) => Promise<void>) {
		this.#followUp = followUp;
	}

	get activeCount(): number {
		let n = 0;
		for (const entry of this.#loops.values()) {
			if (!entry.cancelled) n++;
		}
		return n;
	}

	schedule(options: ScheduleLoopOptions): LoopHandle {
		const id = `l${(++this.#seq).toString(36)}`;
		const entry: LoopEntry = {
			id,
			prompt: options.prompt,
			intervalMs: options.intervalMs,
			count: options.count,
			iteration: 0,
			cancelled: false,
			controller: new AbortController(),
			timer: undefined,
		};
		this.#loops.set(id, entry);
		// Iteration 1 fires without waiting a full interval.
		this.#tick(entry);
		return { id };
	}

	/** Idempotent: clears every timer and seals every loop. In-flight followUp
	 *  promises may still settle but MUST NOT schedule further iterations. */
	cancelAll(): void {
		for (const entry of this.#loops.values()) {
			this.#cancelEntry(entry);
		}
		this.#loops.clear();
	}

	#cancelEntry(entry: LoopEntry): void {
		entry.cancelled = true;
		entry.controller.abort();
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
	}

	#tick(entry: LoopEntry): void {
		// Single-threaded race model: cancelled-flag check and fire stay
		// synchronous within this tick — no await between them.
		if (entry.cancelled) return;
		if (entry.iteration >= entry.count) {
			this.#finish(entry);
			return;
		}

		entry.iteration += 1;
		const text = `[loop ${entry.id} · ${entry.iteration}/${entry.count}] ${entry.prompt}`;
		const iteration = entry.iteration;
		const count = entry.count;

		void this.#followUp(text, entry.controller.signal).then(
			() => {
				if (entry.cancelled) return;
				if (iteration >= count) {
					this.#finish(entry);
					return;
				}
				entry.timer = setTimeout(() => {
					entry.timer = undefined;
					this.#tick(entry);
				}, entry.intervalMs);
			},
			(err: unknown) => {
				logger.warn("Loop followUp rejected; cancelling loop", {
					id: entry.id,
					error: err instanceof Error ? err.message : String(err),
				});
				this.#cancelEntry(entry);
				this.#loops.delete(entry.id);
			},
		);
	}

	#finish(entry: LoopEntry): void {
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		entry.cancelled = true;
		this.#loops.delete(entry.id);
	}
}
