import { type FormEvent, type ReactNode, useId, useState } from "react";
import type { KanbanApi } from "./api";
import { DescriptionEditor } from "./DescriptionEditor";
import {
	type TaskFormErrors,
	type TaskFormField,
	type TaskFormValues,
	taskToFormValues,
	type ValidTaskForm,
	validateTaskForm,
} from "./task-form";
import { KANBAN_PRIORITIES, KANBAN_STATUSES, type KanbanStatus, type KanbanTask } from "./types";
import { PRIORITY_LABELS, STATUS_LABELS } from "./view-model";

interface TaskFormProps {
	task: KanbanTask | null;
	defaultStatus: KanbanStatus;
	busy: boolean;
	canWrite: boolean;
	serverError: string | null;
	api: KanbanApi | null;
	onSubmit(valid: ValidTaskForm): Promise<void>;
	onCancel(): void;
}

interface FieldProps {
	label: string;
	field: TaskFormField;
	errors: TaskFormErrors;
	helper?: string;
	children: ReactNode;
}

function Field({ label, field, errors, helper, children }: FieldProps) {
	const error = errors[field];
	return (
		<div className="kb-field">
			<label htmlFor={`kb-task-${field}`}>{label}</label>
			{children}
			{helper && !error ? (
				<p id={`kb-task-${field}-help`} className="kb-field-help">
					{helper}
				</p>
			) : null}
			{error ? (
				<p id={`kb-task-${field}-error`} className="kb-field-error">
					{error}
				</p>
			) : null}
		</div>
	);
}

export function TaskForm({ task, defaultStatus, busy, canWrite, serverError, api, onSubmit, onCancel }: TaskFormProps) {
	const formId = useId();
	const [values, setValues] = useState<TaskFormValues>(() => taskToFormValues(task, defaultStatus));
	const [errors, setErrors] = useState<TaskFormErrors>({});
	const describedBy = (field: TaskFormField): string | undefined => {
		if (errors[field]) return `kb-task-${field}-error`;
		if (field === "status" && task) return "kb-task-status-help";
		if (field === "labels") return `kb-task-${field}-help`;
		return undefined;
	};
	const update = <K extends TaskFormField>(field: K, value: TaskFormValues[K]): void => {
		setValues(current => ({ ...current, [field]: value }));
		if (errors[field]) setErrors(current => ({ ...current, [field]: undefined }));
	};
	const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		const result = validateTaskForm(values);
		setErrors(result.errors);
		if (!result.valid) {
			requestAnimationFrame(() => {
				const firstInvalid = document.querySelector<HTMLElement>(`#${CSS.escape(formId)} [aria-invalid="true"]`);
				firstInvalid?.focus();
			});
			return;
		}
		await onSubmit(result.valid);
	};

	return (
		<form id={formId} className="kb-task-form" onSubmit={submit} noValidate>
			{serverError ? (
				<div className="kb-form-alert" role="alert">
					{serverError}
				</div>
			) : null}
			<div className="kb-form-grid">
				<Field label="Title (required)" field="title" errors={errors}>
					<input
						id="kb-task-title"
						value={values.title}
						onChange={event => update("title", event.target.value)}
						maxLength={201}
						aria-invalid={Boolean(errors.title)}
						aria-describedby={describedBy("title")}
						required
					/>
				</Field>
				<div className="kb-field-row">
					<Field
						label="Status"
						field="status"
						errors={errors}
						helper={task ? "Move the card on the board to change status." : undefined}
					>
						<select
							id="kb-task-status"
							value={values.status}
							onChange={event => update("status", event.target.value as KanbanStatus)}
							disabled={Boolean(task)}
							aria-describedby={describedBy("status")}
						>
							{KANBAN_STATUSES.map(status => (
								<option key={status} value={status}>
									{STATUS_LABELS[status]}
								</option>
							))}
						</select>
					</Field>
					<Field label="Priority" field="priority" errors={errors}>
						<select
							id="kb-task-priority"
							value={values.priority}
							onChange={event => update("priority", event.target.value as TaskFormValues["priority"])}
						>
							{KANBAN_PRIORITIES.map(priority => (
								<option key={priority} value={priority}>
									{PRIORITY_LABELS[priority]}
								</option>
							))}
						</select>
					</Field>
				</div>
				<Field label="Description" field="description" errors={errors}>
					<DescriptionEditor
						id="kb-task-description"
						value={values.description}
						disabled={!canWrite || busy}
						api={api}
						invalid={Boolean(errors.description)}
						describedBy={describedBy("description")}
						onChange={next => update("description", next)}
					/>
				</Field>
				<div className="kb-field-row">
					<Field label="Assignee" field="assignee" errors={errors}>
						<input
							id="kb-task-assignee"
							value={values.assignee}
							onChange={event => update("assignee", event.target.value)}
							aria-invalid={Boolean(errors.assignee)}
							aria-describedby={describedBy("assignee")}
						/>
					</Field>
					<Field label="Due date" field="dueAt" errors={errors}>
						<input
							id="kb-task-dueAt"
							type="datetime-local"
							value={values.dueAt}
							onChange={event => update("dueAt", event.target.value)}
							aria-invalid={Boolean(errors.dueAt)}
							aria-describedby={describedBy("dueAt")}
						/>
					</Field>
				</div>
				<Field label="Labels" field="labels" errors={errors} helper="Separate labels with commas or new lines.">
					<textarea
						id="kb-task-labels"
						value={values.labels}
						onChange={event => update("labels", event.target.value)}
						rows={2}
						aria-invalid={Boolean(errors.labels)}
						aria-describedby={describedBy("labels")}
					/>
				</Field>
			</div>
			{!canWrite ? <p className="kb-disabled-reason">Reconnect to save changes.</p> : null}
			<div className="kb-form-actions">
				<button type="button" className="kb-button" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" className="kb-button kb-button-primary" disabled={busy || !canWrite}>
					{busy ? "Saving..." : task ? "Save changes" : "Create task"}
				</button>
			</div>
		</form>
	);
}
