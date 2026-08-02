import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { YieldQueue } from "../session/yield-queue";
import briefingTemplate from "./kanban-briefing.md" with { type: "text" };
import eventTemplate from "./kanban-event.md" with { type: "text" };
import type { KanbanActivity } from "./types";

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
	streamingBehavior: "steer";
	queueOnly: true;
}

export interface KanbanSessionPort {
	readonly sessionId: string;
	readonly isStreaming: boolean;
	readonly yieldQueue: Pick<YieldQueue, "register" | "enqueue">;
	promptCustomMessage(message: KanbanCustomMessagePayload, options: KanbanPromptOptions): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	onKanbanEventsDurable(listener: (eventIds: readonly string[]) => void): () => void;
	/** Publishes the board briefing as a system-prompt section; `null` clears it. */
	setKanbanBriefing(section: string | null): void;
	hasDurableKanbanEvent(eventId: string): boolean;
}

function stringifyUntrustedEventJson(value: KanbanActivity | KanbanActivity[]): string {
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

export class KanbanSessionDelivery {
	readonly #unregister = new Map<KanbanSessionPort, () => void>();

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
	}

	clear(): void {
		for (const unregister of this.#unregister.values()) unregister();
		this.#unregister.clear();
	}

	/**
	 * Renders the board briefing that the session publishes as a system-prompt
	 * section. It must not be a chat message: compaction would drop it and the
	 * agent would forget the workflow mid-session.
	 */
	briefing(boardUrl: string, sessionName: string): string {
		return prompt.render(briefingTemplate, { board_url: boardUrl, session_name: sessionName });
	}

	async deliver(session: KanbanSessionPort, event: KanbanActivity): Promise<void> {
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
				{ streamingBehavior: "steer", queueOnly: true },
			);
			return;
		}
		session.yieldQueue.enqueue("kanban-event", event);
	}
}
