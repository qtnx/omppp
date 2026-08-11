import { Activity, Bell, BellOff, CirclePlus, CloudOff, Columns3, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemeToggle } from "../components/shell/ThemeToggle";
import { KanbanApi } from "./api";
import { KanbanBoard } from "./Board";
import {
	disableNotifications,
	enableNotifications,
	notificationsEnabled,
	notificationsSupported,
	notifyBoardEvent,
	playBoardChime,
	setBoardAttention,
	setSoundEnabled,
	soundEnabled,
} from "./notify";
import { calculateMoveDestination, type MoveDestination } from "./reorder";
import {
	applyRealtimeEvent,
	classifyMutationFailure,
	createRealtimeState,
	KanbanProtocolError,
	parseKanbanEvent,
	type RealtimeState,
} from "./state";
import { TaskSheet } from "./TaskSheet";
import type { ValidTaskForm } from "./task-form";
import {
	isRecord,
	type KanbanActivity,
	type KanbanBoardSession,
	type KanbanBoardSnapshot,
	type KanbanConnectionState,
	type KanbanStatus,
	type KanbanTask,
} from "./types";
import { ACTIVITY_LABELS, activityDetail, displayTitle, formatKanbanDate, STATUS_LABELS } from "./view-model";

interface CreateSheetState {
	mode: "create";
	status: KanbanStatus;
	trigger: HTMLElement;
}

interface TaskSheetState {
	mode: "task";
	taskId: string;
	status: KanbanStatus;
	trigger: HTMLElement;
}

type SheetState = CreateSheetState | TaskSheetState;

type NoticeKind = "info" | "success" | "conflict" | "error";

interface Notice {
	kind: NoticeKind;
	message: string;
}

function boardIdFromPath(pathname: string): string | null {
	const match = /^\/kanban\/([^/]+)\/?$/.exec(pathname);
	if (!match) return null;
	try {
		const boardId = decodeURIComponent(match[1]);
		return boardId.length > 0 ? boardId : null;
	} catch {
		return null;
	}
}

type SeenTaskVersions = Record<string, string>;

const SEEN_TASK_STORAGE_KEY_PREFIX = "ompx.kanban.seen.";
/** Trailing window that folds a burst of live events into one snapshot fetch. */
const EVENT_LOAD_COALESCE_MS = 300;
/**
 * Fingerprint of the exact row a change produced. Matching an incoming event
 * against what this tab just wrote is how a self-echo is recognised; a time
 * window keyed on the task id would also swallow someone else's comment landing
 * on the same task seconds later.
 */
function entityEcho(value: unknown): string | null {
	if (!isRecord(value) || typeof value.id !== "string") return null;
	const kind = "taskId" in value ? "comment" : "task";
	return `${kind}:${value.id}:${String(value.version)}`;
}

/**
 * A card is marked unread only for conversation, never for board mechanics.
 * Moving a task or editing its fields is already visible in place; a comment is
 * the only change that carries something someone has to read.
 */
function taskSeenVersion(task: KanbanTask): string {
	return String(task.commentCount);
}

function readSeenTaskVersions(boardId: string): SeenTaskVersions | null {
	try {
		const serialized = globalThis.localStorage.getItem(`${SEEN_TASK_STORAGE_KEY_PREFIX}${boardId}`);
		if (serialized === null) return null;
		const parsed: unknown = JSON.parse(serialized);
		if (!isRecord(parsed)) return null;
		const entries: Array<[string, string]> = [];
		for (const [taskId, version] of Object.entries(parsed)) {
			if (typeof version !== "string") return null;
			entries.push([taskId, version]);
		}
		return Object.fromEntries(entries);
	} catch {
		return null;
	}
}

function writeSeenTaskVersions(boardId: string, seen: SeenTaskVersions): void {
	try {
		globalThis.localStorage.setItem(`${SEEN_TASK_STORAGE_KEY_PREFIX}${boardId}`, JSON.stringify(seen));
	} catch {
		// Private-mode or quota failures leave the current in-memory state usable.
	}
}

/**
 * Drops rows for tasks that no longer exist and enrols tasks this browser has
 * never seen at their current fingerprint. Enrolling matters: a task appearing
 * on the board is not something to read, so it starts read and only its first
 * comment lights it up.
 */
