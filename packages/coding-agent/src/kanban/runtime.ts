import { logger } from "@oh-my-pi/pi-utils";
import { KanbanSessionDelivery, type KanbanSessionPort } from "./delivery";
import { createKanbanServer, type KanbanClientAssets, type KanbanServerHandle } from "./server";
import { KanbanStore } from "./store";
import type { KanbanActivity } from "./types";

export type { KanbanCustomMessagePayload, KanbanPromptOptions, KanbanSessionPort } from "./delivery";

export interface KanbanRuntimeOptions {
	dbPath: string;
	assets: KanbanClientAssets;
	port?: number;
}

export interface KanbanRegistration {
	boardUrl: string;
	/** Tailnet-addressed board URLs; empty when Tailscale is not up on this host. */
	tailnetUrls: readonly string[];
}

/**
 * Board access handed to the in-session Kanban tool. Model-authored mutations
 * reach connected boards through {@link publish} but are never delivered back
 * into the model session that produced them — the model already knows.
 */
export interface KanbanModelApi {
	readonly sessionId: string;
	readonly store: KanbanStore;
	publish(activity: KanbanActivity | null | undefined): void;
}

export class KanbanRuntime {
	readonly #options: KanbanRuntimeOptions;
	readonly #sessions = new Set<KanbanSessionPort>();
	readonly #delivery = new KanbanSessionDelivery();
	readonly #pendingEvents = new Map<KanbanSessionPort, Map<string, string>>();
	readonly #durableUnregister = new Map<KanbanSessionPort, () => void>();
	#store: KanbanStore | null = null;
	#server: KanbanServerHandle | null = null;
	#lifecycle: Promise<void> = Promise.resolve();

	constructor(options: KanbanRuntimeOptions) {
		this.#options = options;
	}

	get ownerCount(): number {
		return this.#sessions.size;
	}

	get running(): boolean {
		return this.#server !== null;
	}

	get localUrl(): string | null {
		return this.#server?.localUrl ?? null;
	}

