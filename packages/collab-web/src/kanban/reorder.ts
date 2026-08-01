import type { KanbanStatus, KanbanTask } from "./types";

export interface MoveDestination {
	status: KanbanStatus;
	index: number;
}

export function calculateMoveDestination(
	tasks: readonly KanbanTask[],
	taskId: string,
	status: KanbanStatus,
	requestedIndex: number,
): MoveDestination {
	const moving = tasks.find(task => task.id === taskId);
	if (!moving) throw new Error(`Unknown Kanban task: ${taskId}`);
	if (!Number.isFinite(requestedIndex)) throw new Error("Kanban move index must be finite");

	const targetLength = tasks.filter(task => task.status === status && task.id !== taskId).length;
	return {
		status,
		index: Math.max(0, Math.min(targetLength, Math.trunc(requestedIndex))),
	};
}

export function projectKeyboardMove(
	tasks: readonly KanbanTask[],
	taskId: string,
	statusOrder: readonly KanbanStatus[],
	current: MoveDestination,
	direction: "up" | "down" | "left" | "right",
): MoveDestination {
	if (direction === "up" || direction === "down") {
		return calculateMoveDestination(tasks, taskId, current.status, current.index + (direction === "up" ? -1 : 1));
	}

	const currentColumn = statusOrder.indexOf(current.status);
	const nextColumn = Math.max(0, Math.min(statusOrder.length - 1, currentColumn + (direction === "left" ? -1 : 1)));
	return calculateMoveDestination(tasks, taskId, statusOrder[nextColumn], current.index);
}
