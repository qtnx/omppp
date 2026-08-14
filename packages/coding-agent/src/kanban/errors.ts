export class KanbanError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "KanbanError";
	}
}

export function notFound(entity: "Task" | "Comment" | "Session"): KanbanError {
	return new KanbanError(404, "not_found", `${entity} not found`);
}

export function versionConflict(): KanbanError {
	return new KanbanError(409, "version_conflict", "The resource changed since it was loaded");
}
