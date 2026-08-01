import type { KanbanPriority, KanbanStatus, KanbanTask, KanbanTaskDraft, KanbanTaskUpdate } from "./types";

export interface TaskFormValues {
	title: string;
	status: KanbanStatus;
	priority: KanbanPriority;
	description: string;
	assignee: string;
	labels: string;
	dueAt: string;
	repo: string;
	worktree: string;
	branch: string;
	acceptanceCriteria: string;
	blockerReason: string;
}

export type TaskFormField = keyof TaskFormValues;
export type TaskFormErrors = Partial<Record<TaskFormField, string>>;

export interface ValidTaskForm {
	values: TaskFormValues;
	create: KanbanTaskDraft;
	updateFields: Omit<KanbanTaskUpdate, "expectedVersion">;
}

function localDateTime(iso: string | null): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const offset = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function taskToFormValues(task: KanbanTask | null, defaultStatus: KanbanStatus): TaskFormValues {
	return {
		title: task?.title ?? "",
		status: task?.status ?? defaultStatus,
		priority: task?.priority ?? "medium",
		description: task?.description ?? "",
		assignee: task?.assignee ?? "",
		labels: task?.labels.join(", ") ?? "",
		dueAt: localDateTime(task?.dueAt ?? null),
		repo: task?.repo ?? "",
		worktree: task?.worktree ?? "",
		branch: task?.branch ?? "",
		acceptanceCriteria: task?.acceptanceCriteria.join("\n") ?? "",
		blockerReason: task?.blockerReason ?? "",
	};
}

function optionalTrimmed(value: string): string | null {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function splitList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map(item => item.trim())
		.filter(item => item.length > 0);
}

export function validateTaskForm(values: TaskFormValues): { errors: TaskFormErrors; valid: ValidTaskForm | null } {
	const errors: TaskFormErrors = {};
	const title = values.title.trim();
	if (title.length === 0) errors.title = "Enter a task title.";
	else if (title.length > 200) errors.title = "Keep the title to 200 characters or fewer.";
	if (values.description.length > 20_000) errors.description = "Keep the description to 20,000 characters or fewer.";
	if (values.assignee.length > 128) errors.assignee = "Keep the assignee to 128 characters or fewer.";
	if (values.blockerReason.length > 2_000)
		errors.blockerReason = "Keep the blocker reason to 2,000 characters or fewer.";

	for (const field of ["repo", "worktree", "branch"] as const) {
		if (values[field].length > 4_096) errors[field] = `Keep ${field} to 4,096 characters or fewer.`;
	}

	const labels = splitList(values.labels);
	if (labels.length > 20) errors.labels = "Use no more than 20 labels.";
	else if (labels.some(label => label.length > 64)) errors.labels = "Keep each label to 64 characters or fewer.";

	const acceptanceCriteria = values.acceptanceCriteria
		.split("\n")
		.map(item => item.trim())
		.filter(item => item.length > 0);
	if (acceptanceCriteria.length > 50) errors.acceptanceCriteria = "Use no more than 50 acceptance criteria.";
	else if (acceptanceCriteria.some(item => item.length > 1_000)) {
		errors.acceptanceCriteria = "Keep each acceptance criterion to 1,000 characters or fewer.";
	}

	let dueAt: string | null = null;
	if (values.dueAt.length > 0) {
		const due = new Date(values.dueAt);
		if (Number.isNaN(due.getTime())) errors.dueAt = "Enter a valid due date and time.";
		else dueAt = due.toISOString();
	}

	if (Object.keys(errors).length > 0) return { errors, valid: null };
	const updateFields: Omit<KanbanTaskUpdate, "expectedVersion"> = {
		title,
		description: optionalTrimmed(values.description),
		assignee: optionalTrimmed(values.assignee),
		labels,
		dueAt,
		repo: optionalTrimmed(values.repo),
		worktree: optionalTrimmed(values.worktree),
		branch: optionalTrimmed(values.branch),
		acceptanceCriteria,
		blockerReason: optionalTrimmed(values.blockerReason),
		priority: values.priority,
	};
	return {
		errors,
		valid: {
			values,
			create: { ...updateFields, status: values.status },
			updateFields,
		},
	};
}
