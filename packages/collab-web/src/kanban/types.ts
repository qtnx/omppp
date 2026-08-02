export const KANBAN_STATUSES = ["backlog", "ready", "in_progress", "blocked", "review", "done", "cancelled"] as const;

export type KanbanStatus = (typeof KANBAN_STATUSES)[number];

export const KANBAN_PRIORITIES = ["lowest", "low", "medium", "high", "highest"] as const;

export type KanbanPriority = (typeof KANBAN_PRIORITIES)[number];

export const KANBAN_ACTIVITY_TYPES = [
	"task.created",
	"task.updated",
	"task.deleted",
	"task.moved",
	"comment.created",
	"comment.updated",
	"comment.deleted",
] as const;

export type KanbanActivityType = (typeof KANBAN_ACTIVITY_TYPES)[number];

export interface KanbanTask {
	id: string;
	boardId: string;
	status: KanbanStatus;
	position: number;
	title: string;
	description: string | null;
	assignee: string | null;
	labels: string[];
	dueAt: string | null;
	priority: KanbanPriority;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface KanbanComment {
	id: string;
	taskId: string;
	author: string;
	body: string;
	version: number;
	createdAt: string;
	editedAt: string | null;
	deletedAt: string | null;
}

export interface KanbanActivity {
	id: string;
	cursor: number;
	boardId: string;
	taskId: string | null;
	type: KanbanActivityType;
	createdAt: string;
	data: Record<string, unknown>;
}

export interface KanbanBoardSnapshot {
	tasks: KanbanTask[];
	activity: KanbanActivity[];
	cursor: number;
}

export type KanbanConnectionState = "loading" | "connected" | "reconnecting" | "disconnected";

export interface KanbanTaskDraft {
	title: string;
	status: KanbanStatus;
	priority: KanbanPriority;
	description?: string | null;
	assignee?: string | null;
	labels?: string[];
	dueAt?: string | null;
}

export interface KanbanTaskUpdate {
	expectedVersion: number;
	title: string;
	description: string | null;
	assignee: string | null;
	labels: string[];
	dueAt: string | null;
	priority: KanbanPriority;
}

export interface KanbanMoveRequest {
	expectedVersion: number;
	status: KanbanStatus;
	index: number;
}

export interface KanbanCommentDraft {
	/** Omitted by the board: the server stamps "user" for browser comments. */
	author?: string;
	body: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isKanbanStatus(value: unknown): value is KanbanStatus {
	return typeof value === "string" && (KANBAN_STATUSES as readonly string[]).includes(value);
}

export function isKanbanPriority(value: unknown): value is KanbanPriority {
	return typeof value === "string" && (KANBAN_PRIORITIES as readonly string[]).includes(value);
}

export function isKanbanActivityType(value: unknown): value is KanbanActivityType {
	return typeof value === "string" && (KANBAN_ACTIVITY_TYPES as readonly string[]).includes(value);
}

/** A live OMPx session sharing this board; `name` is the assignee value. */
export interface KanbanBoardSession {
	sessionId: string;
	name: string;
	createdAt: string;
	lastSeenAt: string;
}
