import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	CONTEXT_GC_CUSTOM_TYPE,
	type ContextGcDelta,
	type ContextGcReportSessionManager,
	type ContextRecord,
	type ContextStatus,
} from "./schema";
import type { ContextGcStore } from "./storage";

export interface BranchMessageEntry {
	readonly id: string;
	readonly message: AgentMessage;
}

export interface ContextGcSessionState {
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
	/** context-gc linkage deltas on the active branch path, in chronological order. */
	deltas: ContextGcDelta[];
	/** Message entries on the active branch path, used for stable entry-id linkage. */
	messageEntries: BranchMessageEntry[];
}

interface SessionEntryLike {
	type: string;
	id?: unknown;
	customType?: string;
	data?: unknown;
	message?: unknown;
	content?: unknown;
	display?: unknown;
	details?: unknown;
	attribution?: unknown;
	timestamp?: unknown;
}

function agentMessageFromCustomMessageEntry(entry: SessionEntryLike): AgentMessage | undefined {
	if (typeof entry.id !== "string" || typeof entry.customType !== "string") {
		return undefined;
	}
	const timestamp = typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : Date.now();
	return {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		display: entry.display === true,
		...(entry.details !== undefined ? { details: entry.details } : {}),
		...(typeof entry.attribution === "string" ? { attribution: entry.attribution } : {}),
		timestamp,
	} as AgentMessage;
}

interface BranchReader {
	getBranch?: () => unknown;
	getEntries: () => unknown;
}

function readBranchEntriesFromSessionManager(sessionManager: BranchReader): SessionEntryLike[] {
	const raw =
		typeof sessionManager.getBranch === "function" ? sessionManager.getBranch() : sessionManager.getEntries();
	return Array.isArray(raw) ? (raw as SessionEntryLike[]) : [];
}

function isContextGcDelta(value: unknown): value is ContextGcDelta {
	return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

/**
 * Rebuild current-branch state from a structural session manager. Deltas and message entries are
 * read from the active branch path (`getBranch`) rather than every session entry, so sibling-branch
 * control state never leaks in.
 */
export function readContextGcSessionStateFromSessionManager(options: {
	cwd: string;
	sessionManager: ContextGcReportSessionManager;
}): ContextGcSessionState {
	const sessionFile = options.sessionManager.getSessionFile() ?? undefined;
	const sessionId = options.sessionManager.getSessionId() ?? sessionFile ?? `cwd:${options.cwd}`;
	const entries = readBranchEntriesFromSessionManager(options.sessionManager);
	const deltas: ContextGcDelta[] = [];
	const messageEntries: BranchMessageEntry[] = [];

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CONTEXT_GC_CUSTOM_TYPE) {
			if (isContextGcDelta(entry.data)) deltas.push(entry.data);
			continue;
		}
		if (entry.type === "message" && typeof entry.id === "string" && entry.message) {
			messageEntries.push({ id: entry.id, message: entry.message as AgentMessage });
			continue;
		}
		if (entry.type === "custom_message") {
			const message = agentMessageFromCustomMessageEntry(entry);
			if (message) {
				messageEntries.push({ id: entry.id as string, message });
			}
		}
	}

	return { sessionId, sessionFile, cwd: options.cwd, deltas, messageEntries };
}

export function readContextGcSessionState(ctx: ExtensionContext): ContextGcSessionState {
	return readContextGcSessionStateFromSessionManager({ cwd: ctx.cwd, sessionManager: ctx.sessionManager });
}

/**
 * Branch-effective control state for a single record, replayed from active-branch deltas. The
 * status is authoritative over the DB status column; `summary` carries the unload replacement
 * summary and is only present while the record is unloaded on this branch.
 */
export interface BranchControl {
	readonly status: ContextStatus;
	readonly summary?: string;
}

/**
 * Replay context-gc deltas from the active branch path into per-record control state (status +
 * effective summary). This is branch-local: a record unloaded on one branch stays a candidate on a
 * sibling branch that lacks the unload delta, and the unload replacement summary lives only in the
 * branch delta — never in the durable DB summary. The global DB status is never consulted here.
 */
export function deriveBranchControl(deltas: readonly ContextGcDelta[]): Map<string, BranchControl> {
	const control = new Map<string, BranchControl>();
	for (const delta of deltas) {
		switch (delta.op) {
			case "candidate":
			case "unpin":
				// Re-candidating / unpinning drops any prior unload summary back to the DB base.
				control.set(delta.id, { status: "candidate" });
				break;
			case "unload":
				control.set(delta.id, { status: "unloaded", summary: delta.summary });
				break;
			case "pin":
				control.set(delta.id, { status: "pinned" });
				break;
			case "recall":
				// Recall returns content through the tool; it neither reloads the projection nor
				// alters the branch-effective status or summary.
				break;
		}
	}
	return control;
}

/**
 * Replay deltas into per-record statuses only. Retained for callers that gate purely on status.
 */
export function deriveBranchStatuses(deltas: readonly ContextGcDelta[]): Map<string, ContextStatus> {
	const statuses = new Map<string, ContextStatus>();
	for (const [id, control] of deriveBranchControl(deltas)) {
		statuses.set(id, control.status);
	}
	return statuses;
}

/**
 * Map of record id -> branch-effective replacement summary for records whose active-branch deltas
 * override the durable DB summary (currently only the unload op carries a replacement summary).
 */
export function deriveBranchSummaries(deltas: readonly ContextGcDelta[]): Map<string, string> {
	const summaries = new Map<string, string>();
	for (const [id, control] of deriveBranchControl(deltas)) {
		if (control.summary !== undefined) summaries.set(id, control.summary);
	}
	return summaries;
}

/**
 * Resolve the records controlled on the active branch with their branch-effective status and
 * summary applied. Only records carrying at least one delta on this branch are returned; the DB
 * status/summary are overridden by replayed branch control so projection/inventory/reminders never
 * trust global DB state for visible control.
 */
export function branchRecords(store: ContextGcStore, state: ContextGcSessionState): ContextRecord[] {
	const control = deriveBranchControl(state.deltas);
	const records: ContextRecord[] = [];
	for (const [id, ctrl] of control) {
		const record = store.getRecord(id);
		if (record && record.sessionId === state.sessionId) {
			records.push({ ...record, status: ctrl.status, summary: ctrl.summary ?? record.summary });
		}
	}
	return records;
}
