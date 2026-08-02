import { KanbanError } from "./errors";
import {
	KANBAN_PRIORITIES,
	KANBAN_STATUSES,
	type KanbanCommentCreate,
	type KanbanCommentUpdate,
	type KanbanExpectedVersion,
	type KanbanMove,
	type KanbanPriority,
	type KanbanStatus,
	type KanbanTaskCreate,
	type KanbanTaskUpdate,
} from "./types";

const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const TASK_CREATE_FIELDS = ["title", "status", "priority", "description", "assignee", "labels", "dueAt"] as const;
const TASK_UPDATE_FIELDS = [
	"expectedVersion",
	"title",
	"description",
	"assignee",
	"labels",
	"dueAt",
	"priority",
] as const;

function validationError(message: string, details?: unknown): KanbanError {
	return new KanbanError(422, "validation_error", message, details);
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw validationError("Request body must be an object");
	return value as Record<string, unknown>;
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[]): void {
	const allowedFields = new Set(allowed);
	const unknown = Object.keys(input).filter(key => !allowedFields.has(key));
	if (unknown.length > 0) throw validationError("Request contains unknown fields", { fields: unknown.sort() });
}

function requiredString(input: Record<string, unknown>, key: string, max: number): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim().length === 0) {
		throw validationError(`${key} must be a non-empty string of at most ${max} characters`);
	}
	return value;
}

function optionalNullableString(input: Record<string, unknown>, key: string, max: number): string | null | undefined {
	if (!Object.hasOwn(input, key)) return undefined;
	const value = input[key];
	if (value === null) return null;
	if (typeof value !== "string" || value.length > max) {
		throw validationError(`${key} must be null or a string of at most ${max} characters`);
	}
	return value;
}

function stringArray(
	input: Record<string, unknown>,
	key: string,
	maxItems: number,
	maxItemLength: number,
): string[] | undefined {
	if (!Object.hasOwn(input, key)) return undefined;
	const value = input[key];
	if (!Array.isArray(value) || value.length > maxItems) {
		throw validationError(`${key} must be an array with at most ${maxItems} items`);
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || item.length === 0 || item.length > maxItemLength || item.trim().length === 0) {
			throw validationError(`${key} entries must be non-empty strings of at most ${maxItemLength} characters`);
		}
		if (seen.has(item)) throw validationError(`${key} entries must be unique`);
		seen.add(item);
		result.push(item);
	}
	return result;
}

function status(value: unknown): KanbanStatus {
	if (typeof value !== "string" || !(KANBAN_STATUSES as readonly string[]).includes(value)) {
		throw validationError("status is invalid");
	}
	return value as KanbanStatus;
}

function priority(value: unknown): KanbanPriority {
	if (typeof value !== "string" || !(KANBAN_PRIORITIES as readonly string[]).includes(value)) {
		throw validationError("priority is invalid");
	}
	return value as KanbanPriority;
}

function expectedVersion(input: Record<string, unknown>): number {
	const value = input.expectedVersion;
	if (!Number.isInteger(value) || Number(value) < 1)
		throw validationError("expectedVersion must be a positive integer");
	return Number(value);
}

function dueAt(input: Record<string, unknown>): string | null | undefined {
	const value = optionalNullableString(input, "dueAt", 64);
	if (value === undefined || value === null) return value;
	const match = RFC3339_UTC.exec(value);
	const timestamp = Date.parse(value);
	if (!match || !Number.isFinite(timestamp)) {
		throw validationError("dueAt must be an RFC3339 UTC timestamp or null");
	}
	const date = new Date(timestamp);
	const components = match.slice(1, 7).map(Number);
	if (
		date.getUTCFullYear() !== components[0] ||
		date.getUTCMonth() + 1 !== components[1] ||
		date.getUTCDate() !== components[2] ||
		date.getUTCHours() !== components[3] ||
		date.getUTCMinutes() !== components[4] ||
		date.getUTCSeconds() !== components[5]
	) {
		throw validationError("dueAt must be an RFC3339 UTC timestamp or null");
	}
	return value;
}

export function validateTaskCreate(value: unknown): KanbanTaskCreate {
	const input = record(value);
	rejectUnknown(input, TASK_CREATE_FIELDS);
	if (!Object.hasOwn(input, "status")) throw validationError("status is required");
	if (!Object.hasOwn(input, "priority")) throw validationError("priority is required");
	return {
		title: requiredString(input, "title", 200),
		status: status(input.status),
		priority: priority(input.priority),
		description: optionalNullableString(input, "description", 20_000),
		assignee: optionalNullableString(input, "assignee", 128),
		labels: stringArray(input, "labels", 20, 64),
		dueAt: dueAt(input),
	};
}

export function validateTaskUpdate(value: unknown): KanbanTaskUpdate {
	const input = record(value);
	rejectUnknown(input, TASK_UPDATE_FIELDS);
	if (Object.keys(input).every(key => key === "expectedVersion")) {
		throw validationError("Task update must change at least one field");
	}
	const update: KanbanTaskUpdate = { expectedVersion: expectedVersion(input) };
	if (Object.hasOwn(input, "title")) update.title = requiredString(input, "title", 200);
	if (Object.hasOwn(input, "description")) update.description = optionalNullableString(input, "description", 20_000);
	if (Object.hasOwn(input, "assignee")) update.assignee = optionalNullableString(input, "assignee", 128);
	if (Object.hasOwn(input, "labels")) update.labels = stringArray(input, "labels", 20, 64);
	if (Object.hasOwn(input, "dueAt")) update.dueAt = dueAt(input);
	if (Object.hasOwn(input, "priority")) update.priority = priority(input.priority);
	return update;
}

export function validateMove(value: unknown): KanbanMove {
	const input = record(value);
	rejectUnknown(input, ["expectedVersion", "status", "index"]);
	const index = input.index;
	if (!Number.isInteger(index) || Number(index) < 0) throw validationError("index must be a nonnegative integer");
	return { expectedVersion: expectedVersion(input), status: status(input.status), index: Number(index) };
}

export function validateCommentCreate(value: unknown): KanbanCommentCreate {
	const input = record(value);
	rejectUnknown(input, ["author", "body"]);
	return { author: requiredString(input, "author", 64), body: requiredString(input, "body", 10_000) };
}

export function validateCommentUpdate(value: unknown): KanbanCommentUpdate {
	const input = record(value);
	rejectUnknown(input, ["expectedVersion", "body"]);
	return { expectedVersion: expectedVersion(input), body: requiredString(input, "body", 10_000) };
}

export function validateExpectedVersion(value: unknown): KanbanExpectedVersion {
	const input = record(value);
	rejectUnknown(input, ["expectedVersion"]);
	return { expectedVersion: expectedVersion(input) };
}
