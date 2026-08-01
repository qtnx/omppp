import {
	isKanbanActivityType,
	isKanbanPriority,
	isKanbanStatus,
	isRecord,
	type KanbanActivity,
	type KanbanBoardSnapshot,
	type KanbanComment,
	type KanbanTask,
} from "./types";

export class KanbanProtocolError extends Error {
	readonly code = "invalid_response";

	constructor(message: string) {
		super(message);
		this.name = "KanbanProtocolError";
	}
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new KanbanProtocolError(`Kanban ${key} must be a string`);
	return value;
}

function requireNullableString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (value !== null && typeof value !== "string") {
		throw new KanbanProtocolError(`Kanban ${key} must be a string or null`);
	}
	return value;
}

function requireNonnegativeInteger(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (!Number.isInteger(value) || Number(value) < 0) {
		throw new KanbanProtocolError(`Kanban ${key} must be a nonnegative integer`);
	}
	return Number(value);
}

function requireStringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		throw new KanbanProtocolError(`Kanban ${key} must be an array of strings`);
	}
	return [...value];
}

export function parseKanbanTask(value: unknown): KanbanTask {
	if (!isRecord(value)) throw new KanbanProtocolError("Kanban task must be an object");
	if (!isKanbanStatus(value.status)) throw new KanbanProtocolError("Kanban task status is invalid");
	if (!isKanbanPriority(value.priority)) throw new KanbanProtocolError("Kanban task priority is invalid");

	return {
		id: requireString(value, "id"),
		sessionId: requireString(value, "sessionId"),
		status: value.status,
		position: requireNonnegativeInteger(value, "position"),
		title: requireString(value, "title"),
		description: requireNullableString(value, "description"),
		assignee: requireNullableString(value, "assignee"),
		labels: requireStringArray(value, "labels"),
		dueAt: requireNullableString(value, "dueAt"),
		repo: requireNullableString(value, "repo"),
		worktree: requireNullableString(value, "worktree"),
		branch: requireNullableString(value, "branch"),
		acceptanceCriteria: requireStringArray(value, "acceptanceCriteria"),
		blockerReason: requireNullableString(value, "blockerReason"),
		priority: value.priority,
		version: requireNonnegativeInteger(value, "version"),
		createdAt: requireString(value, "createdAt"),
		updatedAt: requireString(value, "updatedAt"),
	};
}

export function parseKanbanComment(value: unknown): KanbanComment {
	if (!isRecord(value)) throw new KanbanProtocolError("Kanban comment must be an object");
	return {
		id: requireString(value, "id"),
		taskId: requireString(value, "taskId"),
		author: requireString(value, "author"),
		body: requireString(value, "body"),
		version: requireNonnegativeInteger(value, "version"),
		createdAt: requireString(value, "createdAt"),
		editedAt: requireNullableString(value, "editedAt"),
		deletedAt: requireNullableString(value, "deletedAt"),
	};
}

export function parseKanbanEvent(value: unknown): KanbanActivity {
	if (!isRecord(value)) throw new KanbanProtocolError("Kanban event must be an object");
	if (!Number.isInteger(value.cursor) || Number(value.cursor) < 0) {
		throw new KanbanProtocolError("Kanban event cursor must be a nonnegative integer");
	}
	if (!isKanbanActivityType(value.type)) throw new KanbanProtocolError("Kanban event type is invalid");
	if (!isRecord(value.data)) throw new KanbanProtocolError("Kanban event data must be an object");

	const taskId = value.taskId;
	if (taskId !== null && typeof taskId !== "string") {
		throw new KanbanProtocolError("Kanban event taskId must be a string or null");
	}

	return {
		id: requireString(value, "id"),
		cursor: Number(value.cursor),
		sessionId: requireString(value, "sessionId"),
		taskId,
		type: value.type,
		createdAt: requireString(value, "createdAt"),
		data: { ...value.data },
	};
}

export interface RealtimeState {
	cursor: number;
	activity: KanbanActivity[];
	reloadRequired: boolean;
}

export function createRealtimeState(cursor: number): RealtimeState {
	if (!Number.isInteger(cursor) || cursor < 0) {
		throw new KanbanProtocolError("Kanban cursor must be a nonnegative integer");
	}
	return { cursor, activity: [], reloadRequired: false };
}

export function applyRealtimeEvent(state: RealtimeState, event: KanbanActivity): RealtimeState {
	if (event.cursor <= state.cursor) return state;
	return {
		cursor: event.cursor,
		activity: [...state.activity, event],
		reloadRequired: true,
	};
}

export function parseBoardSnapshot(value: unknown): KanbanBoardSnapshot {
	if (!isRecord(value)) throw new KanbanProtocolError("Kanban board must be an object");
	if (!Array.isArray(value.tasks)) throw new KanbanProtocolError("Kanban board tasks must be an array");
	const rawActivity = value.activity ?? value.events;
	if (!Array.isArray(rawActivity)) throw new KanbanProtocolError("Kanban board activity must be an array");
	if (!Number.isInteger(value.cursor) || Number(value.cursor) < 0) {
		throw new KanbanProtocolError("Kanban board cursor must be a nonnegative integer");
	}

	return {
		tasks: value.tasks.map(parseKanbanTask),
		activity: rawActivity.map(parseKanbanEvent),
		cursor: Number(value.cursor),
	};
}

export interface MutationFailureResolution {
	kind: "conflict" | "error";
	reloadRequired: boolean;
	announcement: string;
}

export function classifyMutationFailure(error: unknown): MutationFailureResolution {
	const candidate = isRecord(error) ? error : {};
	const status = candidate.status;
	const code = candidate.code;
	const message = typeof candidate.message === "string" && candidate.message.length > 0 ? candidate.message : null;
	if (status === 409 || code === "version_conflict") {
		return {
			kind: "conflict",
			reloadRequired: true,
			announcement: `${message ?? "This task changed elsewhere."} The latest board has been loaded.`,
		};
	}
	return {
		kind: "error",
		reloadRequired: false,
		announcement: message ?? "Couldn't save the change. Try again.",
	};
}
