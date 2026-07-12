import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { analyzeActiveContext } from "./active-context";
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
	const hasUnloadDelta = state.deltas.some(delta => delta.op === "unload" && delta.sessionId === state.sessionId);
	if (options.recordIds !== undefined && options.recordIds.length === 0) return undefined;
	if (!hasUnloadDelta) return undefined;

	const store = openContextGcStore({ dbPath: options.dbPath });
	try {
		const records = filterRecordsById(branchRecords(store, state), options.recordIds);
		const active = analyzeActiveContext(options.messages, records);
		const savedTokens = [...active.matches.values()]
			.filter(match => match.record.status === "unloaded")
			.reduce((total, match) => total + match.estimate.netTokens, 0);
		if (savedTokens === 0) return undefined;
		return Math.max(options.baseTokens > 0 ? 1 : 0, options.baseTokens - savedTokens);
	} finally {
		store.close();
	}
}