	/**
	 * Board access for the in-session tool, or `null` when this runtime does not
	 * own a live board for `sessionId`. Published activities reach connected
	 * browsers and are acknowledged immediately: the model authored them, so
	 * replaying them back into its own session would echo.
	 */
	apiForSession(sessionId: string): KanbanModelApi | null {
		const store = this.#store;
		const server = this.#server;
		if (!store || !server || !this.#sessionForId(sessionId)) return null;
		return {
			sessionId,
			store,
			publish: activity => {
				if (!activity) return;
				server.broadcast(activity);
				store.markDelivered(activity.sessionId, activity.id);
			},
		};
	}

	async registerSession(session: KanbanSessionPort): Promise<KanbanRegistration> {
		return await this.#serialize(async () => {
			this.#ensureRunning();
			if (!this.#sessions.has(session)) {
				this.#sessions.add(session);
				this.#delivery.register(session);
				this.#durableUnregister.set(
					session,
					session.onKanbanEventsDurable(eventIds => this.#acknowledgeDurableEvents(session, eventIds)),
				);
			}
			await this.#replaySession(session);
			const boardUrl = this.#boardUrl(session.sessionId);
			const tailnetUrls = this.#tailnetBoardUrls(session.sessionId);
			const reachable = [boardUrl, ...tailnetUrls].join("  ");
			session.emitNotice("info", `Kanban board: ${reachable}`, "kanban");
			return { boardUrl, tailnetUrls };
		});
	}

	async unregisterSession(session: KanbanSessionPort): Promise<void> {
		await this.#serialize(async () => {
			if (!this.#sessions.delete(session)) return;
			this.#durableUnregister.get(session)?.();
			this.#durableUnregister.delete(session);
			this.#pendingEvents.delete(session);
			this.#delivery.unregister(session);
			if (this.#sessions.size === 0) await this.#stopRuntime();
		});
	}

	async close(): Promise<void> {
		await this.#serialize(async () => {
			this.#sessions.clear();
			for (const unregister of this.#durableUnregister.values()) unregister();
			this.#durableUnregister.clear();
			this.#pendingEvents.clear();
			this.#delivery.clear();
			await this.#stopRuntime();
		});
	}

	#ensureRunning(): void {
		if (this.#server && this.#store) return;
		const store = KanbanStore.open(this.#options.dbPath);
		try {
			const server = createKanbanServer({
				store,
				assets: this.#options.assets,
				activeSessionIds: () => this.#activeSessionIds(),
				port: this.#options.port ?? 0,
				onActivity: async activity => await this.#deliverActivity(activity),
				onSessionAccess: async sessionId => await this.#replayBySessionId(sessionId),
			});
			this.#store = store;
			this.#server = server;
		} catch (error) {
			store.close();
			throw error;
		}
	}

	async #stopRuntime(): Promise<void> {
		const server = this.#server;
		const store = this.#store;
		this.#server = null;
		this.#store = null;
		if (server) await server.stop();
		store?.close();
		this.#pendingEvents.clear();
	}

	#activeSessionIds(): string[] {
		return [...new Set([...this.#sessions].map(session => session.sessionId).filter(Boolean))];
	}

	#sessionForId(sessionId: string): KanbanSessionPort | null {
		for (const session of this.#sessions) {
			if (session.sessionId === sessionId) return session;
		}
		return null;
	}

	async #replayBySessionId(sessionId: string): Promise<void> {
		const session = this.#sessionForId(sessionId);
		if (session) await this.#replaySession(session);
	}

	async #replaySession(session: KanbanSessionPort): Promise<void> {
		const store = this.#store;
		if (!store) return;
		const sessionId = session.sessionId;
		for (const event of store.listUndelivered(sessionId)) {
			if (session.sessionId !== sessionId) return;
			if (session.hasDurableKanbanEvent(event.id)) {
				store.markDelivered(sessionId, event.id);
				continue;
			}
			try {
				await this.#handoff(session, event);
			} catch (error) {
				logger.warn("Kanban outbox replay remains pending", {
					eventId: event.id,
					error: error instanceof Error ? error.name : "unknown",
				});
			}
		}
	}

	async #deliverActivity(activity: KanbanActivity): Promise<void> {
		const session = this.#sessionForId(activity.sessionId);
		if (!session) return;
		await this.#handoff(session, activity);
	}

	async #handoff(session: KanbanSessionPort, activity: KanbanActivity): Promise<void> {
		if (!this.#store) return;
		let pending = this.#pendingEvents.get(session);
		if (!pending) {
			pending = new Map<string, string>();
			this.#pendingEvents.set(session, pending);
		}
		if (pending.has(activity.id)) return;
		pending.set(activity.id, activity.sessionId);
		try {
			await this.#delivery.deliver(session, activity);
		} catch (error) {
			pending.delete(activity.id);
			if (pending.size === 0) this.#pendingEvents.delete(session);
			throw error;
		}
	}

	#acknowledgeDurableEvents(session: KanbanSessionPort, eventIds: readonly string[]): void {
		const store = this.#store;
		const pending = this.#pendingEvents.get(session);
		if (!store || !pending) return;
		for (const eventId of new Set(eventIds)) {
			const sessionId = pending.get(eventId);
			if (!sessionId) continue;
			store.markDelivered(sessionId, eventId);
			pending.delete(eventId);
		}
		if (pending.size === 0) this.#pendingEvents.delete(session);
	}

	#boardUrl(sessionId: string): string {
		const localUrl = this.#server?.localUrl;
		if (!localUrl) throw new Error("Kanban runtime is not running");
		return `${localUrl}kanban/${encodeURIComponent(sessionId)}`;
	}

	/** Same board, addressed over this host's tailnet so phones and laptops on it can open it. */
	#tailnetBoardUrls(sessionId: string): string[] {
		return (this.#server?.tailnetUrls ?? []).map(root => `${root}kanban/${encodeURIComponent(sessionId)}`);
	}

	async #serialize<T>(work: () => Promise<T> | T): Promise<T> {
		const previous = this.#lifecycle;
		const release = Promise.withResolvers<void>();
		this.#lifecycle = previous.catch(() => undefined).then(() => release.promise);
		await previous.catch(() => undefined);
		try {
			return await work();
		} finally {
			release.resolve();
		}
	}
}
