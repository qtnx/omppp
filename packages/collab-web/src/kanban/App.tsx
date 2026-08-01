import { Activity, CirclePlus, CloudOff, Columns3, RefreshCw, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemeToggle } from "../components/shell/ThemeToggle";
import { KanbanApi } from "./api";
import { KanbanBoard } from "./Board";
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
	type KanbanBoardSnapshot,
	type KanbanConnectionState,
	type KanbanStatus,
	type KanbanTask,
} from "./types";
import { ACTIVITY_LABELS, activityDetail, formatKanbanDate, STATUS_LABELS } from "./view-model";

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

function sessionIdFromPath(pathname: string): string | null {
	const match = /^\/kanban\/([^/]+)\/?$/.exec(pathname);
	if (!match) return null;
	try {
		const sessionId = decodeURIComponent(match[1]);
		return sessionId.length > 0 ? sessionId : null;
	} catch {
		return null;
	}
}

function ActivityDialog({
	activity,
	returnFocus,
	onDismiss,
}: {
	activity: readonly KanbanActivity[];
	returnFocus: HTMLElement | null;
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
							.map(item => (
								<li key={item.id}>
									<strong>{ACTIVITY_LABELS[item.type]}</strong>
									{activityDetail(item) ? <p>{activityDetail(item)}</p> : null}
									<time dateTime={item.createdAt}>{formatKanbanDate(item.createdAt)}</time>
								</li>
							))}
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
	const sessionId = useMemo(() => sessionIdFromPath(window.location.pathname), []);
	const [snapshot, setSnapshot] = useState<KanbanBoardSnapshot | null>(null);
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
	const activityTrigger = useRef<HTMLElement | null>(null);
	const connectionRef = useRef<KanbanConnectionState>(connection);
	const cursorRef = useRef(0);
	const realtimeRef = useRef<RealtimeState>(createRealtimeState(0));
	const loadGeneration = useRef(0);

	useEffect(() => {
		connectionRef.current = connection;
	}, [connection]);

	const api = useMemo(
		() => (sessionId ? new KanbanApi(sessionId, undefined, () => connectionRef.current) : null),
		[sessionId],
	);

	const loadBoard = useCallback(
		async (reason: "initial" | "event" | "reconnect" | "retry" | "conflict"): Promise<boolean> => {
			if (!api || !sessionId) return false;
			const generation = ++loadGeneration.current;
			if (reason === "initial" || reason === "retry") setLoading(true);
			try {
				const next = await api.loadBoard();
				if (generation !== loadGeneration.current) return false;
				if (
					next.tasks.some(task => task.sessionId !== sessionId) ||
					next.activity.some(item => item.sessionId !== sessionId)
				) {
					throw new KanbanProtocolError("The board returned data for a different session.");
				}
				setSnapshot(next);
				cursorRef.current = next.cursor;
				realtimeRef.current = createRealtimeState(next.cursor);
				setLoadError(null);
				setLoading(false);
				if (navigator.onLine) setConnection("connected");
				return true;
			} catch (error) {
				if (generation !== loadGeneration.current) return false;
				const message = error instanceof Error ? error.message : "Couldn't load this board.";
				setLoadError(`${message} Check the connection and try again.`);
				setLoading(false);
				setConnection(navigator.onLine ? "reconnecting" : "disconnected");
				return false;
			}
		},
		[api, sessionId],
	);

	useEffect(() => {
		void loadBoard("initial");
	}, [loadBoard]);

	useEffect(() => {
		if (!api || !sessionId) return;
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
					if (event.sessionId !== sessionId)
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
					void loadBoard("event");
				} catch {
					setNotice({ kind: "error", message: "A live update couldn't be read. Reloading the board." });
					void loadBoard("event");
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
	}, [api, loadBoard, sessionId]);

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
		setSheetError(null);
		try {
			return await action();
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
			setBusyTaskId(null);
		}
	};

	const selectedTask =
		sheet?.mode === "task" ? (snapshot?.tasks.find(task => task.id === sheet.taskId) ?? null) : null;
	const canWrite = connection === "connected" && !loading && !loadError;

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

	const moveTask = async (task: KanbanTask, requested: MoveDestination): Promise<void> => {
		if (!api || !snapshot) return;
		const destination = calculateMoveDestination(snapshot.tasks, task.id, requested.status, requested.index);
		if (task.status === destination.status && task.position === destination.index) {
			setAnnouncement(`${task.title} stayed in ${STATUS_LABELS[task.status]}, position ${task.position + 1}.`);
			return;
		}
		const moved = await runMutation(task.id, () =>
			api.moveTask(task.id, {
				expectedVersion: task.version,
				status: destination.status,
				index: destination.index,
			}),
		);
		if (!moved) return;
		await loadBoard("event");
		const message = `${moved.title} moved to ${STATUS_LABELS[moved.status]}, position ${moved.position + 1}.`;
		setNotice({ kind: "success", message });
		setAnnouncement(message);
	};

	if (!sessionId) {
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
						<h1>Session Kanban</h1>
						<p title={sessionId}>Session {sessionId}</p>
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
							onOpenTask={(task, trigger) => {
								setSheetError(null);
								setSheet({ mode: "task", taskId: task.id, status: task.status, trigger });
							}}
							onCreate={(status, trigger) => {
								setSheetError(null);
								setSheet({ mode: "create", status, trigger });
							}}
							onMove={moveTask}
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
					activity={snapshot?.activity ?? []}
					canWrite={canWrite}
					busy={busyTaskId !== null}
					serverError={sheetError}
					returnFocus={sheet.trigger}
					onSave={saveTask}
					onDelete={deleteTask}
					onRunMutation={runMutation}
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
					returnFocus={activityTrigger.current}
					onDismiss={() => setActivityOpen(false)}
				/>
			) : null}
		</div>
	);
}
