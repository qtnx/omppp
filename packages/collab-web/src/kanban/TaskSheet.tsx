import { MessageSquare, Pencil, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { KanbanApi } from "./api";
import { TaskForm } from "./TaskForm";
import type { ValidTaskForm } from "./task-form";
import type { KanbanActivity, KanbanComment, KanbanStatus, KanbanTask } from "./types";
import { ACTIVITY_LABELS, activityDetail, formatKanbanDate, PRIORITY_LABELS, STATUS_LABELS } from "./view-model";

type TaskSheetTab = "details" | "comments" | "activity";

interface TaskSheetProps {
	task: KanbanTask | null;
	defaultStatus: KanbanStatus;
	api: KanbanApi;
	activity: readonly KanbanActivity[];
	canWrite: boolean;
	busy: boolean;
	serverError: string | null;
	returnFocus: HTMLElement | null;
	onSave(valid: ValidTaskForm): Promise<boolean>;
	onDelete(task: KanbanTask): Promise<boolean>;
	onRunMutation<T>(taskId: string | null, action: () => Promise<T>): Promise<T | null>;
	onAnnounce(message: string): void;
	onDismiss(): void;
}

const COMMENT_AUTHOR_KEY = "omp-kanban-comment-author";

function initialAuthor(): string {
	try {
		return globalThis.localStorage.getItem(COMMENT_AUTHOR_KEY) ?? "";
	} catch {
		return "";
	}
}

export function TaskSheet({
	task,
	defaultStatus,
	api,
	activity,
	canWrite,
	busy,
	serverError,
	returnFocus,
	onSave,
	onDelete,
	onRunMutation,
	onAnnounce,
	onDismiss,
}: TaskSheetProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [tab, setTab] = useState<TaskSheetTab>("details");
	const [comments, setComments] = useState<KanbanComment[]>([]);
	const [commentsLoading, setCommentsLoading] = useState(Boolean(task));
	const [commentsError, setCommentsError] = useState<string | null>(null);
	const [commentAuthor, setCommentAuthor] = useState(initialAuthor);
	const [commentBody, setCommentBody] = useState("");
	const [commentFormError, setCommentFormError] = useState<string | null>(null);
	const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
	const [editingBody, setEditingBody] = useState("");
	const [confirmCommentId, setConfirmCommentId] = useState<string | null>(null);
	const [confirmTaskDelete, setConfirmTaskDelete] = useState(false);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (dialog && !dialog.open) dialog.showModal();
	}, []);

	useEffect(() => {
		if (!task) return;
		let active = true;
		setCommentsLoading(true);
		setCommentsError(null);
		void api.listComments(task.id).then(
			loaded => {
				if (!active) return;
				setComments(loaded);
				setCommentsLoading(false);
			},
			error => {
				if (!active) return;
				setCommentsError(error instanceof Error ? error.message : "Couldn't load comments. Try again.");
				setCommentsLoading(false);
			},
		);
		return () => {
			active = false;
		};
	}, [api, task?.id, task?.version]);

	const dismiss = (): void => {
		onDismiss();
		requestAnimationFrame(() => returnFocus?.focus());
	};

	const submitComment = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (!task) return;
		const author = commentAuthor.trim();
		const body = commentBody.trim();
		if (author.length < 1 || author.length > 64) {
			setCommentFormError("Enter an author name between 1 and 64 characters.");
			return;
		}
		if (body.length < 1 || body.length > 10_000) {
			setCommentFormError("Enter a comment between 1 and 10,000 characters.");
			return;
		}
		const created = await onRunMutation(task.id, () => api.createComment(task.id, { author, body }));
		if (!created) return;
		try {
			globalThis.localStorage.setItem(COMMENT_AUTHOR_KEY, author);
		} catch {
			// The comment still succeeds when storage is unavailable.
		}
		setComments(current => [...current, created]);
		setCommentBody("");
		setCommentFormError(null);
		onAnnounce(`Comment added by ${created.author}.`);
	};

	const saveEditedComment = async (comment: KanbanComment): Promise<void> => {
		if (!task) return;
		const body = editingBody.trim();
		if (body.length < 1 || body.length > 10_000) {
			setCommentFormError("Enter a comment between 1 and 10,000 characters.");
			return;
		}
		const updated = await onRunMutation(task.id, () => api.updateComment(task.id, comment.id, comment.version, body));
		if (!updated) return;
		setComments(current => current.map(item => (item.id === updated.id ? updated : item)));
		setEditingCommentId(null);
		setEditingBody("");
		setCommentFormError(null);
		onAnnounce("Comment updated.");
	};

	const deleteComment = async (comment: KanbanComment): Promise<void> => {
		if (!task) return;
		const deleted = await onRunMutation(task.id, () => api.deleteComment(task.id, comment.id, comment.version));
		if (!deleted) return;
		setComments(current => current.map(item => (item.id === deleted.id ? deleted : item)));
		setConfirmCommentId(null);
		onAnnounce("Comment deleted.");
	};

	const taskActivity = activity.filter(item => item.taskId === task?.id);

	return (
		<dialog
			ref={dialogRef}
			className={task ? "kb-sheet" : "kb-sheet kb-sheet-create"}
			aria-labelledby="kb-sheet-title"
			onClose={dismiss}
		>
			<div className="kb-sheet-frame">
				<header className="kb-sheet-header">
					<div>
						<p>
							{task ? (
								<>
									<span className="kb-issue-key">{task.id.slice(0, 8)}</span>
									<span className="kb-status-chip" data-status={task.status}>
										{STATUS_LABELS[task.status]}
									</span>
								</>
							) : (
								<span className="kb-issue-key">New {STATUS_LABELS[defaultStatus].toLowerCase()} task</span>
							)}
						</p>
						<h2 id="kb-sheet-title">{task?.title ?? "Create task"}</h2>
					</div>
					<button
						type="button"
						className="kb-icon-button"
						onClick={() => dialogRef.current?.close()}
						aria-label={task ? "Close task details" : "Close create task"}
					>
						<X size={18} aria-hidden="true" />
					</button>
				</header>

				{task ? (
					<div className="kb-tabs" role="tablist" aria-label="Task details">
						{(["details", "comments", "activity"] as const).map(item => (
							<button
								key={item}
								type="button"
								role="tab"
								aria-selected={tab === item}
								aria-controls={`kb-panel-${item}`}
								id={`kb-tab-${item}`}
								onClick={() => setTab(item)}
							>
								{item === "details"
									? "Details"
									: item === "comments"
										? `Comments (${comments.length})`
										: `Activity (${taskActivity.length})`}
							</button>
						))}
					</div>
				) : null}

				<div className="kb-sheet-content">
					{tab === "details" ? (
						<section id="kb-panel-details" role="tabpanel" aria-labelledby={task ? "kb-tab-details" : undefined}>
							<div className={task ? "kb-sheet-split" : undefined}>
								<div className="kb-sheet-main">
									<TaskForm
										key={`${task?.id ?? "new"}:${task?.version ?? 0}:${defaultStatus}`}
										task={task}
										defaultStatus={defaultStatus}
										busy={busy}
										canWrite={canWrite}
										serverError={serverError}
										onSubmit={async valid => {
											if (await onSave(valid)) dialogRef.current?.close();
										}}
										onCancel={() => dialogRef.current?.close()}
									/>
								</div>
								{task ? (
									<aside className="kb-sheet-side" aria-label="Task metadata">
										<h3>Details</h3>
										<dl>
											<dt>Status</dt>
											<dd>{STATUS_LABELS[task.status]}</dd>
											<dt>Priority</dt>
											<dd>{PRIORITY_LABELS[task.priority]}</dd>
											<dt>Assignee</dt>
											<dd>{task.assignee ?? "Unassigned"}</dd>
											<dt>Labels</dt>
											<dd>{task.labels.length > 0 ? task.labels.join(", ") : "None"}</dd>
											<dt>Due</dt>
											<dd>{task.dueAt ? formatKanbanDate(task.dueAt) : "No due date"}</dd>
											<dt>Version</dt>
											<dd>{task.version}</dd>
											<dt>Created</dt>
											<dd>{formatKanbanDate(task.createdAt)}</dd>
											<dt>Updated</dt>
											<dd>{formatKanbanDate(task.updatedAt)}</dd>
										</dl>
									</aside>
								) : null}
							</div>
							{task ? (
								<section className="kb-danger-zone" aria-labelledby="kb-delete-task-title">
									<h3 id="kb-delete-task-title">Delete task</h3>
									{confirmTaskDelete ? (
										<div className="kb-delete-confirm" role="alert">
											<p>Delete {task.title}? This can't be undone.</p>
											<div>
												<button
													type="button"
													className="kb-button"
													onClick={() => setConfirmTaskDelete(false)}
												>
													Keep task
												</button>
												<button
													type="button"
													className="kb-button kb-button-danger"
													disabled={busy || !canWrite}
													onClick={async () => {
														if (await onDelete(task)) dialogRef.current?.close();
													}}
												>
													Delete task
												</button>
											</div>
										</div>
									) : (
										<button
											type="button"
											className="kb-button kb-button-danger"
											onClick={() => setConfirmTaskDelete(true)}
											disabled={!canWrite}
										>
											Delete task
										</button>
									)}
								</section>
							) : null}
						</section>
					) : null}

					{task && tab === "comments" ? (
						<section
							id="kb-panel-comments"
							role="tabpanel"
							aria-labelledby="kb-tab-comments"
							className="kb-comments-panel"
						>
							{commentsLoading ? (
								<div className="kb-comment-skeleton" aria-busy="true">
									<span>Loading comments...</span>
								</div>
							) : null}
							{commentsError ? (
								<div className="kb-inline-error" role="alert">
									<p>{commentsError}</p>
									<button
										type="button"
										className="kb-button"
										onClick={() => {
											setCommentsLoading(true);
											setCommentsError(null);
											void api
												.listComments(task.id)
												.then(setComments)
												.then(
													() => setCommentsLoading(false),
													error => {
														setCommentsLoading(false);
														setCommentsError(
															error instanceof Error
																? error.message
																: "Couldn't load comments. Try again.",
														);
													},
												);
										}}
									>
										Retry
									</button>
								</div>
							) : null}
							{!commentsLoading && !commentsError && comments.length === 0 ? (
								<div className="kb-comments-empty">
									<MessageSquare size={22} aria-hidden="true" />
									<h3>No comments yet</h3>
									<p>Add context, a decision, or a question for the people working on this task.</p>
								</div>
							) : null}
							<ol className="kb-comment-list">
								{comments.map(comment => (
									<li
										key={comment.id}
										className="kb-comment"
										data-deleted={comment.deletedAt ? "true" : "false"}
									>
										<header>
											<strong>{comment.author}</strong>
											<span>
												{formatKanbanDate(comment.createdAt)}
												{comment.editedAt ? ", edited" : ""}
											</span>
										</header>
										{comment.deletedAt ? (
											<p className="kb-comment-deleted" aria-label="Deleted comment">
												This comment was deleted.
											</p>
										) : editingCommentId === comment.id ? (
											<div className="kb-comment-edit">
												<label htmlFor={`kb-edit-comment-${comment.id}`}>Edit comment</label>
												<textarea
													id={`kb-edit-comment-${comment.id}`}
													value={editingBody}
													onChange={event => setEditingBody(event.target.value)}
													rows={4}
												/>
												<div>
													<button
														type="button"
														className="kb-button"
														onClick={() => setEditingCommentId(null)}
													>
														Cancel
													</button>
													<button
														type="button"
														className="kb-button kb-button-primary"
														disabled={!canWrite || busy}
														onClick={() => void saveEditedComment(comment)}
													>
														Save comment
													</button>
												</div>
											</div>
										) : (
											<p className="kb-comment-body">{comment.body}</p>
										)}
										{!comment.deletedAt && editingCommentId !== comment.id ? (
											<div className="kb-comment-actions">
												<button
													type="button"
													onClick={() => {
														setEditingCommentId(comment.id);
														setEditingBody(comment.body);
													}}
													disabled={!canWrite}
												>
													<Pencil size={14} aria-hidden="true" /> Edit
												</button>
												<button
													type="button"
													onClick={() => setConfirmCommentId(comment.id)}
													disabled={!canWrite}
												>
													<Trash2 size={14} aria-hidden="true" /> Delete
												</button>
											</div>
										) : null}
										{confirmCommentId === comment.id ? (
											<div className="kb-delete-confirm">
												<p>Delete this comment? Its history will remain visible.</p>
												<div>
													<button
														type="button"
														className="kb-button"
														onClick={() => setConfirmCommentId(null)}
													>
														Keep comment
													</button>
													<button
														type="button"
														className="kb-button kb-button-danger"
														disabled={busy || !canWrite}
														onClick={() => void deleteComment(comment)}
													>
														Delete comment
													</button>
												</div>
											</div>
										) : null}
									</li>
								))}
							</ol>
							<form className="kb-comment-form" onSubmit={submitComment} noValidate>
								<h3>Add comment</h3>
								<div className="kb-field">
									<label htmlFor="kb-comment-author">Author (required)</label>
									<input
										id="kb-comment-author"
										value={commentAuthor}
										onChange={event => setCommentAuthor(event.target.value)}
										maxLength={65}
										required
									/>
								</div>
								<div className="kb-field">
									<label htmlFor="kb-comment-body">Comment (required)</label>
									<textarea
										id="kb-comment-body"
										value={commentBody}
										onChange={event => setCommentBody(event.target.value)}
										rows={5}
										maxLength={10_001}
										required
									/>
								</div>
								{commentFormError ? (
									<p className="kb-field-error" role="alert">
										{commentFormError}
									</p>
								) : null}
								{!canWrite ? <p className="kb-disabled-reason">Reconnect to add or change comments.</p> : null}
								<button type="submit" className="kb-button kb-button-primary" disabled={!canWrite || busy}>
									Add comment
								</button>
							</form>
						</section>
					) : null}

					{task && tab === "activity" ? (
						<section id="kb-panel-activity" role="tabpanel" aria-labelledby="kb-tab-activity">
							{taskActivity.length === 0 ? (
								<div className="kb-activity-empty">
									<h3>No activity yet</h3>
									<p>Changes to this task will appear here.</p>
								</div>
							) : (
								<ol className="kb-activity-list">
									{[...taskActivity]
										.sort((left, right) => right.cursor - left.cursor)
										.map(item => (
											<li key={item.id}>
												<strong>{ACTIVITY_LABELS[item.type]}</strong>
												{activityDetail(item) ? <p>{activityDetail(item)}</p> : null}
												<time dateTime={item.createdAt}>{formatKanbanDate(item.createdAt)}</time>
											</li>
										))}
								</ol>
							)}
						</section>
					) : null}
				</div>
			</div>
		</dialog>
	);
}
