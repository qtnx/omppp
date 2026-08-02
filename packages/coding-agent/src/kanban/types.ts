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
	sessionId: string;
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
	sessionId: string;
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

export interface KanbanTaskCreate {
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
	title?: string;
	description?: string | null;
	assignee?: string | null;
	labels?: string[];
	dueAt?: string | null;
	priority?: KanbanPriority;
}

export interface KanbanMove {
	expectedVersion: number;
	status: KanbanStatus;
	index: number;
}

export interface KanbanCommentCreate {
	author: string;
	body: string;
}

export interface KanbanCommentUpdate {
	expectedVersion: number;
	body: string;
}

export interface KanbanExpectedVersion {
	expectedVersion: number;
}

export interface KanbanMutation<T> {
	status: number;
	data: T;
	activity: KanbanActivity | null;
	replayed: boolean;
}

/** Metadata for a board image; `bytes` stays out of JSON responses. */
export interface KanbanAttachment {
	id: string;
	sessionId: string;
	filename: string;
	contentType: string;
	size: number;
	createdAt: string;
}

export interface KanbanAttachmentBody extends KanbanAttachment {
	bytes: Uint8Array;
}

export interface KanbanAttachmentCreate {
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}
