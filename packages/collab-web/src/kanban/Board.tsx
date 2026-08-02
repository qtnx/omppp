import {
	closestCorners,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	DragOverlay,
	type DragStartEvent,
	type KeyboardCoordinateGetter,
	KeyboardSensor,
	MouseSensor,
	TouchSensor,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CalendarDays, GripVertical, MessageSquare, Plus } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { MoveDestination } from "./reorder";
import { isKanbanStatus, KANBAN_STATUSES, type KanbanStatus, type KanbanTask } from "./types";
import { displayTitle, formatKanbanDate, labelColor, PRIORITY_LABELS, STATUS_LABELS } from "./view-model";

/** Avatar bubble text: first letters of the first two words, Jira-style. */
function initials(assignee: string): string {
	const parts = assignee
		.trim()
		.split(/[\s._-]+/)
		.filter(Boolean);
	if (parts.length === 0) return "?";
	return parts
		.slice(0, 2)
		.map(part => part[0]!.toUpperCase())
		.join("");
}

interface KanbanBoardProps {
	tasks: readonly KanbanTask[];
	canWrite: boolean;
	busyTaskId: string | null;
	unreadTaskIds: ReadonlySet<string>;
	onOpenTask(task: KanbanTask, trigger: HTMLButtonElement): void;
	onCreate(status: KanbanStatus, trigger: HTMLButtonElement): void;
	onMove(task: KanbanTask, destination: MoveDestination): Promise<void>;
	onAnnounce(message: string): void;
}

type ColumnMap = Record<KanbanStatus, KanbanTask[]>;

/** Vim keys reach the sortable keyboard sensor by borrowing the arrow it mirrors. */
const ARROW_FOR_VIM_KEY: Record<string, string> = {
	h: "ArrowLeft",
	j: "ArrowDown",
	k: "ArrowUp",
	l: "ArrowRight",
};

function groupByStatus(tasks: readonly KanbanTask[]): ColumnMap {
	const columns = Object.fromEntries(KANBAN_STATUSES.map(status => [status, [] as KanbanTask[]])) as ColumnMap;
	for (const task of tasks) columns[task.status].push(task);
	for (const status of KANBAN_STATUSES) {
		columns[status].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
	}
	return columns;
}

const vimCoordinateGetter: KeyboardCoordinateGetter = (event, args) => {
	const arrow = ARROW_FOR_VIM_KEY[event.key];
	if (!arrow) return sortableKeyboardCoordinates(event, args);
	// `sortableKeyboardCoordinates` switches on `code`, not `key`, so the stand-in
	// has to carry both. `preventDefault` is forwarded because the real event is
	// what the browser would otherwise act on.
	const stand = new KeyboardEvent(event.type, { key: arrow, code: arrow });
	stand.preventDefault = () => event.preventDefault();
	return sortableKeyboardCoordinates(stand, args);
};

interface TaskCardProps {
	task: KanbanTask;
	canWrite: boolean;
	busyTaskId: string | null;
	unread: boolean;
	onOpenTask(task: KanbanTask, trigger: HTMLButtonElement): void;
}

