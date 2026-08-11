import { type CSSProperties, type FormEvent, type ReactNode, useId, useState } from "react";
import type { KanbanApi } from "./api";
import { DescriptionEditor } from "./DescriptionEditor";
import {
	normalizeTaskLabels,
	type TaskFormErrors,
	type TaskFormField,
	type TaskFormValues,
	taskToFormValues,
	type ValidTaskForm,
	validateTaskForm,
} from "./task-form";
import {
	KANBAN_PRIORITIES,
	KANBAN_STATUSES,
	type KanbanBoardSession,
	type KanbanStatus,
	type KanbanTask,
} from "./types";
import { labelColor, PRIORITY_LABELS, STATUS_LABELS } from "./view-model";

interface TaskFormProps {
	task: KanbanTask | null;
	defaultStatus: KanbanStatus;
	busy: boolean;
	canWrite: boolean;
	serverError: string | null;
	api: KanbanApi | null;
	sessions: readonly KanbanBoardSession[];
	/** Every label already used on this board, so the picker can offer them as chips. */
	knownLabels: readonly string[];
	onSubmit(valid: ValidTaskForm): Promise<void>;
	/** Applies a status change immediately; resolves false when the move was rejected. */
	onStatusChange(status: KanbanStatus): Promise<boolean>;
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

export function TaskForm({
	task,
	defaultStatus,
	busy,
	canWrite,
	serverError,
	api,
	sessions,
	knownLabels,
	onSubmit,
	onStatusChange,
	onCancel,
}: TaskFormProps) {
	const formId = useId();
	const [values, setValues] = useState<TaskFormValues>(() => taskToFormValues(task, defaultStatus));
	const [errors, setErrors] = useState<TaskFormErrors>({});
	// Keep an assignee that is offline right now: the session may come back, and
	// silently dropping it from the picker would silently reassign the task.
	const assigneeOptions = [
		...new Set([...sessions.map(session => session.name), values.assignee].filter(name => name.length > 0)),
	].sort();
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
	const [labelDraft, setLabelDraft] = useState("");
	const [labelHint, setLabelHint] = useState<string | null>(null);
	// Offer every label the board already knows plus whatever this task carries, so a
	// label that was removed from every other task stays visible while editing.
	const labelOptions = [
		...new Map(
			[...knownLabels, ...values.labels]
				.filter(label => label.length > 0)
				.map(label => [label.toLocaleLowerCase(), label]),
		).values(),
	].sort((left, right) => left.localeCompare(right));
	const isSelected = (label: string): boolean =>
		values.labels.some(current => current.toLocaleLowerCase() === label.toLocaleLowerCase());
	const setLabels = (labels: string[]): void => {
		setLabelHint(null);
		update("labels", labels);
	};
	const addLabel = (label: string): void => {
		const normalized = normalizeTaskLabels([...values.labels, label]);
		// normalizeTaskLabels bails out at the first duplicate, so its list is only
		// usable when nothing collided; otherwise keep the selection and hint instead.
		if (normalized.duplicate) {
			setLabelHint(`“${normalized.duplicate}” is already on this task.`);
			return;
		}
		setLabels(normalized.labels);
	};
	const toggleLabel = (label: string): void => {
		if (isSelected(label)) {
			setLabels(values.labels.filter(current => current.toLocaleLowerCase() !== label.toLocaleLowerCase()));
			return;
		}
		addLabel(label);
	};
	const commitLabelDraft = (): void => {
		const draft = labelDraft.trim();
		if (draft.length === 0) return;
		addLabel(draft);
		setLabelDraft("");
	};
	const chipStyle = (label: string): CSSProperties => ({ "--kb-label": labelColor(label) }) as CSSProperties;
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
		<form
			id={formId}
			className="kb-task-form"
			onSubmit={submit}
			onKeyDown={event => {
				// Description and labels are textareas, so plain Enter has to stay a
				// newline; Ctrl/Cmd+Enter is the submit gesture from anywhere in the form.
				if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || busy || !canWrite) return;
				event.preventDefault();
				event.currentTarget.requestSubmit();
			}}
			noValidate
		>
			{serverError ? (
				<div className="kb-form-alert" role="alert">
					{serverError}
				</div>
			) : null}
			<div className="kb-form-grid">
				<Field label="Title (optional)" field="title" errors={errors}>
					<input
						id="kb-task-title"
						value={values.title}
						onChange={event => update("title", event.target.value)}
						placeholder="Leave blank to let the agent name it"
						maxLength={201}
						aria-invalid={Boolean(errors.title)}
						aria-describedby={describedBy("title")}
					/>
				</Field>
				<div className="kb-field-row">
					<Field
						label="Status"
						field="status"
						errors={errors}
						helper={task ? "Applies right away — the card moves to the end of that column." : undefined}
					>
						<select
							id="kb-task-status"
							value={values.status}
							onChange={event => {
								const next = event.target.value as KanbanStatus;
								const previous = values.status;
								update("status", next);
								// Status is not a PATCH field, so it cannot ride along with Save: it
								// moves the card now, and snaps back if the server refuses the move.
								if (!task) return;
								void onStatusChange(next).then(moved => {
									if (!moved) update("status", previous);
								});
							}}
							disabled={!canWrite || busy}
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
					<Field
						label="Assignee"
						field="assignee"
						errors={errors}
						helper="Pick the session that should pick this up."
					>
						<select
							id="kb-task-assignee"
							value={values.assignee}
							onChange={event => update("assignee", event.target.value)}
							aria-invalid={Boolean(errors.assignee)}
							aria-describedby={describedBy("assignee")}
						>
							<option value="">Unassigned (any session)</option>
							{assigneeOptions.map(name => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
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
				<Field
					label="Labels"
					field="labels"
					errors={errors}
					helper="Pick a label to toggle it, or type a new one and press Enter."
				>
					<div className="kb-label-picker">
						{labelOptions.length > 0 ? (
							<div className="kb-label-chips">
								{labelOptions.map(label => (
									<button
										key={label.toLocaleLowerCase()}
										type="button"
										className="kb-label-chip"
										aria-pressed={isSelected(label)}
										style={chipStyle(label)}
										onClick={() => toggleLabel(label)}
									>
										{label}
									</button>
								))}
							</div>
						) : null}
						<input
							id="kb-task-labels"
							type="text"
							value={labelDraft}
							placeholder="Add a label"
							onChange={event => setLabelDraft(event.target.value)}
							onKeyDown={event => {
								// The form only submits on Ctrl/Cmd+Enter, so a plain Enter here is
								// ours to consume: add the drafted label instead of bubbling.
								if (event.key !== "Enter") return;
								event.preventDefault();
								commitLabelDraft();
							}}
							onBlur={commitLabelDraft}
							aria-invalid={Boolean(errors.labels)}
							aria-describedby={describedBy("labels")}
						/>
						{labelHint ? <p className="kb-label-hint">{labelHint}</p> : null}
					</div>
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
