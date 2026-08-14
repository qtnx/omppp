import { logger } from "@oh-my-pi/pi-utils";
import { KanbanSessionDelivery, type KanbanSessionPort } from "./delivery";
import { createKanbanServer, type KanbanClientAssets, type KanbanServerHandle } from "./server";
import { KanbanStore } from "./store";
import type { KanbanActivity, KanbanComment, KanbanTask } from "./types";

export type {
	KanbanCustomMessagePayload,
	KanbanForkedAgent,
	KanbanForkRequest,
	KanbanPromptOptions,
	KanbanSessionPort,
} from "./delivery";

export interface KanbanRuntimeOptions {
	dbPath: string;
	assets: KanbanClientAssets;
	/** Stable id for this project's board; every session in the cwd shares it. */
	boardId: string;
	port?: number;
}

export interface KanbanRegistration {
	boardUrl: string;
	/** Tailnet-addressed board URLs; empty when Tailscale is not up on this host. */
	tailnetUrls: readonly string[];
	/** This session's board name — the value tasks are assigned to. */
	name: string;
}

/**
 * Board access handed to the in-session Kanban tool. Model-authored mutations
 * reach connected boards through {@link publish} but are never delivered back
 * into the model session that produced them — the model already knows.
 */
export interface KanbanModelApi {
	readonly boardId: string;
	readonly sessionName: string;
	readonly store: KanbanStore;
	publish(activity: KanbanActivity | null | undefined): void;
}

/** How often each process re-announces itself and looks for peers' writes. */
const SYNC_INTERVAL_MS = 2_000;
/** Ids already routed in this process, so polling never double-delivers. */
const SEEN_EVENT_LIMIT = 512;

const NAME_ADJECTIVES = [
	"amber",
	"brisk",
	"calm",
	"clever",
	"deft",
	"eager",
	"fleet",
	"keen",
	"lucid",
	"nimble",
	"quiet",
	"rapid",
	"solid",
	"steady",
	"swift",
	"vivid",
] as const;

const NAME_ANIMALS = [
	"otter",
	"heron",
	"lynx",
	"raven",
	"tapir",
	"ibex",
	"marten",
	"osprey",
	"badger",
	"falcon",
	"gecko",
	"kite",
	"mantis",
	"puffin",
	"shrike",
	"wren",
] as const;

/**
 * A short, stable, human-sayable name per session. Derived from the session id
 * so a resumed session keeps the assignments already written against its name.
 */
export function sessionBoardName(sessionId: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < sessionId.length; index++) {
		hash ^= sessionId.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const adjective = NAME_ADJECTIVES[hash % NAME_ADJECTIVES.length]!;
	const animal = NAME_ANIMALS[(hash >>> 8) % NAME_ANIMALS.length]!;
	return `${adjective}-${animal}`;
}

export class KanbanRuntime {
	readonly #options: KanbanRuntimeOptions;
	readonly #sessions = new Map<KanbanSessionPort, string>();
	readonly #delivery = new KanbanSessionDelivery();
	readonly #pendingEvents = new Map<KanbanSessionPort, Set<string>>();
	readonly #durableUnregister = new Map<KanbanSessionPort, () => void>();
	readonly #seenEvents = new Set<string>();
	/** Ephemeral background aliases that may use their parent's board API. */
	readonly #forkedAgents = new Map<string, KanbanSessionPort>();
	#store: KanbanStore | null = null;
	#server: KanbanServerHandle | null = null;
	#sync: Timer | null = null;
	#syncCursor = 0;
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
	 * Board access for the in-session tool, or `null` while this session owns no
	 * live board. Published activities reach connected browsers and are
	 * acknowledged immediately: the model authored them, so replaying them back
	 * into its own session would echo.
	 */
	apiForSession(sessionId: string): KanbanModelApi | null {
		const store = this.#store;
		const server = this.#server;
		const session = this.#sessionForId(sessionId) ?? this.#forkedAgents.get(sessionId);
		if (!store || !server || !session) return null;
		const boardId = this.#options.boardId;
		return {
			boardId,
			sessionName: this.#sessions.get(session) ?? sessionBoardName(sessionId),
			store,
			publish: activity => {
				if (!activity) return;
				this.#seenEvents.add(activity.id);
				this.#syncCursor = Math.max(this.#syncCursor, activity.cursor);
				server.broadcast(activity);
				store.markDelivered(boardId, activity.id);
			},
		};
	}

