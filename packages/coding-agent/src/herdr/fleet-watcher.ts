/**
 * Watches every Herdr-managed pane and reports peer agents that just finished.
 *
 * Herdr accepts exactly ONE `events.subscribe` per connection and its
 * `pane.agent_status_changed` subscription takes no wildcard, so the watched set
 * is expressed as one subscription per pane id plus the global
 * `pane.agent_detected`. Changing the set therefore means reopening the stream,
 * and every reopen is followed by a `pane.list` reconcile so a transition that
 * happened inside the gap is not lost.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { type HerdrEvent, type HerdrEventStream, herdrPaneSnapshot, openHerdrEventStream } from "./socket";

const DEFAULT_MIN_WORK_MS = 5_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;

/** A peer agent that transitioned out of `working` into a settled state. */
export interface FleetAgentSettled {
	paneId: string;
	workspaceId?: string;
	agent?: string;
	/** Herdr named-agent name when known; status events do not carry it. */
	name?: string;
	status: "done" | "idle";
	workedMs?: number;
	title?: string;
}

export interface HerdrFleetWatcherOptions {
	socketPath: string;
	/** Pane hosting the watcher itself; never reported. */
	selfPaneId?: string;
	/** When set, only panes in this workspace are reported. */
	workspaceId?: string;
	/** Minimum time a pane must have been `working` before a settle is reported. */
	minWorkMs?: number;
	onSettled(info: FleetAgentSettled): void;
	/** Injected clock; defaults to `Date.now`. */
	now?: () => number;
}

interface PaneState {
	lastStatus?: string;
	/** Set while the pane is mid-task; `blocked` does NOT clear it. */
	workingSince?: number;
	agent?: string;
	workspaceId?: string;
	title?: string;
}

