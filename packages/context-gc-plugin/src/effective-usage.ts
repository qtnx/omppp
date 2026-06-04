import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { projectUnloadedContext } from "./context-transform";
import type { ContextGcReportSessionManager } from "./schema";
import { branchRecords, readContextGcSessionStateFromSessionManager } from "./session-state";
import { openContextGcStore } from "./storage";

export interface ContextGcEffectiveTokenOptions {
	dbPath: string;
	cwd: string;
	sessionManager: ContextGcReportSessionManager;
	messages: readonly AgentMessage[];
	baseTokens: number;
	recordIds?: readonly string[];
}

function estimateMessages(messages: readonly AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

function hasSuccessfulContextUnload(messages: readonly AgentMessage[]): boolean {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const surface = message as unknown as Record<string, unknown>;
		if (surface.role === "toolResult" && surface.toolName === "context_unload" && surface.isError === false) {
			return true;
		}
	}
	return false;
}

function filterRecordsById<T extends { id: string }>(records: readonly T[], ids: readonly string[] | undefined): T[] {
	if (ids === undefined) return [...records];
	const allowed = new Set(ids);
	return records.filter(record => allowed.has(record.id));
}

export function estimateContextGcEffectiveTokens(options: ContextGcEffectiveTokenOptions): number | undefined {
	const state = readContextGcSessionStateFromSessionManager({
		cwd: options.cwd,
		sessionManager: options.sessionManager,
	});
	const hasUnloadDelta = state.deltas.some(delta => delta.op === "unload");
	const hasCleanupResult = hasSuccessfulContextUnload(options.messages);
	if (options.recordIds !== undefined && options.recordIds.length === 0 && !hasCleanupResult) return undefined;
	if (!hasUnloadDelta && !hasCleanupResult) return undefined;

	const store = openContextGcStore({ dbPath: options.dbPath });
	try {
		const records = filterRecordsById(branchRecords(store, state), options.recordIds);
		if (!records.some(record => record.status === "unloaded") && !hasCleanupResult) return undefined;

		const projectedMessages = projectUnloadedContext(options.messages, records);
		const rawTokens = estimateMessages(options.messages);
		const projectedTokens = estimateMessages(projectedMessages);
		const savedTokens = Math.max(0, rawTokens - projectedTokens);
		if (savedTokens === 0) return undefined;
		return Math.max(0, options.baseTokens - savedTokens);
	} finally {
		store.close();
	}
}
