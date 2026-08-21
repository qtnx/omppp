import { createHash } from "node:crypto";
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { KANBAN_CLIENT_ASSETS } from "./client/assets.generated";
import {
	type KanbanForkedAgent,
	type KanbanForkRequest,
	type KanbanModelApi,
	type KanbanRegistration,
	KanbanRuntime,
	type KanbanSessionPort,
	sessionBoardName,
} from "./runtime";

export * from "../linear/runtime";
export { sessionBoardName } from "./runtime";

export type KanbanBoardForker = (request: KanbanForkRequest) => Promise<KanbanForkedAgent | null>;
let runtime: KanbanRuntime | null = null;

/**
 * One board per project directory. The id is a short digest of the resolved
 * path so every session in the same checkout lands on the same URL, while two
 * checkouts of the same repo stay separate boards.
 */
export function boardIdForProject(projectDir: string = getProjectDir()): string {
	return createHash("sha256").update(path.resolve(projectDir)).digest("hex").slice(0, 16);
}

/** The board database lives beside the project, not in the global agent store. */
export function boardDbPath(projectDir: string = getProjectDir()): string {
	return path.join(path.resolve(projectDir), ".omp", "kanban.db");
}

export async function registerKanbanSession(session: KanbanSessionPort): Promise<KanbanRegistration> {
	runtime ??= new KanbanRuntime({
		dbPath: boardDbPath(),
		assets: KANBAN_CLIENT_ASSETS,
		boardId: boardIdForProject(),
	});
	return await runtime.registerSession(session);
}

export async function unregisterKanbanSession(session: KanbanSessionPort): Promise<void> {
	if (!runtime) return;
	const registered = boardPorts.get(session) ?? session;
	await runtime.unregisterSession(registered);
	boardPorts.delete(session);
	if (!runtime.running) runtime = null;
}

/**
 * Board access for the in-session Kanban tool. `null` when no board is running
 * for `sessionId`, which is the normal state outside interactive sessions.
 */
export function getKanbanModelApi(sessionId: string): KanbanModelApi | null {
	return runtime?.apiForSession(sessionId) ?? null;
}

/** Lets interactive mode add fork capability without changing SDK session shape. */
export function setKanbanBoardForker(session: KanbanBoardOwner, forker: KanbanBoardForker): void {
	boardForkers.set(session, forker);
}

/** Grants a background clone access to its parent session's live board API. */
export function attachKanbanForkedAgent(parentSessionId: string, agentSessionId: string): (() => void) | null {
	return runtime?.attachForkedAgent(parentSessionId, agentSessionId) ?? null;
}

/** A session that can own a board: disposal-aware and able to remount the tool. */
export interface KanbanBoardOwner extends KanbanSessionPort {
	readonly isDisposed: boolean;
	refreshKanbanTool?(): Promise<void>;
}

const boardForkers = new WeakMap<KanbanSessionPort, KanbanBoardForker>();
const boardPorts = new WeakMap<KanbanSessionPort, KanbanSessionPort>();

function boardPortFor(session: KanbanBoardOwner): KanbanSessionPort {
	const registered = boardPorts.get(session);
	if (registered) return registered;
	if (!boardForkers.has(session)) return session;
	const port: KanbanSessionPort = {
		get sessionId() {
			return session.sessionId;
		},
		get isStreaming() {
			return session.isStreaming;
		},
		get yieldQueue() {
			return session.yieldQueue;
		},
		promptCustomMessage: (message, options) => session.promptCustomMessage(message, options),
		emitNotice: (level, message, source) => session.emitNotice(level, message, source),
		forkBoardAgent: async request => (await boardForkers.get(session)?.(request)) ?? null,
		onKanbanEventsDurable: listener => session.onKanbanEventsDurable(listener),
		setKanbanBriefing: section => session.setKanbanBriefing(section),
		hasDurableKanbanEvent: eventId => session.hasDurableKanbanEvent(eventId),
	};
	boardPorts.set(session, port);
	return port;
}

/**
 * Start (or re-report) this project's board and mount this session's `kanban`
 * tool.
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
	const boardSession = boardPortFor(session);
	const registration = await register(boardSession);
	if (session.isDisposed) {
		await unregister(boardSession);
		return null;
	}
	await session.refreshKanbanTool?.();
	return registration;
}

/** Stop this session's board membership and unmount its `kanban` tool. */
export async function stopKanbanBoard(session: KanbanBoardOwner): Promise<void> {
	await unregisterKanbanSession(session);
	await session.refreshKanbanTool?.();
}

/** Whether this session currently participates in a running board. */
export function isKanbanBoardRunning(sessionId: string): boolean {
	return getKanbanModelApi(sessionId) !== null;
}

/** This session's board name, used as the assignee value on shared boards. */
export function kanbanSessionName(sessionId: string): string {
	return sessionBoardName(sessionId);
}
