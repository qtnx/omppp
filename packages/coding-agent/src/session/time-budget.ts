export const MIN_TIME_BUDGET_MS = 10 * 60_000;
export const TIME_BUDGET_CHECKPOINT_MS = 5 * 60_000;
export const TIME_BUDGET_CUSTOM_TYPE = "time_budget";

export type TimeBudgetEvent = "activate" | "extend" | "checkpoint" | "overtime" | "deactivate";

export interface TimeBudgetEntryData {
	event: TimeBudgetEvent;
	/** Total budget after this event. */
	budgetMs: number;
	/** Accumulated active main-session work at this event. */
	activeMs: number;
	/** Wall-clock epoch milliseconds when the entry was appended. */
	at: number;
}

export type ParsedTimeBudgetCommand =
	| { action: "status" }
	| { action: "off" }
	| { action: "activate"; durationMs: number }
	| { action: "extend"; durationMs: number };

export interface TimeBudgetSnapshot {
	active: boolean;
	running: boolean;
	budgetMs: number;
	activeMs: number;
	remainingMs: number;
	overtimeMs: number;
	overtimeLogged: boolean;
}

export interface TimeBudgetControllerOptions {
	now?: () => number;
	appendEntry: (data: TimeBudgetEntryData) => void;
	sendReminder: (kind: "activation" | "checkpoint" | "overtime", snapshot: TimeBudgetSnapshot) => Promise<void>;
}

const TIME_BUDGET_USAGE = "Usage: /time-budget <duration | +duration | off> (for example: 30m, 1h30m; minimum 10m).";
const durationSegment = /(\d+)([mh])/g;

function validDuration(value: number): boolean {
	return Number.isFinite(value) && value > 0 && Number.isSafeInteger(value);
}

function parseDuration(input: string): number | undefined {
	if (!input) return undefined;
	let durationMs = 0;
	let offset = 0;
	const seenUnits = new Set<string>();
	durationSegment.lastIndex = 0;
	for (let match = durationSegment.exec(input); match; match = durationSegment.exec(input)) {
		if (match.index !== offset || seenUnits.has(match[2])) return undefined;
		seenUnits.add(match[2]);
		const amount = Number(match[1]);
		const unitMs = match[2] === "h" ? 60 * 60_000 : 60_000;
		if (!Number.isSafeInteger(amount) || amount <= 0 || amount > Math.floor(Number.MAX_SAFE_INTEGER / unitMs)) {
			return undefined;
		}
		durationMs += amount * unitMs;
		if (!validDuration(durationMs)) return undefined;
		offset = durationSegment.lastIndex;
	}
	return offset === input.length ? durationMs : undefined;
}

export function parseTimeBudgetCommand(args: string): ParsedTimeBudgetCommand | string {
	const input = args.trim().toLowerCase();
	if (!input) return { action: "status" };
	if (input === "off") return { action: "off" };
	const extending = input.startsWith("+");
	const durationMs = parseDuration(extending ? input.slice(1) : input);
	if (durationMs === undefined) return TIME_BUDGET_USAGE;
	if (!extending && durationMs < MIN_TIME_BUDGET_MS) {
		return "Time budget must be at least 10m.";
	}
	return extending ? { action: "extend", durationMs } : { action: "activate", durationMs };
}

function displayDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h${remainder}m`;
}

export function formatTimeBudgetSnapshot(snapshot: TimeBudgetSnapshot): string {
	const elapsed = displayDuration(snapshot.activeMs);
	if (!snapshot.active) {
		return snapshot.overtimeMs > 0
			? `Time budget inactive: ${elapsed} elapsed, ${displayDuration(snapshot.overtimeMs)} overtime.`
			: `Time budget inactive: ${elapsed} elapsed.`;
	}
	if (snapshot.overtimeMs > 0) {
		return `Time budget active: ${elapsed} elapsed, ${displayDuration(snapshot.overtimeMs)} overtime.`;
	}
	return `Time budget active: ${elapsed} elapsed, ${displayDuration(snapshot.remainingMs)} remaining.`;
}

function isTimeBudgetEvent(value: unknown): value is TimeBudgetEvent {
	return (
		value === "activate" ||
		value === "extend" ||
		value === "checkpoint" ||
		value === "overtime" ||
		value === "deactivate"
	);
}

function parsePersistedEntry(entry: unknown): TimeBudgetEntryData | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as { customType?: unknown; data?: unknown };
	if (candidate.customType !== TIME_BUDGET_CUSTOM_TYPE || !candidate.data || typeof candidate.data !== "object") {
		return undefined;
	}
	const data = candidate.data as Partial<TimeBudgetEntryData>;
	if (
		!isTimeBudgetEvent(data.event) ||
		typeof data.budgetMs !== "number" ||
		typeof data.activeMs !== "number" ||
		typeof data.at !== "number" ||
		!Number.isFinite(data.budgetMs) ||
		!Number.isFinite(data.activeMs) ||
		!Number.isFinite(data.at) ||
		data.budgetMs <= 0 ||
		data.activeMs < 0 ||
		data.at < 0
	) {
		return undefined;
	}
	return { event: data.event, budgetMs: data.budgetMs, activeMs: data.activeMs, at: data.at };
}

export class TimeBudgetController {
	readonly #now: () => number;
	readonly #appendEntry: (data: TimeBudgetEntryData) => void;
	readonly #sendReminder: TimeBudgetControllerOptions["sendReminder"];
	#active = false;
	#running = false;
	#budgetMs = 0;
	#activeMs = 0;
	#activeStartedAt: number | undefined;
	#nextCheckpointMs = TIME_BUDGET_CHECKPOINT_MS;
	#overtimeLogged = false;
	#timer: Timer | undefined;
	#deliveryTail: Promise<void> = Promise.resolve();

	constructor(options: TimeBudgetControllerOptions) {
		this.#now = options.now ?? Date.now;
		this.#appendEntry = options.appendEntry;
		this.#sendReminder = options.sendReminder;
	}

	restore(entries: readonly unknown[]): void {
		this.#disposeTimer();
		this.#active = false;
		this.#running = false;
		this.#budgetMs = 0;
		this.#activeMs = 0;
		this.#activeStartedAt = undefined;
		this.#nextCheckpointMs = TIME_BUDGET_CHECKPOINT_MS;
		this.#overtimeLogged = false;

		let restored: TimeBudgetEntryData | undefined;
		let overtimeLogged = false;
		for (const entry of entries) {
			const data = parsePersistedEntry(entry);
			if (!data) continue;
			if (data.event === "activate") {
				restored = data;
				overtimeLogged = false;
				continue;
			}
			if (!restored) continue;
			if (data.event === "deactivate") {
				restored = undefined;
				overtimeLogged = false;
				continue;
			}
			restored = data;
			if (data.event === "extend" && data.activeMs < data.budgetMs) overtimeLogged = false;
			if (data.event === "overtime") overtimeLogged = true;
		}
		if (!restored) return;
		this.#active = true;
		this.#budgetMs = restored.budgetMs;
		this.#activeMs = restored.activeMs;
		this.#overtimeLogged = overtimeLogged;
		this.#nextCheckpointMs = (Math.floor(this.#activeMs / TIME_BUDGET_CHECKPOINT_MS) + 1) * TIME_BUDGET_CHECKPOINT_MS;
	}

	async activate(durationMs: number): Promise<TimeBudgetSnapshot> {
		if (!validDuration(durationMs) || durationMs < MIN_TIME_BUDGET_MS) {
			throw new Error("Time budget must be at least 10m.");
		}
		this.#disposeTimer();
		this.#active = true;
		this.#running = false;
		this.#budgetMs = durationMs;
		this.#activeMs = 0;
		this.#activeStartedAt = undefined;
		this.#nextCheckpointMs = TIME_BUDGET_CHECKPOINT_MS;
		this.#overtimeLogged = false;
		this.#append("activate");
		const snapshot = this.#requireSnapshot();
		await this.#deliver("activation", snapshot);
		return snapshot;
	}

	async extend(durationMs: number): Promise<TimeBudgetSnapshot> {
		if (!this.#active) throw new Error("No active time budget to extend.");
		if (!validDuration(durationMs)) throw new Error(TIME_BUDGET_USAGE);
		const wasRunning = this.#running;
		this.#foldActiveWindow();
		this.#budgetMs += durationMs;
		if (!validDuration(this.#budgetMs)) throw new Error(TIME_BUDGET_USAGE);
		if (this.#activeMs < this.#budgetMs) this.#overtimeLogged = false;
		if (wasRunning) {
			this.#running = true;
			this.#activeStartedAt = this.#now();
		}
		this.#append("extend");
		this.#schedule();
		return this.#requireSnapshot();
	}

	deactivate(): TimeBudgetSnapshot | null {
		if (!this.#active) return null;
		this.#foldActiveWindow();
		this.#disposeTimer();
		this.#running = false;
		this.#active = false;
		this.#append("deactivate");
		return this.#requireSnapshot();
	}

	setRunState(state: "running" | "idle"): void {
		if (!this.#active || (state === "running") === this.#running) return;
		if (state === "running") {
			this.#running = true;
			this.#activeStartedAt = this.#now();
			this.#schedule();
			return;
		}
		this.#foldActiveWindow();
		if (!this.#processBoundaries()) this.#append("checkpoint");
		this.#schedule();
	}

	snapshot(): TimeBudgetSnapshot | null {
		if (!this.#active) return null;
		return this.#snapshotAt(this.#now());
	}

	dispose(): void {
		this.#disposeTimer();
		this.#running = false;
		this.#activeStartedAt = undefined;
	}

	#disposeTimer(): void {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	#foldActiveWindow(): void {
		if (!this.#running || this.#activeStartedAt === undefined) return;
		const elapsed = Math.max(0, this.#now() - this.#activeStartedAt);
		this.#activeMs += elapsed;
		this.#activeStartedAt = undefined;
		this.#running = false;
	}

	#schedule(): void {
		this.#disposeTimer();
		if (!this.#active || !this.#running) return;
		const snapshot = this.#snapshotAt(this.#now());
		const checkpointDue = this.#nextCheckpointMs;
		const deadlineDue = this.#overtimeLogged ? Number.POSITIVE_INFINITY : this.#budgetMs;
		const nextDue = Math.min(checkpointDue, deadlineDue);
		const waitMs = Math.max(0, nextDue - snapshot.activeMs);
		this.#timer = setTimeout(() => this.#onTimer(), waitMs);
	}

	#onTimer(): void {
		this.#timer = undefined;
		if (!this.#active || !this.#running) return;
		this.#foldActiveWindow();
		this.#processBoundaries();
		if (this.#active) {
			this.#running = true;
			this.#activeStartedAt = this.#now();
			this.#schedule();
		}
	}

	#processBoundaries(): boolean {
		const snapshot = this.#requireSnapshot();
		let checkpointSent = false;
		if (snapshot.activeMs >= this.#nextCheckpointMs) {
			this.#nextCheckpointMs =
				(Math.floor(snapshot.activeMs / TIME_BUDGET_CHECKPOINT_MS) + 1) * TIME_BUDGET_CHECKPOINT_MS;
			this.#append("checkpoint");
			void this.#deliver("checkpoint", this.#requireSnapshot());
			checkpointSent = true;
		}
		if (!this.#overtimeLogged && snapshot.activeMs >= this.#budgetMs) {
			this.#overtimeLogged = true;
			this.#append("overtime");
			void this.#deliver("overtime", this.#requireSnapshot());
		}
		return checkpointSent;
	}

	#append(event: TimeBudgetEvent): void {
		this.#appendEntry({
			event,
			budgetMs: this.#budgetMs,
			activeMs: this.#snapshotAt(this.#now()).activeMs,
			at: this.#now(),
		});
	}

	#deliver(kind: "activation" | "checkpoint" | "overtime", snapshot: TimeBudgetSnapshot): Promise<void> {
		const delivery = this.#deliveryTail.then(() => this.#sendReminder(kind, snapshot));
		this.#deliveryTail = delivery.catch(() => {});
		return delivery;
	}

	#snapshotAt(now: number): TimeBudgetSnapshot {
		const activeMs =
			this.#activeMs +
			(this.#running && this.#activeStartedAt !== undefined ? Math.max(0, now - this.#activeStartedAt) : 0);
		const remainingMs = Math.max(0, this.#budgetMs - activeMs);
		const overtimeMs = Math.max(0, activeMs - this.#budgetMs);
		return {
			active: this.#active,
			running: this.#running,
			budgetMs: this.#budgetMs,
			activeMs,
			remainingMs,
			overtimeMs,
			overtimeLogged: this.#overtimeLogged,
		};
	}

	#requireSnapshot(): TimeBudgetSnapshot {
		return this.#snapshotAt(this.#now());
	}
}
