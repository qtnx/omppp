import { CalendarDays, GripVertical, Plus, Tag, UserRound } from "lucide-react";
import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { calculateMoveDestination, type MoveDestination, projectKeyboardMove } from "./reorder";
import { isKanbanStatus, KANBAN_STATUSES, type KanbanStatus, type KanbanTask } from "./types";
import { formatKanbanDate, PRIORITY_LABELS, STATUS_LABELS } from "./view-model";

interface KanbanBoardProps {
	tasks: readonly KanbanTask[];
	canWrite: boolean;
	busyTaskId: string | null;
	onOpenTask(task: KanbanTask, trigger: HTMLButtonElement): void;
	onCreate(status: KanbanStatus, trigger: HTMLButtonElement): void;
	onMove(task: KanbanTask, destination: MoveDestination): Promise<void>;
	onAnnounce(message: string): void;
}

interface PointerSession {
	pointerId: number;
	taskId: string;
	startX: number;
	startY: number;
	active: boolean;
	destination: MoveDestination;
}

interface PointerDrop {
	taskId: string;
	destination: MoveDestination;
}

interface KeyboardDrag {
	taskId: string;
	destination: MoveDestination;
}

function sortedTasks(tasks: readonly KanbanTask[]): KanbanTask[] {
	return [...tasks].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

export function KanbanBoard({
	tasks,
	canWrite,
	busyTaskId,
	onOpenTask,
	onCreate,
	onMove,
	onAnnounce,
}: KanbanBoardProps) {
	const pointerSession = useRef<PointerSession | null>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const boardRegionRef = useRef<HTMLElement>(null);
	const keyboardFocusTaskId = useRef<string | null>(null);
	const [pointerDrop, setPointerDrop] = useState<PointerDrop | null>(null);
	const [keyboardDrag, setKeyboardDrag] = useState<KeyboardDrag | null>(null);
	const taskMap = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
	const focusMoveHandle = useCallback((taskId: string): void => {
		const selector = `[data-kanban-move-task="${CSS.escape(taskId)}"]`;
		boardRegionRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
	}, []);

	useLayoutEffect(() => {
		const taskId = keyboardDrag?.taskId ?? keyboardFocusTaskId.current;
		if (!taskId) return;
		focusMoveHandle(taskId);
		if (!keyboardDrag) keyboardFocusTaskId.current = null;
	}, [focusMoveHandle, keyboardDrag]);

	const movePreview = (x: number, y: number): void => {
		requestAnimationFrame(() => {
			if (previewRef.current) previewRef.current.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`;
		});
	};

	const pointerDestination = (x: number, y: number, taskId: string): MoveDestination | null => {
		const element = document.elementFromPoint(x, y);
		const column = element?.closest<HTMLElement>("[data-kanban-column]");
		const status = column?.dataset.kanbanColumn;
		if (!column || !isKanbanStatus(status)) return null;
		const columnTasks = sortedTasks(tasks.filter(task => task.status === status && task.id !== taskId));
		const card = element?.closest<HTMLElement>("[data-kanban-task]");
		let index = columnTasks.length;
		if (card && column.contains(card)) {
			const cardId = card.dataset.kanbanTask;
			const cardIndex = columnTasks.findIndex(task => task.id === cardId);
			if (cardIndex >= 0) {
				const box = card.getBoundingClientRect();
				index = cardIndex + (y > box.top + box.height / 2 ? 1 : 0);
			}
		}
		return calculateMoveDestination(tasks, taskId, status, index);
	};

	const beginPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, task: KanbanTask): void => {
		if (!canWrite || busyTaskId !== null || keyboardDrag) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		pointerSession.current = {
			pointerId: event.pointerId,
			taskId: task.id,
			startX: event.clientX,
			startY: event.clientY,
			active: false,
			destination: { status: task.status, index: task.position },
		};
	};

	const updatePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
		const session = pointerSession.current;
		if (!session || session.pointerId !== event.pointerId) return;
		const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
		if (!session.active && distance < 6) return;
		if (!session.active) {
			session.active = true;
			onAnnounce(`Moving ${taskMap.get(session.taskId)?.title ?? "task"}.`);
		}
		const destination = pointerDestination(event.clientX, event.clientY, session.taskId);
		if (destination) session.destination = destination;
		setPointerDrop(current => {
			if (
				current?.taskId === session.taskId &&
				current.destination.status === session.destination.status &&
				current.destination.index === session.destination.index
			)
				return current;
			return { taskId: session.taskId, destination: session.destination };
		});
		movePreview(event.clientX, event.clientY);
	};

	const finishPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
		const session = pointerSession.current;
		if (!session || session.pointerId !== event.pointerId) return;
		pointerSession.current = null;
		setPointerDrop(null);
		if (!session.active) return;
		const task = taskMap.get(session.taskId);
		if (task) void onMove(task, session.destination);
	};

	const cancelPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
		if (pointerSession.current?.pointerId !== event.pointerId) return;
		pointerSession.current = null;
		setPointerDrop(null);
		onAnnounce("Move cancelled.");
	};

	const handleKeyboard = (event: KeyboardEvent<HTMLButtonElement>, renderedTask: KanbanTask): void => {
		const task = taskMap.get(renderedTask.id) ?? renderedTask;
		const active = keyboardDrag?.taskId === task.id ? keyboardDrag : null;
		if (!active) {
			if (event.key !== " " && event.key !== "Enter") return;
			event.preventDefault();
			if (!canWrite || busyTaskId !== null) return;
			keyboardFocusTaskId.current = task.id;
			const next = { taskId: task.id, destination: { status: task.status, index: task.position } };
			setKeyboardDrag(next);
			onAnnounce(`Lifted ${task.title}. Use arrow keys to choose a position, Enter to place, or Escape to cancel.`);
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			setKeyboardDrag(null);
			onAnnounce(`Move cancelled for ${task.title}.`);
			return;
		}
		if (event.key === " " || event.key === "Enter") {
			event.preventDefault();
			setKeyboardDrag(null);
			void onMove(task, active.destination).then(
				() => focusMoveHandle(task.id),
				() => focusMoveHandle(task.id),
			);
			return;
		}
		const direction =
			event.key === "ArrowUp"
				? "up"
				: event.key === "ArrowDown"
					? "down"
					: event.key === "ArrowLeft"
						? "left"
						: event.key === "ArrowRight"
							? "right"
							: null;
		if (!direction) return;
		event.preventDefault();
		const destination = projectKeyboardMove(tasks, task.id, KANBAN_STATUSES, active.destination, direction);
		setKeyboardDrag({ taskId: task.id, destination });
		onAnnounce(
			`${task.title} move preview: ${STATUS_LABELS[destination.status]}, position ${destination.index + 1}.`,
		);
	};

	const presentedByStatus = (status: KanbanStatus): KanbanTask[] => {
		const base = sortedTasks(tasks.filter(task => task.status === status));
		if (!keyboardDrag) return base;
		const moving = taskMap.get(keyboardDrag.taskId);
		if (!moving) return base;
		const withoutMoving = base.filter(task => task.id !== moving.id);
		if (keyboardDrag.destination.status !== status) return withoutMoving;
		withoutMoving.splice(keyboardDrag.destination.index, 0, { ...moving, status });
		return withoutMoving;
	};

	const draggedTask = pointerDrop ? taskMap.get(pointerDrop.taskId) : null;

	return (
		<section ref={boardRegionRef} className="kb-board-region" aria-label="Kanban board">
			<p className="kb-keyboard-instructions" id="kb-move-instructions">
				Keyboard move: focus a card's Move task button, press Space, use arrow keys, then press Enter to place or
				Escape to cancel.
			</p>
			<div className="kb-board" data-pointer-dragging={pointerDrop ? "true" : "false"}>
				{KANBAN_STATUSES.map(status => {
					const columnTasks = presentedByStatus(status);
					const isDropColumn = pointerDrop?.destination.status === status;
					return (
						<section
							key={status}
							className="kb-column"
							data-kanban-column={status}
							data-drop-target={isDropColumn ? "true" : "false"}
							aria-labelledby={`kb-column-${status}`}
						>
							<header className="kb-column-header">
								<div>
									<h2 id={`kb-column-${status}`}>{STATUS_LABELS[status]}</h2>
									<span aria-label={`${columnTasks.length} tasks`}>{columnTasks.length}</span>
								</div>
								<button
									type="button"
									className="kb-icon-button"
									onClick={event => onCreate(status, event.currentTarget)}
									disabled={!canWrite}
									aria-label={`Create task in ${STATUS_LABELS[status]}`}
									title={!canWrite ? "Reconnect to create tasks" : `Create task in ${STATUS_LABELS[status]}`}
								>
									<Plus size={16} aria-hidden="true" />
								</button>
							</header>
							<div className="kb-column-list">
								{columnTasks.length === 0 ? (
									<div className="kb-column-empty">
										<p>No tasks in {STATUS_LABELS[status].toLowerCase()}.</p>
										<button
											type="button"
											onClick={event => onCreate(status, event.currentTarget)}
											disabled={!canWrite}
										>
											Create task
										</button>
									</div>
								) : (
									columnTasks.map((task, index) => {
										const keyboardPreview = keyboardDrag?.taskId === task.id;
										const due = task.dueAt ? formatKanbanDate(task.dueAt) : null;
										return (
											<article
												key={task.id}
												className="kb-task-card"
												data-kanban-task={task.id}
												data-priority={task.priority}
												data-keyboard-preview={keyboardPreview ? "true" : "false"}
												aria-busy={busyTaskId === task.id || undefined}
											>
												<button
													type="button"
													className="kb-card-open"
													onClick={event => onOpenTask(task, event.currentTarget)}
												>
													<span className="kb-priority" data-priority={task.priority}>
														{PRIORITY_LABELS[task.priority]}
													</span>
													<strong>{task.title}</strong>
													{task.description ? (
														<span className="kb-card-description">{task.description}</span>
													) : null}
													<span className="kb-card-meta">
														{task.assignee ? (
															<span>
																<UserRound size={13} aria-hidden="true" />
																{task.assignee}
															</span>
														) : null}
														{due ? (
															<span>
																<CalendarDays size={13} aria-hidden="true" />
																{due}
															</span>
														) : null}
														{task.labels.length > 0 ? (
															<span>
																<Tag size={13} aria-hidden="true" />
																{task.labels.length}
															</span>
														) : null}
													</span>
												</button>
												<button
													type="button"
													className="kb-drag-handle"
													data-kanban-move-task={task.id}
													disabled={!canWrite || (busyTaskId !== null && busyTaskId !== task.id)}
													onPointerDown={event => beginPointerDrag(event, task)}
													onPointerMove={updatePointerDrag}
													onPointerUp={finishPointerDrag}
													onPointerCancel={cancelPointerDrag}
													onKeyDown={event => handleKeyboard(event, task)}
													aria-label={`Move task: ${task.title}`}
													aria-describedby="kb-move-instructions"
													aria-pressed={keyboardPreview}
													title={!canWrite ? "Reconnect to move tasks" : "Move task"}
												>
													<GripVertical size={16} aria-hidden="true" />
												</button>
												{isDropColumn && pointerDrop?.destination.index === index ? (
													<span className="kb-drop-marker" aria-hidden="true" />
												) : null}
											</article>
										);
									})
								)}
								{isDropColumn && pointerDrop?.destination.index >= columnTasks.length ? (
									<span className="kb-drop-marker kb-drop-marker-end" aria-hidden="true" />
								) : null}
							</div>
						</section>
					);
				})}
			</div>
			{draggedTask ? (
				<div ref={previewRef} className="kb-drag-preview" aria-hidden="true">
					<GripVertical size={16} />
					<span>{draggedTask.title}</span>
				</div>
			) : null}
		</section>
	);
}