	/**
	 * Gives a forked background agent access to its interactive parent's board
	 * without registering it as a board recipient.
	 */
	attachForkedAgent(parentSessionId: string, agentSessionId: string): (() => void) | null {
		if (!this.#store || !this.#server) return null;
		const parent = this.#sessionForId(parentSessionId);
		if (!parent) return null;
		this.#forkedAgents.set(agentSessionId, parent);
		return () => {
			if (this.#forkedAgents.get(agentSessionId) === parent) this.#forkedAgents.delete(agentSessionId);
		};
	}

	async registerSession(session: KanbanSessionPort): Promise<KanbanRegistration> {
		return await this.#serialize(async () => {
			this.#ensureRunning();
			const name = sessionBoardName(session.sessionId);
			const joined = !this.#sessions.has(session);
			if (joined) {
				this.#sessions.set(session, name);
				this.#delivery.register(session);
				this.#durableUnregister.set(
					session,
					session.onKanbanEventsDurable(eventIds => this.#acknowledgeDurableEvents(session, eventIds)),
				);
			}
			this.#store?.upsertSession(this.#options.boardId, session.sessionId, name);
			const boardUrl = this.#boardUrl();
			// System-prompt section, not a chat message: compaction must not erase it.
			session.setKanbanBriefing(this.#delivery.briefing(boardUrl, name));
			await this.#replaySession(session);
			const tailnetUrls = this.#tailnetBoardUrls();
			const reachable = [boardUrl, ...tailnetUrls].join("  ");
			session.emitNotice("info", `Kanban board (${name}): ${reachable}`, "kanban");
			return { boardUrl, tailnetUrls, name };
		});
	}

	async unregisterSession(session: KanbanSessionPort): Promise<void> {
		await this.#serialize(async () => {
			if (!this.#sessions.delete(session)) return;
			session.setKanbanBriefing(null);
			this.#durableUnregister.get(session)?.();
			this.#durableUnregister.delete(session);
			this.#pendingEvents.delete(session);
			for (const [agentSessionId, parent] of this.#forkedAgents) {
				if (parent === session) this.#forkedAgents.delete(agentSessionId);
			}
			this.#delivery.unregister(session);
			this.#store?.removeSession(session.sessionId);
			if (this.#sessions.size === 0) await this.#stopRuntime();
		});
	}

	async close(): Promise<void> {
		await this.#serialize(async () => {
			for (const session of this.#sessions.keys()) {
				this.#store?.removeSession(session.sessionId);
				session.setKanbanBriefing(null);
			}
			this.#sessions.clear();
			for (const unregister of this.#durableUnregister.values()) unregister();
			this.#durableUnregister.clear();
			this.#pendingEvents.clear();
			this.#forkedAgents.clear();
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
				boardId: this.#options.boardId,
				port: this.#options.port ?? 0,
				onActivity: async activity => await this.#routeActivity(activity),
				onBoardAccess: async () => await this.#replayAll(),
			});
			this.#store = store;
			this.#server = server;
			this.#syncCursor = store.getBoard(this.#options.boardId).cursor;
			this.#sync = setInterval(() => void this.#syncWithPeers(), SYNC_INTERVAL_MS);
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
		clearInterval(this.#sync ?? undefined);
		this.#sync = null;
		if (server) await server.stop();
		store?.close();
		this.#pendingEvents.clear();
		this.#forkedAgents.clear();
		this.#seenEvents.clear();
	}

	/**
	 * Boards are shared by every session in the project, and each session runs in
	 * its own process with its own SSE clients. Polling the shared cursor is what
	 * makes a peer's write show up here — SQLite gives no cross-process events.
	 */
	async #syncWithPeers(): Promise<void> {
		const store = this.#store;
		const server = this.#server;
		if (!store || !server) return;
		try {
			for (const [session, name] of this.#sessions) {
				store.upsertSession(this.#options.boardId, session.sessionId, name);
			}
			const batch = store.listActivitiesAfter(this.#options.boardId, this.#syncCursor);
			for (const activity of batch) {
				this.#syncCursor = Math.max(this.#syncCursor, activity.cursor);
				if (this.#seenEvents.has(activity.id)) continue;
				server.broadcast(activity);
				await this.#routeActivity(activity);
			}
		} catch (error) {
			logger.warn("Kanban peer sync failed", { error: error instanceof Error ? error.name : "unknown" });
		}
	}

	#sessionForId(sessionId: string): KanbanSessionPort | null {
		for (const session of this.#sessions.keys()) {
			if (session.sessionId === sessionId) return session;
		}
		return null;
	}

	/** Sessions an event belongs to: the assignee's, or everyone when unassigned. */
	#recipients(activity: KanbanActivity): KanbanSessionPort[] {
		const assignee = assigneeOf(activity) ?? this.#storedTaskAssignee(activity.taskId);
		if (!assignee) return [...this.#sessions.keys()];
		const matches = [...this.#sessions].filter(([, name]) => name === assignee).map(([session]) => session);
		return matches;
	}

	#storedTaskAssignee(taskId: string | null): string | null {
		const store = this.#store;
		if (!store || !taskId) return null;
		try {
			return store.getTask(this.#options.boardId, taskId)?.assignee ?? null;
		} catch {
			return null;
		}
	}

	async #replayAll(): Promise<void> {
		for (const session of [...this.#sessions.keys()]) await this.#replaySession(session);
	}

	async #replaySession(session: KanbanSessionPort): Promise<void> {
		const store = this.#store;
		if (!store) return;
		const boardId = this.#options.boardId;
		for (const event of store.listUndelivered(boardId)) {
			if (!this.#sessions.has(session)) return;
			if (!this.#recipients(event).includes(session)) continue;
			if (session.hasDurableKanbanEvent(event.id)) {
				store.markDelivered(boardId, event.id);
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

	async #routeActivity(activity: KanbanActivity): Promise<void> {
		this.#remember(activity.id);
		for (const session of this.#recipients(activity)) {
			await this.#handoff(session, activity);
		}
	}

	#remember(eventId: string): void {
		this.#seenEvents.add(eventId);
		if (this.#seenEvents.size <= SEEN_EVENT_LIMIT) return;
		const oldest = this.#seenEvents.values().next().value;
		if (oldest) this.#seenEvents.delete(oldest);
	}

	async #handoff(session: KanbanSessionPort, activity: KanbanActivity): Promise<void> {
		if (!this.#store) return;
		// Replay and peer polling can both surface the same row. Remember it on
		// every path, not just the routed one, or the second path re-delivers
		// once the first has already been acknowledged and cleared from pending.
		this.#remember(activity.id);
		let pending = this.#pendingEvents.get(session);
		if (!pending) {
			pending = new Set<string>();
			this.#pendingEvents.set(session, pending);
		}
		if (pending.has(activity.id)) return;
		pending.add(activity.id);
		const context = this.#taskContext(activity);
		try {
			await this.#delivery.deliver(session, activity, {
				task: context.task,
				comments: context.comments,
				onAgentDispatched: eventId => this.#acknowledgeDurableEvents(session, [eventId]),
			});
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
			if (!pending.delete(eventId)) continue;
			store.markDelivered(this.#options.boardId, eventId);
		}
		if (pending.size === 0) this.#pendingEvents.delete(session);
	}

	#taskContext(activity: KanbanActivity): { task: KanbanTask | null; comments: readonly KanbanComment[] } {
		const store = this.#store;
		if (!store || !activity.taskId) return { task: null, comments: [] };
		try {
			return {
				task: store.getTask(this.#options.boardId, activity.taskId),
				comments: store.listComments(this.#options.boardId, activity.taskId),
			};
		} catch {
			return { task: null, comments: [] };
		}
	}

	#boardUrl(): string {
		const localUrl = this.#server?.localUrl;
		if (!localUrl) throw new Error("Kanban runtime is not running");
		return `${localUrl}kanban/${encodeURIComponent(this.#options.boardId)}`;
	}

	/** Same board, addressed over this host's tailnet so phones and laptops on it can open it. */
	#tailnetBoardUrls(): string[] {
		return (this.#server?.tailnetUrls ?? []).map(
			root => `${root}kanban/${encodeURIComponent(this.#options.boardId)}`,
		);
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

/** The assignee an event routes to, read from whichever task shape it carries. */
function assigneeOf(activity: KanbanActivity): string | null {
	const task = activity.data.task;
	if (!task || typeof task !== "object" || !("assignee" in task)) return null;
	const assignee = task.assignee;
	return typeof assignee === "string" && assignee.length > 0 ? assignee : null;
}
