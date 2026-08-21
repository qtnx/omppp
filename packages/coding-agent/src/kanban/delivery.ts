import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { YieldQueue } from "../session/yield-queue";
import agentTemplate from "./kanban-agent.md" with { type: "text" };
import briefingTemplate from "./kanban-briefing.md" with { type: "text" };
import eventTemplate from "./kanban-event.md" with { type: "text" };
import type { KanbanActivity, KanbanComment, KanbanTask } from "./types";

const URGENT_UPDATE_FIELDS: Readonly<Record<string, true>> = {
	assignee: true,
	description: true,
};

export interface KanbanCustomMessagePayload {
	customType: "kanban-event";
	content: string;
	display: true;
	details: { eventIds: string[]; cursors: number[] };
	attribution: "user";
}

export interface KanbanPromptOptions {
	streamingBehavior: "followUp";
	queueOnly: true;
}

export interface KanbanForkRequest {
	taskId: string;
	work: string;
}

export interface KanbanForkedAgent {
	readonly id: string;
	readonly settled: Promise<void>;
	send(work: string): Promise<boolean>;
	cancel(): void;
}

export interface KanbanSessionPort {
	readonly sessionId: string;
	readonly isStreaming: boolean;
	readonly yieldQueue: Pick<YieldQueue, "register" | "enqueue">;
	promptCustomMessage(message: KanbanCustomMessagePayload, options: KanbanPromptOptions): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	/**
	 * Starts a background worker for board work. Missing in SDK and
	 * non-interactive sessions, where delivery retains its steering fallback.
	 */
	forkBoardAgent?(request: KanbanForkRequest): Promise<KanbanForkedAgent | null>;
	onKanbanEventsDurable(listener: (eventIds: readonly string[]) => void): () => void;
	/** Publishes the board briefing as a system-prompt section; `null` clears it. */
	setKanbanBriefing(section: string | null): void;
	hasDurableKanbanEvent(eventId: string): boolean;
}

function stringifyUntrustedEventJson(value: unknown): string {
	return JSON.stringify(value, null, 2)
		.replaceAll("&", "\\u0026")
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("```", "\\u0060\\u0060\\u0060");
}

function buildEventMessage(events: KanbanActivity[]): AgentMessage | null {
	if (events.length === 0) return null;
	const payload = events.length === 1 ? events[0] : events;
	return {
		role: "custom",
		customType: "kanban-event",
		content: prompt.render(eventTemplate, { event_json: stringifyUntrustedEventJson(payload) }),
		display: true,
		details: { eventIds: events.map(event => event.id), cursors: events.map(event => event.cursor) },
		attribution: "user",
		timestamp: Date.now(),
	};
}

function taskData(event: KanbanActivity): Record<string, unknown> | null {
	const task = event.data.task;
	return task && typeof task === "object" && !Array.isArray(task) ? (task as Record<string, unknown>) : null;
}

/**
 * Which board changes interrupt the session instead of waiting for its next
 * idle turn: the ones that are an instruction — a new idea to refine, a
 * go-ahead, a block, or a human talking to the agent in a comment.
 */
function requiresSteering(event: KanbanActivity): boolean {
	const task = taskData(event);
	if (task?.status === "blocked" || task?.status === "cancelled") return true;
	if (event.type === "task.created") return true;
	if (event.type === "task.moved") return task?.status === "ready";
	if (event.type !== "task.updated") return false;
	const changedFields = event.data.changedFields;
	return (
		Array.isArray(changedFields) &&
		changedFields.some(field => typeof field === "string" && URGENT_UPDATE_FIELDS[field])
	);
}

interface KanbanDeliveryOptions {
	task?: KanbanTask | Record<string, unknown> | null;
	comments?: readonly KanbanComment[];
	onAgentDispatched?: (eventId: string) => void;
}

interface ForkReceipt {
	session: KanbanSessionPort;
	event: KanbanActivity;
	onAgentDispatched?: (eventId: string) => void;
}

interface QueuedBoardFork {
	key: string;
	session: KanbanSessionPort;
	request: KanbanForkRequest;
	receipts: ForkReceipt[];
}

interface LiveBoardAgent {
	session: KanbanSessionPort;
	agent: KanbanForkedAgent;
	readonly forwardedEventResults: Map<string, Promise<boolean>>;
}

const MAX_CONCURRENT_BOARD_AGENTS = 3;

function boardAgentKey(event: KanbanActivity): string | null {
	return event.taskId ? `${event.boardId}:${event.taskId}` : null;
}

