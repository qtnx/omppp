import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { KANBAN_CLIENT_ASSETS } from "./client/assets.generated";
import { type KanbanModelApi, type KanbanRegistration, KanbanRuntime, type KanbanSessionPort } from "./runtime";

let runtime: KanbanRuntime | null = null;

export async function registerKanbanSession(session: KanbanSessionPort): Promise<KanbanRegistration> {
	runtime ??= new KanbanRuntime({ dbPath: getAgentDbPath(), assets: KANBAN_CLIENT_ASSETS });
	return await runtime.registerSession(session);
}

export async function unregisterKanbanSession(session: KanbanSessionPort): Promise<void> {
	if (!runtime) return;
	await runtime.unregisterSession(session);
	if (!runtime.running) runtime = null;
}

/**
 * Board access for the in-session Kanban tool. `null` when no board is running
 * for `sessionId`, which is the normal state outside interactive sessions.
 */
export function getKanbanModelApi(sessionId: string): KanbanModelApi | null {
	return runtime?.apiForSession(sessionId) ?? null;
}

/** A session that can own a board: disposal-aware and able to remount the tool. */
export interface KanbanBoardOwner extends KanbanSessionPort {
	readonly isDisposed: boolean;
	refreshKanbanTool?(): Promise<void>;
}

/**
 * Start (or re-report) this session's board and mount its `kanban` tool.
 *
 * Disposal can begin while registration awaits, so the owner is unwound rather
 * than leaving a board bound to a dead session. Returns `null` in that case.
 */
export async function startKanbanBoard(
	session: KanbanBoardOwner,
	register: (candidate: KanbanSessionPort) => Promise<KanbanRegistration> = registerKanbanSession,
	unregister: (candidate: KanbanSessionPort) => Promise<void> = unregisterKanbanSession,
): Promise<KanbanRegistration | null> {
	if (session.isDisposed) return null;
	const registration = await register(session);
	if (session.isDisposed) {
		await unregister(session);
		return null;
	}
	await session.refreshKanbanTool?.();
	return registration;
}

/** Stop this session's board and unmount its `kanban` tool. */
export async function stopKanbanBoard(session: KanbanBoardOwner): Promise<void> {
	await unregisterKanbanSession(session);
	await session.refreshKanbanTool?.();
}

/** Whether a board is currently running for this session id. */
export function isKanbanBoardRunning(sessionId: string): boolean {
	return getKanbanModelApi(sessionId) !== null;
}