function reconcileSeenTaskVersions(seen: SeenTaskVersions, tasks: readonly KanbanTask[]): SeenTaskVersions {
	return Object.fromEntries(tasks.map(task => [task.id, seen[task.id] ?? taskSeenVersion(task)] as const));
}

function ActivityDialog({
	activity,
	tasks,
	returnFocus,
	onOpenTask,
	onDismiss,
}: {
	activity: readonly KanbanActivity[];
	tasks: readonly KanbanTask[];
	returnFocus: HTMLElement | null;
	onOpenTask(task: KanbanTask, trigger: HTMLElement): void;
	onDismiss(): void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		if (ref.current && !ref.current.open) ref.current.showModal();
	}, []);
	const dismiss = (): void => {
		onDismiss();
		requestAnimationFrame(() => returnFocus?.focus());
	};
	return (
		<dialog ref={ref} className="kb-activity-dialog" aria-labelledby="kb-activity-title" onClose={dismiss}>
			<div className="kb-activity-dialog-frame">
				<header>
					<div>
						<p>Board history</p>
						<h2 id="kb-activity-title">Recent activity</h2>
					</div>
					<button
						type="button"
						className="kb-icon-button"
						onClick={() => ref.current?.close()}
						aria-label="Close activity history"
					>
						<X size={18} aria-hidden="true" />
					</button>
				</header>
				{activity.length === 0 ? (
					<div className="kb-activity-empty">
						<h3>No activity yet</h3>
						<p>Task and comment changes will appear here.</p>
					</div>
				) : (
					<ol className="kb-activity-list">
						{[...activity]
							.sort((left, right) => right.cursor - left.cursor)
							.map(item => {
								const detail = activityDetail(item);
								// A history line that only says "Task moved" makes the reader guess.
								// Name the task, and make it the way back to that task.
								const task = item.taskId ? tasks.find(candidate => candidate.id === item.taskId) : undefined;
								return (
									<li key={item.id}>
										{task ? (
											<button
												type="button"
												className="kb-activity-entry"
												onClick={event => onOpenTask(task, event.currentTarget)}
											>
												<strong>{ACTIVITY_LABELS[item.type]}</strong>
												<span className="kb-activity-task">{displayTitle(task.title)}</span>
												{detail ? <p>{detail}</p> : null}
											</button>
										) : (
											<div className="kb-activity-entry" data-static="true">
												<strong>{ACTIVITY_LABELS[item.type]}</strong>
												{item.taskId ? <span className="kb-activity-task">Deleted task</span> : null}
												{detail ? <p>{detail}</p> : null}
											</div>
										)}
										<time dateTime={item.createdAt}>{formatKanbanDate(item.createdAt)}</time>
									</li>
								);
							})}
					</ol>
				)}
			</div>
		</dialog>
	);
}

function LoadingBoard(): ReactNode {
	return (
		<div className="kb-loading" aria-busy="true" aria-label="Loading Kanban board">
			{Array.from({ length: 7 }, (_, column) => (
				<div className="kb-loading-column" key={column}>
					<span className="kb-skeleton kb-skeleton-heading" />
					{Array.from({ length: column % 3 === 0 ? 3 : 2 }, (_, card) => (
						<span className="kb-skeleton kb-skeleton-card" key={card} />
					))}
				</div>
			))}
			<span className="kb-sr-only">Loading tasks...</span>
		</div>
	);
}

