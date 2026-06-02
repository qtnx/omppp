import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import {
	CONTEXT_GC_CUSTOM_TYPE,
	type ContextGcDelta,
	type ContextRecord,
	type ContextStatus,
	unloadInputSchema,
} from "../schema";
import { deriveBranchStatuses, readContextGcSessionState } from "../session-state";
import type { ContextGcStore } from "../storage";

type AppendDelta = (customType: string, data: ContextGcDelta) => void;

export interface ContextUnloadInput {
	ids: string[];
	summary: string;
	reason: string;
}

export interface ContextUnloadResult {
	unloaded: string[];
	skipped: Array<{ id: string; reason: string }>;
}

export function buildContextGcDelta(
	record: ContextRecord,
	op: ContextGcDelta["op"],
	reason?: string,
	summary?: string,
): ContextGcDelta {
	return {
		op,
		id: record.id,
		sessionId: record.sessionId,
		payloadHash: record.payloadHash,
		status: record.status,
		// The branch delta carries the replacement summary (unload); other ops keep the DB base.
		summary: summary ?? record.summary,
		reason,
		createdAt: new Date().toISOString(),
	};
}

export async function runContextUnload(
	store: ContextGcStore,
	sessionId: string,
	input: ContextUnloadInput,
	branchStatuses?: ReadonlyMap<string, ContextStatus>,
): Promise<ContextUnloadResult> {
	const skipped: Array<{ id: string; reason: string }> = [];
	const unloaded: string[] = [];

	for (const id of input.ids) {
		const record = store.getRecord(id);
		if (!record) {
			skipped.push({ id, reason: "missing" });
			continue;
		}
		if (record.sessionId !== sessionId) {
			skipped.push({ id, reason: "cross-session" });
			continue;
		}
		// Honor the branch-effective pin state; the global DB status alone may belong to a sibling branch.
		const status = branchStatuses?.get(id) ?? record.status;
		if (status === "pinned") {
			skipped.push({ id, reason: "pinned" });
			continue;
		}
		// Flip only the durable base status. The replacement summary stays branch-local in the
		// appended unload delta, so a sibling branch without that delta keeps the DB base summary.
		store.setStatus(id, "unloaded");
		unloaded.push(id);
	}

	return { unloaded, skipped };
}

export function formatContextUnload(result: ContextUnloadResult): string {
	const lines = [`Context GC unloaded ${result.unloaded.length} record(s).`];
	if (result.unloaded.length > 0) lines.push(`Records: ${result.unloaded.join(", ")}`);
	if (result.skipped.length > 0)
		lines.push(`Skipped: ${result.skipped.map(item => `${item.id} (${item.reason})`).join(", ")}`);
	return lines.join("\n");
}

export function createContextUnloadTool(
	store: ContextGcStore,
	appendDelta?: AppendDelta,
): ToolDefinition<typeof unloadInputSchema> {
	return {
		name: "context_unload",
		label: "Unload context",
		description:
			"Unload selected Context GC records from the LLM-facing projection while keeping durable payloads in SQLite.",
		parameters: unloadInputSchema,
		async execute(
			_toolCallId: string,
			params: ContextUnloadInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const session = readContextGcSessionState(ctx);
			const result = await runContextUnload(store, session.sessionId, params, deriveBranchStatuses(session.deltas));
			for (const id of result.unloaded) {
				const record = store.getRecord(id);
				if (record)
					appendDelta?.(
						CONTEXT_GC_CUSTOM_TYPE,
						buildContextGcDelta(record, "unload", params.reason, params.summary),
					);
			}
			return { content: [{ type: "text", text: formatContextUnload(result) }], details: result };
		},
	};
}