/**
 * A comment is NOT forkable on its own. Forking one would answer the operator
 * from a stranger agent while the session that actually holds the task sits
 * there silent — worse, it would spawn a second worker on a task someone is
 * already implementing. Comments only reach a background agent that is ALREADY
 * carrying that task, which `deliver` checks separately.
 */
function isForkableBoardEvent(event: KanbanActivity, task: KanbanTask | Record<string, unknown> | null): boolean {
	if (!event.taskId) return false;
	if (event.type === "task.created") return task?.status === "backlog";
	return event.type === "task.moved" && (task?.status === "backlog" || task?.status === "ready");
}

function isSilentTerminalTaskEvent(event: KanbanActivity, task: KanbanTask | Record<string, unknown> | null): boolean {
	return (
		(event.type === "task.created" || event.type === "task.moved") &&
		(task?.status === "done" || task?.status === "cancelled")
	);
}

function buildBoardAgentWork(
	event: KanbanActivity,
	task: KanbanTask | Record<string, unknown> | null,
	comments: readonly KanbanComment[],
): string {
	return prompt.render(agentTemplate, {
		event_json: stringifyUntrustedEventJson(event),
		task_json: stringifyUntrustedEventJson(task),
		comment_history_json: stringifyUntrustedEventJson(comments),
	});
}

export class KanbanSessionDelivery {
	readonly #unregister = new Map<KanbanSessionPort, () => void>();
	readonly #agents = new Map<string, LiveBoardAgent>();
	readonly #queuedByTask = new Map<string, QueuedBoardFork>();
	#queue: QueuedBoardFork[] = [];
	#runningAgentCount = 0;
	#draining = false;

