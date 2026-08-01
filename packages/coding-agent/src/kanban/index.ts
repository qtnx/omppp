import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { KANBAN_CLIENT_ASSETS } from "./client/assets.generated";
import { type KanbanRegistration, KanbanRuntime, type KanbanSessionPort } from "./runtime";

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