function TaskCard({ task, canWrite, busyTaskId, unread, onOpenTask }: TaskCardProps): ReactNode {
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
		id: task.id,
		disabled: !canWrite || (busyTaskId !== null && busyTaskId !== task.id),
	});
	const due = task.dueAt ? formatKanbanDate(task.dueAt) : null;
	return (
		<article
			ref={setNodeRef}
			className="kb-task-card"
			data-kanban-task={task.id}
			data-priority={task.priority}
			data-dragging={isDragging ? "true" : "false"}
			data-unread={unread ? "true" : "false"}
			aria-busy={busyTaskId === task.id || undefined}
			// Transform and transition come from the sortable layer, so reordering is a
			// compositor animation rather than a board-wide React render per pointer move.
			style={{ transform: CSS.Transform.toString(transform), transition }}
			{...listeners}
		>
			<button type="button" className="kb-card-open" onClick={event => onOpenTask(task, event.currentTarget)}>
				<strong>{displayTitle(task.title)}</strong>
				{task.description ? <span className="kb-card-description">{task.description}</span> : null}
				<span className="kb-card-meta">
					<span
						className="kb-priority"
						data-priority={task.priority}
						title={`${PRIORITY_LABELS[task.priority]} priority`}
					>
						{PRIORITY_LABELS[task.priority].slice(0, 1)}
					</span>
					<span className="kb-card-key">T-{task.shortId}</span>
					{task.labels.length > 0 ? (
						<span className="kb-card-labels">
							{task.labels.slice(0, 2).map(label => (
								<span
									key={label}
									data-labelled="true"
									style={{ "--label-color": labelColor(label) } as CSSProperties}
								>
									{label}
								</span>
							))}
							{task.labels.length > 2 ? <span>+{task.labels.length - 2}</span> : null}
						</span>
					) : null}
					{task.commentCount > 0 ? (
						<span className="kb-card-comments" aria-label={`${task.commentCount} comments`}>
							<MessageSquare size={12} aria-hidden="true" />
							{task.commentCount}
						</span>
					) : null}
					<span className="kb-card-spacer" />
					{due ? (
						<span>
							<CalendarDays size={13} aria-hidden="true" />
							{due}
						</span>
					) : null}
					{task.assignee ? (
						<span className="kb-avatar" title={task.assignee}>
							{initials(task.assignee)}
						</span>
					) : null}
				</span>
			</button>
			{/* The grip stays the keyboard activator so lifting a card has one stable,
			    labelled target even though the whole card is draggable by pointer. */}
			<button
				type="button"
				ref={setActivatorNodeRef}
				className="kb-drag-handle"
				data-kanban-move-task={task.id}
				disabled={!canWrite || (busyTaskId !== null && busyTaskId !== task.id)}
				aria-label={`Move task: ${displayTitle(task.title)}${unread ? " (unread)" : ""}`}
				// `aria-describedby` is intentionally absent: the sortable attributes below
				// point it at dnd-kit's own live drag instructions, which stay accurate.
				title={!canWrite ? "Reconnect to move tasks" : "Move task"}
				{...attributes}
				{...listeners}
			>
				<GripVertical size={16} aria-hidden="true" />
			</button>
			{unread ? <span className="kb-unread-dot" aria-hidden="true" /> : null}
		</article>
	);
}

interface ColumnProps {
	status: KanbanStatus;
	tasks: readonly KanbanTask[];
	isOver: boolean;
	canWrite: boolean;
	busyTaskId: string | null;
	unreadTaskIds: ReadonlySet<string>;
	onOpenTask(task: KanbanTask, trigger: HTMLButtonElement): void;
	onCreate(status: KanbanStatus, trigger: HTMLButtonElement): void;
}

function Column({
	status,
	tasks,
	isOver,
	canWrite,
	busyTaskId,
	unreadTaskIds,
	onOpenTask,
	onCreate,
}: ColumnProps): ReactNode {
	// The list itself is the droppable so an empty column is still a valid target.
	const { setNodeRef } = useDroppable({ id: status });
	return (
		<section
			className="kb-column"
			data-kanban-column={status}
			data-drop-target={isOver ? "true" : "false"}
			data-kanban-create-column={status}
			aria-labelledby={`kb-column-${status}`}
		>
			<header className="kb-column-header">
				<div>
					<h2 id={`kb-column-${status}`}>{STATUS_LABELS[status]}</h2>
					<span aria-label={`${tasks.length} tasks`}>{tasks.length}</span>
				</div>
				<button
					type="button"
					className="kb-icon-button"
					data-kanban-create-task={status}
					onClick={event => onCreate(status, event.currentTarget)}
					disabled={!canWrite}
					aria-label={`Create task in ${STATUS_LABELS[status]}`}
					title={!canWrite ? "Reconnect to create tasks" : `Create task in ${STATUS_LABELS[status]}`}
				>
					<Plus size={16} aria-hidden="true" />
				</button>
			</header>
			<div ref={setNodeRef} className="kb-column-list">
				<SortableContext items={tasks.map(task => task.id)} strategy={verticalListSortingStrategy}>
					{tasks.length === 0 ? (
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
						tasks.map(task => (
							<TaskCard
								key={task.id}
								task={task}
								canWrite={canWrite}
								busyTaskId={busyTaskId}
								unread={unreadTaskIds.has(task.id)}
								onOpenTask={onOpenTask}
							/>
						))
					)}
				</SortableContext>
			</div>
		</section>
	);
}