	register(session: KanbanSessionPort): void {
		if (this.#unregister.has(session)) return;
		const unregister = session.yieldQueue.register<KanbanActivity>("kanban-event", {
			build: buildEventMessage,
		});
		this.#unregister.set(session, unregister);
	}

	unregister(session: KanbanSessionPort): void {
		this.#unregister.get(session)?.();
		this.#unregister.delete(session);
		for (const [key, agent] of this.#agents) {
			if (agent.session === session) this.#removeAgent(key, agent);
		}
		this.#queue = this.#queue.filter(entry => {
			if (entry.session !== session) return true;
			this.#queuedByTask.delete(entry.key);
			return false;
		});
	}

	clear(): void {
		for (const unregister of this.#unregister.values()) unregister();
		this.#unregister.clear();
		this.#agents.clear();
		this.#queuedByTask.clear();
		this.#queue = [];
		this.#runningAgentCount = 0;
	}

	/**
	 * Renders the board briefing that the session publishes as a system-prompt
	 * section. It must not be a chat message: compaction would drop it and the
	 * agent would forget the workflow mid-session.
	 */
	briefing(boardUrl: string, sessionName: string): string {
		return prompt.render(briefingTemplate, { board_url: boardUrl, session_name: sessionName });
	}

	async deliver(
		session: KanbanSessionPort,
		event: KanbanActivity,
		options: KanbanDeliveryOptions = {},
	): Promise<void> {
		const task = taskData(event) ?? options.task ?? null;
		const taskId = event.taskId;
		const key = boardAgentKey(event);
		if (isSilentTerminalTaskEvent(event, task)) {
			if (key) this.#releaseTerminalTask(key);
			if (task?.status === "cancelled" && !session.forkBoardAgent) {
				await this.#deliverToSession(session, event);
				return;
			}
			options.onAgentDispatched?.(event.id);
			return;
		}
		const liveAgent = key ? this.#agents.get(key) : undefined;
		const queuedForTask = key ? this.#queuedByTask.get(key) : undefined;
		// A comment rides along only when this task is already being carried in the
		// background; otherwise it belongs to whoever owns the task right now.
		const commentForLiveAgent =
			event.type === "comment.created" && (liveAgent !== undefined || queuedForTask !== undefined);
		if (!session.forkBoardAgent || !key || !taskId || !(commentForLiveAgent || isForkableBoardEvent(event, task))) {
			await this.#deliverToSession(session, event);
			return;
		}

		const request: KanbanForkRequest = {
			taskId,
			work: buildBoardAgentWork(event, task, options.comments ?? []),
		};
		if (
			liveAgent &&
			(event.type === "comment.created" || (event.type === "task.moved" && task?.status === "ready"))
		) {
			let forwarded = liveAgent.forwardedEventResults.get(event.id);
			if (!forwarded) {
				forwarded = (async () => {
					try {
						return await liveAgent.agent.send(request.work);
					} catch {
						return false;
					}
				})();
				liveAgent.forwardedEventResults.set(event.id, forwarded);
			}
			if (await forwarded) {
				options.onAgentDispatched?.(event.id);
				return;
			}
			if (liveAgent.forwardedEventResults.get(event.id) === forwarded) {
				liveAgent.forwardedEventResults.delete(event.id);
			}
			this.#removeAgent(key, liveAgent);
		} else if (liveAgent) {
			options.onAgentDispatched?.(event.id);
			return;
		}

		await this.#enqueueBoardFork({
			key,
			session,
			request,
			receipts: [{ session, event, onAgentDispatched: options.onAgentDispatched }],
		});
	}

	async #enqueueBoardFork(entry: QueuedBoardFork): Promise<void> {
		const queued = this.#queuedByTask.get(entry.key);
		if (queued) {
			queued.request = entry.request;
			queued.receipts.push(...entry.receipts);
			return;
		}
		this.#queuedByTask.set(entry.key, entry);
		this.#queue.push(entry);
		await this.#drainBoardForks();
	}

	async #drainBoardForks(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		try {
			while (this.#runningAgentCount < MAX_CONCURRENT_BOARD_AGENTS) {
				const entry = this.#queue.shift();
				if (!entry) return;
				if (this.#queuedByTask.get(entry.key) !== entry) continue;

				const fork = entry.session.forkBoardAgent;
				if (!fork) {
					this.#queuedByTask.delete(entry.key);
					await this.#fallBackToSession(entry);
					continue;
				}

				const initialWork = entry.request.work;
				let agent: KanbanForkedAgent | null = null;
				try {
					agent = await fork(entry.request);
				} catch {
					agent = null;
				}
				if (!agent) {
					this.#queuedByTask.delete(entry.key);
					await this.#fallBackToSession(entry);
					continue;
				}

				this.#queuedByTask.delete(entry.key);
				const liveAgent: LiveBoardAgent = {
					session: entry.session,
					agent,
					forwardedEventResults: new Map<string, Promise<boolean>>(),
				};
				this.#agents.set(entry.key, liveAgent);
				this.#runningAgentCount++;
				this.#announceBoardAgent(entry);
				if (entry.request.work !== initialWork) {
					try {
						await agent.send(entry.request.work);
					} catch {
						// The initial task brief remains valid if the added context races shutdown.
					}
				}
				for (const receipt of entry.receipts) receipt.onAgentDispatched?.(receipt.event.id);
				void agent.settled.then(
					() => this.#removeAgent(entry.key, liveAgent),
					() => this.#removeAgent(entry.key, liveAgent),
				);
			}
		} finally {
			this.#draining = false;
			if (this.#queue.length > 0 && this.#runningAgentCount < MAX_CONCURRENT_BOARD_AGENTS) {
				void this.#drainBoardForks();
			}
		}
	}

	#announceBoardAgent(entry: QueuedBoardFork): void {
		for (const session of new Set(entry.receipts.map(receipt => receipt.session))) {
			session.emitNotice("info", "Kanban background agent dispatched.", "kanban");
		}
	}

	#removeAgent(key: string, agent: LiveBoardAgent): void {
		if (this.#agents.get(key) !== agent) return;
		this.#agents.delete(key);
		this.#runningAgentCount = Math.max(0, this.#runningAgentCount - 1);
		void this.#drainBoardForks();
	}

	#releaseTerminalTask(key: string): void {
		const queued = this.#queuedByTask.get(key);
		if (queued) {
			this.#queuedByTask.delete(key);
			for (const receipt of queued.receipts) receipt.onAgentDispatched?.(receipt.event.id);
		}
		const liveAgent = this.#agents.get(key);
		if (!liveAgent) return;
		liveAgent.agent.cancel();
		this.#removeAgent(key, liveAgent);
	}

	async #fallBackToSession(entry: QueuedBoardFork): Promise<void> {
		for (const receipt of entry.receipts) await this.#deliverToSession(receipt.session, receipt.event);
	}

	async #deliverToSession(session: KanbanSessionPort, event: KanbanActivity): Promise<void> {
		if (requiresSteering(event)) {
			const message = buildEventMessage([event]);
			if (message?.role !== "custom") return;
			await session.promptCustomMessage(
				{
					customType: "kanban-event",
					content: typeof message.content === "string" ? message.content : "",
					display: true,
					details: { eventIds: [event.id], cursors: [event.cursor] },
					attribution: "user",
				},
				{ streamingBehavior: "followUp", queueOnly: true },
			);
			return;
		}
		session.yieldQueue.enqueue("kanban-event", event);
	}
}