function isSettled(status: string | undefined): status is "done" | "idle" {
	return status === "done" || status === "idle";
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class HerdrFleetWatcher {
	readonly #options: HerdrFleetWatcherOptions;
	readonly #panes = new Map<string, PaneState>();
	readonly #minWorkMs: number;
	readonly #now: () => number;
	#stream: HerdrEventStream | undefined;
	#reconnectTimer: NodeJS.Timeout | undefined;
	#reconnectDelay = RECONNECT_MIN_MS;
	#started = false;
	#stopped = false;
	/** True while this instance is deliberately cycling the stream, so the
	 *  resulting `onClose` is not mistaken for a dropped connection. */
	#cycling = false;

	constructor(options: HerdrFleetWatcherOptions) {
		this.#options = options;
		this.#minWorkMs = options.minWorkMs ?? DEFAULT_MIN_WORK_MS;
		this.#now = options.now ?? (() => Date.now());
	}

	get watchedPanes(): readonly string[] {
		return [...this.#panes.keys()];
	}

	/** Seed the watched set from a snapshot, then open the stream. Idempotent. */
	async start(): Promise<void> {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		await this.#seed();
		this.#open();
	}

	/** Close the stream and make every later callback a no-op. Idempotent. */
	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = undefined;
		}
		const stream = this.#stream;
		this.#stream = undefined;
		stream?.close();
	}

	/**
	 * Adopt an observed status into a pane's state.
	 *
	 * A pane can be seen `working` without us ever receiving the live `working`
	 * event: herdr allows one `events.subscribe` per connection and no wildcard,
	 * so a newly detected pane has no per-pane subscription until the stream is
	 * reopened, and its `working` event lands in that gap. Adopting the state
	 * from a snapshot (or from the detect event) is the only way to see it. The
	 * adopted timer starts at adoption time, which understates real work — that
	 * is deliberate: the true start is unknown, and understating only ever makes
	 * the `minWorkMs` gate stricter.
	 */
	#observeStatus(state: PaneState, status: string | undefined): void {
		if (status === "working") state.workingSince ??= this.#now();
		state.lastStatus = status;
	}

	/** Baseline every pane that already hosts an agent WITHOUT reporting it: a
	 *  pane already sitting at `done` when we start is not news. */
	async #seed(): Promise<void> {
		for (const pane of await herdrPaneSnapshot(this.#options.socketPath)) {
			if (!pane.agent) continue;
			const state: PaneState = {
				agent: pane.agent,
				workspaceId: pane.workspaceId,
				title: pane.title,
			};
			this.#observeStatus(state, pane.agentStatus);
			this.#panes.set(pane.paneId, state);
		}
	}

	#subscriptions(): Record<string, unknown>[] {
		return [
			{ type: "pane.agent_detected" },
			...[...this.#panes.keys()].map(paneId => ({ type: "pane.agent_status_changed", pane_id: paneId })),
		];
	}

	#open(): void {
		if (this.#stopped) return;
		this.#stream = openHerdrEventStream(this.#options.socketPath, this.#subscriptions(), {
			onEvent: event => this.#onEvent(event),
			onClose: reason => this.#onClose(reason),
			onReady: () => {
				this.#reconnectDelay = RECONNECT_MIN_MS;
			},
		});
	}

	#onClose(reason: string): void {
		this.#stream = undefined;
		if (this.#stopped || this.#cycling) return;
		logger.debug("herdr-fleet: event stream closed", { reason, delayMs: this.#reconnectDelay });
		const delay = this.#reconnectDelay;
		this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS);
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			void this.#cycle();
		}, delay);
		this.#reconnectTimer.unref?.();
	}

	/** Reopen the stream for the current pane set, then reconcile the gap. */
	async #cycle(): Promise<void> {
		if (this.#stopped || this.#cycling) return;
		this.#cycling = true;
		try {
			const previous = this.#stream;
			this.#stream = undefined;
			previous?.close();
			this.#open();
			await this.#reconcile();
		} catch (error) {
			logger.warn("herdr-fleet: stream cycle failed", { error: String(error) });
		} finally {
			this.#cycling = false;
		}
	}

	/** A settle that happened while we were not listening still has to be reported. */
	async #reconcile(): Promise<void> {
		if (this.#stopped) return;
		for (const pane of await herdrPaneSnapshot(this.#options.socketPath)) {
			if (!pane.agent) continue;
			const state = this.#panes.get(pane.paneId);
			if (!state) {
				const fresh: PaneState = {
					agent: pane.agent,
					workspaceId: pane.workspaceId,
					title: pane.title,
				};
				this.#observeStatus(fresh, pane.agentStatus);
				this.#panes.set(pane.paneId, fresh);
				continue;
			}
			if (pane.agent) state.agent = pane.agent;
			if (pane.workspaceId) state.workspaceId = pane.workspaceId;
			if (pane.title) state.title = pane.title;
			if (state.workingSince !== undefined && isSettled(pane.agentStatus)) {
				this.#settle(pane.paneId, pane.agentStatus);
			} else {
				this.#observeStatus(state, pane.agentStatus);
			}
		}
	}

	#onEvent(event: HerdrEvent): void {
		try {
			switch (event.event) {
				case "pane.agent_status_changed":
				case "pane_agent_status_changed":
					this.#onStatus(event.data);
					return;
				case "pane.agent_detected":
				case "pane_agent_detected":
					this.#onDetected(event.data);
					return;
				default:
					return;
			}
		} catch (error) {
			logger.warn("herdr-fleet: event handling failed", { event: event.event, error: String(error) });
		}
	}

	#onStatus(data: Record<string, unknown>): void {
		const paneId = readString(data.pane_id);
		if (!paneId) return;
		const state = this.#panes.get(paneId) ?? {};
		this.#panes.set(paneId, state);
		const agent = readString(data.agent);
		const workspaceId = readString(data.workspace_id);
		const title = readString(data.title);
		if (agent) state.agent = agent;
		if (workspaceId) state.workspaceId = workspaceId;
		if (title) state.title = title;

		const status = readString(data.agent_status);
		if (status === "working") {
			state.workingSince ??= this.#now();
			state.lastStatus = status;
			return;
		}
		if (isSettled(status)) {
			this.#settle(paneId, status);
			return;
		}
		// `blocked` and `unknown` are mid-task: keep the working timer running.
		state.lastStatus = status;
	}

	/** Report a `working` → settled transition once, applying every filter. */
	#settle(paneId: string, status: "done" | "idle"): void {
		const state = this.#panes.get(paneId);
		if (!state) return;
		const workingSince = state.workingSince;
		state.workingSince = undefined;
		state.lastStatus = status;
		// A settle we never saw start is not a completion we can attribute.
		if (workingSince === undefined) return;
		const workedMs = Math.max(0, this.#now() - workingSince);
		if (workedMs < this.#minWorkMs) return;
		if (this.#options.selfPaneId && paneId === this.#options.selfPaneId) return;
		const scope = this.#options.workspaceId;
		if (scope && state.workspaceId && state.workspaceId !== scope) return;
		this.#options.onSettled({
			paneId,
			workspaceId: state.workspaceId,
			agent: state.agent,
			status,
			workedMs,
			title: state.title,
		});
	}

	#onDetected(data: Record<string, unknown>): void {
		const paneId = readString(data.pane_id);
		if (!paneId) return;
		if (data.released === true) {
			if (this.#panes.delete(paneId)) void this.#cycle();
			return;
		}
		if (this.#panes.has(paneId)) return;
		const state: PaneState = {
			agent: readString(data.agent),
			workspaceId: readString(data.workspace_id),
		};
		this.#observeStatus(state, readString(data.agent_status));
		this.#panes.set(paneId, state);
		void this.#cycle();
	}
}