export function KanbanBoard({
	tasks,
	canWrite,
	busyTaskId,
	unreadTaskIds,
	onOpenTask,
	onCreate,
	onMove,
	onAnnounce,
}: KanbanBoardProps) {
	const boardRegionRef = useRef<HTMLElement>(null);
	const pendingG = useRef<{ taskId: string; at: number } | null>(null);
	const [columns, setColumns] = useState<ColumnMap>(() => groupByStatus(tasks));
	const [activeId, setActiveId] = useState<string | null>(null);
	const [overStatus, setOverStatus] = useState<KanbanStatus | null>(null);
	const [showShortcutHelp, setShowShortcutHelp] = useState(false);
	const taskMap = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
	const columnsRef = useRef(columns);

	useEffect(() => {
		columnsRef.current = columns;
	}, [columns]);

	// Server state wins whenever no drag is in flight; adopting it mid-drag would
	// yank the card out from under the pointer when an unrelated event lands.
	useEffect(() => {
		if (activeId === null) setColumns(groupByStatus(tasks));
	}, [tasks, activeId]);

	const sensors = useSensors(
		// A click is a press that never travelled: the distance gate is what keeps
		// opening a task and dragging it apart, with no click-suppression bookkeeping.
		useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
		// Touch holds the gesture for the browser until the delay elapses, so a
		// column still scrolls under a finger that is only swiping past a card.
		useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: vimCoordinateGetter }),
	);

	const containerOf = (id: string): KanbanStatus | null => {
		if (isKanbanStatus(id)) return id;
		return KANBAN_STATUSES.find(status => columnsRef.current[status].some(task => task.id === id)) ?? null;
	};

	const handleDragStart = ({ active }: DragStartEvent): void => {
		const id = String(active.id);
		setActiveId(id);
		onAnnounce(`Lifted ${displayTitle(taskMap.get(id)?.title ?? "")}.`);
	};

	const handleDragOver = ({ active, over }: DragOverEvent): void => {
		if (!over) return;
		const activeContainer = containerOf(String(active.id));
		const overContainer = containerOf(String(over.id));
		setOverStatus(overContainer);
		if (!activeContainer || !overContainer || activeContainer === overContainer) return;
		// Cross-column hand-off runs here, not on every pointer move: `over` only
		// changes when the cursor actually crosses into a different target.
		setColumns(current => {
			const from = current[activeContainer];
			const to = current[overContainer];
			const moving = from.find(task => task.id === active.id);
			if (!moving) return current;
			const overIndex = to.findIndex(task => task.id === over.id);
			const insertAt = overIndex >= 0 ? overIndex : to.length;
			return {
				...current,
				[activeContainer]: from.filter(task => task.id !== moving.id),
				[overContainer]: [...to.slice(0, insertAt), { ...moving, status: overContainer }, ...to.slice(insertAt)],
			};
		});
	};

	const handleDragEnd = ({ active, over }: DragEndEvent): void => {
		const id = String(active.id);
		const task = taskMap.get(id);
		setActiveId(null);
		setOverStatus(null);
		if (!over || !task) return;
		const container = containerOf(id);
		if (!container) return;
		const items = columnsRef.current[container];
		const from = items.findIndex(item => item.id === id);
		const overIndex = items.findIndex(item => item.id === over.id);
		const to = overIndex >= 0 ? overIndex : items.length - 1;
		const ordered = from === to ? items : arrayMove(items, from, to);
		if (from !== to) setColumns(current => ({ ...current, [container]: ordered }));
		const index = ordered.findIndex(item => item.id === id);
		if (task.status === container && task.position === index) return;
		void onMove(task, { status: container, index });
	};

	const handleDragCancel = (): void => {
		setActiveId(null);
		setOverStatus(null);
		setColumns(groupByStatus(tasks));
		onAnnounce("Move cancelled.");
	};

	const focusMoveHandle = (taskId: string): void => {
		const selector = `[data-kanban-move-task="${globalThis.CSS.escape(taskId)}"]`;
		boardRegionRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
	};

	const handleBoardKeyDown = (event: globalThis.KeyboardEvent): void => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		if (target.matches("input, textarea, select, [contenteditable]")) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		// A modal owns the keyboard while it is open; the board must not steal keys
		// from the task sheet or the activity dialog.
		if (document.querySelector("dialog[open]")) return;
		if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
			event.preventDefault();
			setShowShortcutHelp(value => !value);
			return;
		}
		if (showShortcutHelp && event.key === "Escape") {
			event.preventDefault();
			setShowShortcutHelp(false);
			return;
		}
		// A lifted card belongs to the keyboard sensor; navigation must not fight it.
		if (activeId !== null) return;
		const focusedCard = target.closest<HTMLElement>("[data-kanban-task]");
		const focusedTask = focusedCard ? taskMap.get(focusedCard.dataset.kanbanTask ?? "") : null;
		if (event.key === "c") {
			event.preventDefault();
			const status = focusedTask?.status ?? KANBAN_STATUSES[0];
			const trigger = boardRegionRef.current?.querySelector<HTMLButtonElement>(
				`[data-kanban-create-task="${status}"]`,
			);
			if (trigger && canWrite) onCreate(status, trigger);
			return;
		}
		if (!focusedTask) {
			// Nothing is focused on a fresh page load, so the first navigation key
			// adopts the first card instead of silently doing nothing.
			if (!"hjklgGo".includes(event.key)) return;
			const first = KANBAN_STATUSES.map(status => columns[status]).find(column => column.length > 0)?.[0];
			if (!first) return;
			event.preventDefault();
			focusMoveHandle(first.id);
			return;
		}
		const currentColumn = columns[focusedTask.status];
		const currentIndex = currentColumn.findIndex(task => task.id === focusedTask.id);
		let destinationTask: KanbanTask | undefined;
		if (event.key === "j" || event.key === "k") {
			const delta = event.key === "j" ? 1 : -1;
			destinationTask = currentColumn[Math.max(0, Math.min(currentColumn.length - 1, currentIndex + delta))];
		} else if (event.key === "h" || event.key === "l") {
			const step = event.key === "h" ? -1 : 1;
			for (
				let index = KANBAN_STATUSES.indexOf(focusedTask.status) + step;
				index >= 0 && index < KANBAN_STATUSES.length;
				index += step
			) {
				const candidateColumn = columns[KANBAN_STATUSES[index]!];
				if (candidateColumn.length > 0) {
					destinationTask = candidateColumn[Math.min(currentIndex, candidateColumn.length - 1)];
					break;
				}
			}
		} else if (event.key === "G") {
			destinationTask = currentColumn.at(-1);
		} else if (event.key === "g") {
			const now = Date.now();
			if (pendingG.current?.taskId === focusedTask.id && now - pendingG.current.at <= 600) {
				destinationTask = currentColumn[0];
				pendingG.current = null;
			} else {
				pendingG.current = { taskId: focusedTask.id, at: now };
				return;
			}
		} else if (event.key === "o") {
			event.preventDefault();
			const trigger = focusedCard?.querySelector<HTMLButtonElement>(".kb-card-open");
			if (trigger) onOpenTask(focusedTask, trigger);
			return;
		} else return;
		event.preventDefault();
		if (destinationTask) focusMoveHandle(destinationTask.id);
	};

	// The keymap lives on `document`, not on the board section: a React `onKeyDown`
	// there only fires once focus is already inside it, so on a fresh load every
	// shortcut was dead until the user clicked or tabbed into a card first.
	const latestKeyHandler = useRef(handleBoardKeyDown);
	useEffect(() => {
		latestKeyHandler.current = handleBoardKeyDown;
	});
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent): void => latestKeyHandler.current(event);
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const activeTask = activeId === null ? null : taskMap.get(activeId);

	return (
		<section ref={boardRegionRef} className="kb-board-region" aria-label="Kanban board">
			<p className="kb-keyboard-instructions" id="kb-move-instructions">
				Focus a card's Move task button; press Space to lift, arrows or h/j/k/l to move, Enter to place, or Escape
				to cancel. Use h/j/k/l to navigate, gg/G for column ends, o to open, c to create, and ? for shortcuts.
			</p>
			<DndContext
				sensors={sensors}
				collisionDetection={closestCorners}
				onDragStart={handleDragStart}
				onDragOver={handleDragOver}
				onDragEnd={handleDragEnd}
				onDragCancel={handleDragCancel}
			>
				<div className="kb-board" data-pointer-dragging={activeId ? "true" : "false"}>
					{KANBAN_STATUSES.map(status => (
						<Column
							key={status}
							status={status}
							tasks={columns[status]}
							isOver={overStatus === status}
							canWrite={canWrite}
							busyTaskId={busyTaskId}
							unreadTaskIds={unreadTaskIds}
							onOpenTask={onOpenTask}
							onCreate={onCreate}
						/>
					))}
				</div>
				<DragOverlay>
					{activeTask ? (
						<div className="kb-drag-preview" aria-hidden="true">
							<GripVertical size={16} />
							<span>{displayTitle(activeTask.title)}</span>
						</div>
					) : null}
				</DragOverlay>
			</DndContext>
			{showShortcutHelp ? (
				<div className="kb-shortcut-help" role="dialog" aria-modal="false" aria-label="Kanban keyboard shortcuts">
					<strong>Keyboard shortcuts</strong>
					<dl>
						<div>
							<dt>h j k l</dt>
							<dd>Navigate or move</dd>
						</div>
						<div>
							<dt>gg / G</dt>
							<dd>First / last card</dd>
						</div>
						<div>
							<dt>o / c</dt>
							<dd>Open / create</dd>
						</div>
						<div>
							<dt>Space / Enter</dt>
							<dd>Lift / place</dd>
						</div>
						<div>
							<dt>Esc / ?</dt>
							<dd>Cancel / close help</dd>
						</div>
					</dl>
				</div>
			) : null}
		</section>
	);
}