export function KanbanApp() {
	const boardId = useMemo(() => boardIdFromPath(window.location.pathname), []);
	const [snapshot, setSnapshot] = useState<KanbanBoardSnapshot | null>(null);
	const [seenTaskVersions, setSeenTaskVersions] = useState<SeenTaskVersions | null>(() =>
		boardId ? readSeenTaskVersions(boardId) : null,
	);
	const [connection, setConnection] = useState<KanbanConnectionState>(() =>
		navigator.onLine ? "loading" : "disconnected",
	);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [sheet, setSheet] = useState<SheetState | null>(null);
	const [sheetError, setSheetError] = useState<string | null>(null);
	const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
	const [activityOpen, setActivityOpen] = useState(false);
	const [notifyOn, setNotifyOn] = useState(() => notificationsEnabled());
	const [sessions, setSessions] = useState<readonly KanbanBoardSession[]>([]);
	const [soundOn, setSoundOn] = useState(() => soundEnabled());
	const [unseen, setUnseen] = useState(0);
	const activityTrigger = useRef<HTMLElement | null>(null);
	const connectionRef = useRef<KanbanConnectionState>(connection);
	const cursorRef = useRef(0);
	const realtimeRef = useRef<RealtimeState>(createRealtimeState(0));
	const loadGeneration = useRef(0);
	/** Fingerprints of rows this tab just wrote, consumed when their event echoes back. */
	const localEchoes = useRef(new Set<string>());
	/** Task whose mutation is in flight: its event can outrun the HTTP response. */
	const inFlightTaskId = useRef<string | null>(null);
	/** Aborts the in-flight snapshot fetch when a newer load supersedes it. */
	const loadAbort = useRef<AbortController | null>(null);
	/** Pending trailing load for a burst of live events. */
	const eventLoadTimer = useRef<number | null>(null);

	useEffect(() => {
		connectionRef.current = connection;
	}, [connection]);

	useEffect(() => {
		setBoardAttention(unseen);
	}, [unseen]);

	useEffect(() => {
		const onVisibility = (): void => {
			if (document.visibilityState === "visible") setUnseen(0);
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, []);

	const api = useMemo(
		() => (boardId ? new KanbanApi(boardId, undefined, () => connectionRef.current) : null),
		[boardId],
	);

	const synchronizeSeenTaskVersions = useCallback(
		(tasks: readonly KanbanTask[]): void => {
			if (!boardId) return;
			setSeenTaskVersions(current => {
				if (current === null) {
					const seeded = Object.fromEntries(tasks.map(task => [task.id, taskSeenVersion(task)] as const));
					writeSeenTaskVersions(boardId, seeded);
					return seeded;
				}
				const reconciled = reconcileSeenTaskVersions(current, tasks);
				const unchanged =
					Object.keys(current).length === Object.keys(reconciled).length &&
					Object.entries(current).every(([taskId, version]) => reconciled[taskId] === version);
				if (unchanged) return current;
				writeSeenTaskVersions(boardId, reconciled);
				return reconciled;
			});
		},
		[boardId],
	);

	const loadBoard = useCallback(
		async (reason: "initial" | "event" | "reconnect" | "retry" | "conflict"): Promise<boolean> => {
			if (!api || !boardId) return false;
			const generation = ++loadGeneration.current;
			// One snapshot is hundreds of kilobytes. A superseded request is not just
			// an ignored result: left running it competes for the same link as the
			// load that replaced it, which is how a burst of events used to turn into
			// a pile of overlapping fetches that never settled.
			loadAbort.current?.abort();
			const controller = new AbortController();
			loadAbort.current = controller;
			if (reason === "initial" || reason === "retry") setLoading(true);
			try {
				const next = await api.loadBoard(controller.signal);
				if (generation !== loadGeneration.current) return false;
				if (
					next.tasks.some(task => task.boardId !== boardId) ||
					next.activity.some(item => item.boardId !== boardId)
				) {
					throw new KanbanProtocolError("The board returned data for a different session.");
				}
				synchronizeSeenTaskVersions(next.tasks);
				setSnapshot(next);
				cursorRef.current = next.cursor;
				realtimeRef.current = createRealtimeState(next.cursor);
				setLoadError(null);
				setLoading(false);
				if (navigator.onLine) setConnection("connected");
				return true;
			} catch (error) {
				// A newer load cancelled this one; it owns the outcome, so stay silent.
				if (controller.signal.aborted) return false;
				if (generation !== loadGeneration.current) return false;
				const message = error instanceof Error ? error.message : "Couldn't load this board.";
				setLoadError(`${message} Check the connection and try again.`);
				setLoading(false);
				setConnection(navigator.onLine ? "reconnecting" : "disconnected");
				return false;
			} finally {
				if (loadAbort.current === controller) loadAbort.current = null;
			}
		},
		[api, boardId, synchronizeSeenTaskVersions],
	);

	/**
	 * Events arrive in bursts — an agent moving a task writes several in a row,
	 * and each one used to trigger its own full-snapshot fetch. Collapsing a burst
	 * into one trailing load keeps the board current without the stampede.
	 */
	const scheduleEventLoad = useCallback((): void => {
		if (eventLoadTimer.current !== null) return;
		eventLoadTimer.current = window.setTimeout(() => {
			eventLoadTimer.current = null;
			void loadBoard("event");
		}, EVENT_LOAD_COALESCE_MS);
	}, [loadBoard]);

	useEffect(
		() => () => {
			if (eventLoadTimer.current !== null) window.clearTimeout(eventLoadTimer.current);
			eventLoadTimer.current = null;
			loadAbort.current?.abort();
		},
		[],
	);

	useEffect(() => {
		void loadBoard("initial");
	}, [loadBoard]);

	// Assignees are live sessions, so the picker refreshes on the same cadence
	// the server ages them out with.
	useEffect(() => {
		if (!api) return;
		let stopped = false;
		const refresh = async (): Promise<void> => {
			try {
				const next = await api.listSessions();
				if (!stopped) setSessions(next);
			} catch {
				if (!stopped) setSessions([]);
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 15_000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [api]);

	useEffect(() => {
		if (!api || !boardId) return;
		let stopped = false;
		let source: EventSource | null = null;
		let reconnectTimer: number | null = null;
		let retryDelay = 750;

		const scheduleReconnect = (): void => {
			if (stopped || !navigator.onLine || reconnectTimer !== null) return;
			setConnection("reconnecting");
			reconnectTimer = window.setTimeout(() => {
				reconnectTimer = null;
				connect();
			}, retryDelay);
			retryDelay = Math.min(retryDelay * 2, 10_000);
		};

		const connect = (): void => {
			if (stopped || !navigator.onLine) return;
			source?.close();
			source = new EventSource(api.eventsUrl(cursorRef.current));
			source.onopen = () => {
				retryDelay = 750;
				setConnection("connected");
			};
			source.onmessage = message => {
				try {
					const raw: unknown = JSON.parse(message.data);
					const candidate = isRecord(raw) && isRecord(raw.data) && "cursor" in raw.data ? raw.data : raw;
					const event = parseKanbanEvent(candidate);
					if (event.boardId !== boardId)
						throw new KanbanProtocolError("A live update targeted a different session.");
					const nextRealtime = applyRealtimeEvent(realtimeRef.current, event);
					if (nextRealtime === realtimeRef.current) return;
					realtimeRef.current = nextRealtime;
					cursorRef.current = nextRealtime.cursor;
					setSnapshot(current =>
						current
							? {
									...current,
									cursor: nextRealtime.cursor,
									activity: current.activity.some(item => item.id === event.id)
										? current.activity
										: [...current.activity, event],
								}
							: current,
					);
					// A change this tab made already reported itself; re-announcing the echo
					// would replace that specific message with a vaguer one.
					// The event can outrun its own HTTP response, so an in-flight mutation on
					// the same task counts as ours too, not just an already-recorded echo.
					const echo = entityEcho(event.data.comment) ?? entityEcho(event.data.task);
					const ownEcho = echo !== null && localEchoes.current.delete(echo);
					const ownInFlight = event.taskId !== null && event.taskId === inFlightTaskId.current;
					if (!ownEcho && !ownInFlight) {
						const detail = activityDetail(event);
						const label = ACTIVITY_LABELS[event.type];
						setNotice({ kind: "info", message: detail ? `${label} — ${detail}` : label });
						// Only conversation interrupts. A status change is board mechanics: it
						// is already visible on the board, so it never earns a chime, a badge,
						// or a desktop notification the way a comment addressed to you does.
						if (event.type === "comment.created") {
							notifyBoardEvent(event);
							playBoardChime();
							if (document.visibilityState !== "visible") setUnseen(count => count + 1);
						}
					}
					scheduleEventLoad();
				} catch {
					setNotice({ kind: "error", message: "A live update couldn't be read. Reloading the board." });
					scheduleEventLoad();
				}
			};
			source.onerror = () => {
				source?.close();
				source = null;
				scheduleReconnect();
			};
		};

		const offline = (): void => {
			source?.close();
			source = null;
			setConnection("disconnected");
			setNotice({ kind: "error", message: "Connection lost. Changes are disabled until the board reconnects." });
		};
		const online = (): void => {
			setConnection("reconnecting");
			void loadBoard("reconnect").then(connect);
		};

		window.addEventListener("offline", offline);
		window.addEventListener("online", online);
		connect();
		return () => {
			stopped = true;
			source?.close();
			if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
			window.removeEventListener("offline", offline);
			window.removeEventListener("online", online);
		};
	}, [api, loadBoard, scheduleEventLoad, boardId]);

	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const updateHeight = (): void => {
			document.documentElement.style.setProperty("--viewport-height", `${viewport.height}px`);
		};
		updateHeight();
		viewport.addEventListener("resize", updateHeight);
		return () => viewport.removeEventListener("resize", updateHeight);
	}, []);

	useEffect(() => {
		document.title = "Kanban board | OMPx";
		if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/kanban/" });
	}, []);

	useEffect(() => {
		if (sheet?.mode !== "task" || !snapshot) return;
		if (!snapshot.tasks.some(task => task.id === sheet.taskId)) {
			setSheet(null);
			setAnnouncement("The open task no longer exists. The board has been refreshed.");
			requestAnimationFrame(() => sheet.trigger.focus());
		}
	}, [sheet, snapshot]);

	const runMutation = async <T,>(taskId: string | null, action: () => Promise<T>): Promise<T | null> => {
		setBusyTaskId(taskId ?? "board");
		inFlightTaskId.current = taskId;
		setSheetError(null);
		try {
			const result = await action();
			const echo = entityEcho(result);
			if (echo !== null) {
				// Bounded: an echo that never arrives (offline, dropped stream) must not
				// pin memory, so the oldest entry falls out once the set gets long.
				if (localEchoes.current.size >= 64) {
					const oldest = localEchoes.current.values().next().value;
					if (oldest !== undefined) localEchoes.current.delete(oldest);
				}
				localEchoes.current.add(echo);
			}
			return result;
		} catch (error) {
			const resolution = classifyMutationFailure(error);
			setNotice({ kind: resolution.kind === "conflict" ? "conflict" : "error", message: resolution.announcement });
			setSheetError(resolution.announcement);
			setAnnouncement(resolution.announcement);
			if (resolution.reloadRequired) await loadBoard("conflict");
			else if (!navigator.onLine || (isRecord(error) && error.code === "disconnected"))
				setConnection("disconnected");
			return null;
		} finally {
			inFlightTaskId.current = null;
			setBusyTaskId(null);
		}
	};

	const selectedTask =
		sheet?.mode === "task" ? (snapshot?.tasks.find(task => task.id === sheet.taskId) ?? null) : null;
	const canWrite = connection === "connected" && !loading && !loadError;
	// Every label already in use on the board, deduped case-insensitively so `Bug`
	// and `bug` offer one chip instead of two.
	const knownLabels = useMemo(
		() =>
			[
				...new Map(
					(snapshot?.tasks ?? [])
						.flatMap(task => task.labels)
						.filter(label => label.length > 0)
						.map(label => [label.toLocaleLowerCase(), label]),
				).values(),
			].sort((left, right) => left.localeCompare(right)),
		[snapshot],
	);

	const markTaskRead = useCallback(
		(task: KanbanTask): void => {
			if (!boardId) return;
			const version = taskSeenVersion(task);
			setSeenTaskVersions(current => {
				const seen = current ?? {};
				if (seen[task.id] === version) return current ?? seen;
				const next = { ...seen, [task.id]: version };
				writeSeenTaskVersions(boardId, next);
				return next;
			});
		},
		[boardId],
	);

	const unreadTaskIds = useMemo<ReadonlySet<string>>(() => {
		if (!snapshot || seenTaskVersions === null) return new Set();
		return new Set(
			snapshot.tasks.filter(task => seenTaskVersions[task.id] !== taskSeenVersion(task)).map(task => task.id),
		);
	}, [seenTaskVersions, snapshot?.tasks]);

	const saveTask = async (valid: ValidTaskForm): Promise<boolean> => {
		if (!api || !sheet) return false;
		if (sheet.mode === "create") {
			const created = await runMutation(null, () => api.createTask(valid.create));
			if (!created) return false;
			await loadBoard("event");
			setNotice({ kind: "success", message: `${created.title} created in ${STATUS_LABELS[created.status]}.` });
			setAnnouncement(`${created.title} created.`);
			return true;
		}
		if (!selectedTask) return false;
		const updated = await runMutation(selectedTask.id, () =>
			api.updateTask(selectedTask.id, {
				...valid.updateFields,
				expectedVersion: selectedTask.version,
			}),
		);
		if (!updated) return false;
		await loadBoard("event");
		setNotice({ kind: "success", message: `${updated.title} updated.` });
		setAnnouncement(`${updated.title} updated.`);
		return true;
	};

	const deleteTask = async (task: KanbanTask): Promise<boolean> => {
		if (!api) return false;
		const result = await runMutation(task.id, async () => {
			await api.deleteTask(task.id, task.version);
			return true;
		});
		if (!result) return false;
		await loadBoard("event");
		setNotice({ kind: "success", message: `${task.title} deleted.` });
		setAnnouncement(`${task.title} deleted.`);
		return true;
	};

	const moveTask = async (task: KanbanTask, requested: MoveDestination): Promise<boolean> => {
		if (!api || !snapshot) return false;
		const destination = calculateMoveDestination(snapshot.tasks, task.id, requested.status, requested.index);
		if (task.status === destination.status && task.position === destination.index) {
			setAnnouncement(`${task.title} stayed in ${STATUS_LABELS[task.status]}, position ${task.position + 1}.`);
			return true;
		}
		const moved = await runMutation(task.id, () =>
			api.moveTask(task.id, {
				expectedVersion: task.version,
				status: destination.status,
				index: destination.index,
			}),
		);
		if (!moved) return false;
		await loadBoard("event");
		const message = `${moved.title} moved to ${STATUS_LABELS[moved.status]}, position ${moved.position + 1}.`;
		setNotice({ kind: "success", message });
		setAnnouncement(message);
		return true;
	};

	/**
	 * Status chosen in the task sheet. The server has no status field on PATCH —
	 * a task changes column only through `/moves`, which needs a destination
	 * index — so the dropdown reuses the drag path and lands the card at the end
	 * of its new column rather than displacing whatever is at the top.
	 */
	const changeTaskStatus = (task: KanbanTask, status: KanbanStatus): Promise<boolean> => {
		const end = snapshot?.tasks.filter(item => item.status === status && item.id !== task.id).length ?? 0;
		return moveTask(task, { status, index: end });
	};

	if (!boardId) {
		return (
			<main className="kb-fatal">
				<Columns3 size={28} aria-hidden="true" />
				<h1>Board link not recognized</h1>
				<p>Open the complete Kanban link from your OMPx session.</p>
			</main>
		);
	}

	return (
		<div className="kb-app">
			<header className="kb-header">
				<div className="kb-brand">
					<span className="kb-brand-mark" aria-hidden="true">
						<Columns3 size={17} />
					</span>
					<div>
						<h1>Project Kanban</h1>
						<p title={boardId}>
							{sessions.length === 0
								? "No sessions connected"
								: `${sessions.length} session${sessions.length === 1 ? "" : "s"}: ${sessions.map(session => session.name).join(", ")}`}
						</p>
					</div>
				</div>
				<div className="kb-header-actions">
					<span className="kb-connection" data-state={connection}>
						{connection === "connected"
							? "Live"
							: connection === "loading"
								? "Connecting"
								: connection === "reconnecting"
									? "Reconnecting"
									: "Disconnected"}
					</span>
					<button
						type="button"
						className="kb-button"
						onClick={event => {
							activityTrigger.current = event.currentTarget;
							setActivityOpen(true);
						}}
					>
						<Activity size={16} aria-hidden="true" /> Activity
					</button>
					{notificationsSupported() ? (
						<button
							type="button"
							className="kb-icon-button"
							aria-pressed={notifyOn}
							title={notifyOn ? "Board notifications on" : "Notify me when the agent changes the board"}
							aria-label={notifyOn ? "Turn board notifications off" : "Turn board notifications on"}
							onClick={async () => {
								if (notifyOn) {
									disableNotifications();
									setNotifyOn(false);
									return;
								}
								setNotifyOn(await enableNotifications());
							}}
						>
							{notifyOn ? <Bell size={16} aria-hidden="true" /> : <BellOff size={16} aria-hidden="true" />}
						</button>
					) : null}
					<button
						type="button"
						className="kb-icon-button"
						aria-pressed={soundOn}
						title={soundOn ? "Sound on for board activity" : "Sound off for board activity"}
						aria-label={soundOn ? "Turn activity sound off" : "Turn activity sound on"}
						onClick={() => {
							const next = !soundOn;
							setSoundEnabled(next);
							setSoundOn(next);
							// Play on enable so the click doubles as a preview and unlocks audio.
							if (next) playBoardChime();
						}}
					>
						{soundOn ? <Volume2 size={16} aria-hidden="true" /> : <VolumeX size={16} aria-hidden="true" />}
					</button>
					<ThemeToggle />
					<button
						type="button"
						className="kb-button kb-button-primary"
						disabled={!canWrite}
						onClick={event => {
							setSheetError(null);
							setSheet({ mode: "create", status: "backlog", trigger: event.currentTarget });
						}}
						title={!canWrite ? "Reconnect to create tasks" : "Create task"}
					>
						<CirclePlus size={16} aria-hidden="true" /> Create task
					</button>
				</div>
			</header>

			{connection !== "connected" ? (
				<div className="kb-connection-banner" role="status">
					<CloudOff size={17} aria-hidden="true" />
					<div>
						<strong>{connection === "disconnected" ? "Board disconnected" : "Reconnecting to the board"}</strong>
						<p>Changes are disabled. Nothing will be queued offline.</p>
					</div>
					<button type="button" className="kb-button" onClick={() => void loadBoard("reconnect")}>
						<RefreshCw size={15} aria-hidden="true" /> Reload
					</button>
				</div>
			) : null}

			{notice ? (
				<div className="kb-notice" data-kind={notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
					<span>{notice.message}</span>
					<button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message">
						<X size={15} aria-hidden="true" />
					</button>
				</div>
			) : null}

			<main className="kb-main">
				{loading ? (
					<LoadingBoard />
				) : loadError ? (
					<div className="kb-load-error" role="alert">
						<h2>Couldn't load this board</h2>
						<p>{loadError}</p>
						<button type="button" className="kb-button kb-button-primary" onClick={() => void loadBoard("retry")}>
							<RefreshCw size={16} aria-hidden="true" /> Try again
						</button>
					</div>
				) : snapshot ? (
					<>
						{snapshot.tasks.length === 0 ? (
							<section className="kb-board-empty" aria-labelledby="kb-empty-title">
								<div>
									<h2 id="kb-empty-title">Plan the first task</h2>
									<p>This board keeps work ordered from backlog through done.</p>
								</div>
								<button
									type="button"
									className="kb-button kb-button-primary"
									disabled={!canWrite}
									onClick={event =>
										setSheet({ mode: "create", status: "backlog", trigger: event.currentTarget })
									}
								>
									Create first task
								</button>
							</section>
						) : null}
						<KanbanBoard
							tasks={snapshot.tasks}
							canWrite={canWrite}
							busyTaskId={busyTaskId}
							unreadTaskIds={unreadTaskIds}
							onOpenTask={(task, trigger) => {
								setSheetError(null);
								markTaskRead(task);
								setSheet({ mode: "task", taskId: task.id, status: task.status, trigger });
							}}
							onCreate={(status, trigger) => {
								setSheetError(null);
								setSheet({ mode: "create", status, trigger });
							}}
							onMove={async (task, destination) => {
								await moveTask(task, destination);
							}}
							onAnnounce={setAnnouncement}
						/>
					</>
				) : null}
			</main>

			<div className="kb-sr-only" role="status" aria-live="polite" aria-atomic="true">
				{announcement}
			</div>

			{sheet && api ? (
				<TaskSheet
					task={selectedTask}
					defaultStatus={sheet.status}
					api={api}
					sessions={sessions}
					knownLabels={knownLabels}
					activity={snapshot?.activity ?? []}
					canWrite={canWrite}
					busy={busyTaskId !== null}
					serverError={sheetError}
					returnFocus={sheet.trigger}
					onSave={saveTask}
					onDelete={deleteTask}
					onRunMutation={runMutation}
					onStatusChange={changeTaskStatus}
					onAnnounce={setAnnouncement}
					onDismiss={() => {
						setSheet(null);
						setSheetError(null);
					}}
				/>
			) : null}

			{activityOpen ? (
				<ActivityDialog
					activity={snapshot?.activity ?? []}
					tasks={snapshot?.tasks ?? []}
					returnFocus={activityTrigger.current}
					onOpenTask={(task, trigger) => {
						// Jumping straight from history to the task means the activity dialog
						// closes first: two stacked modals would trap focus in the wrong one.
						setActivityOpen(false);
						setSheetError(null);
						markTaskRead(task);
						setSheet({ mode: "task", taskId: task.id, status: task.status, trigger });
					}}
					onDismiss={() => setActivityOpen(false)}
				/>
			) : null}
		</div>
	);
}
