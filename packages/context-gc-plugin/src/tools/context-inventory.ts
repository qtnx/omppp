import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { type ContextRecord, type ContextStatus, inventoryInputSchema } from "../schema";
import { branchRecords, readContextGcSessionState } from "../session-state";
import type { ContextGcStore } from "../storage";

export interface ContextInventoryInput {
	status?: ContextStatus;
	includePinned?: boolean;
	limit?: number;
}

export interface ContextInventoryResult {
	records: ContextRecord[];
	totalTokens: number;
}

function renderRecord(record: ContextRecord): string {
	const tool = record.source.toolName ? ` from ${record.source.toolName}` : "";
	return `- ${record.id} [${record.status}/${record.kind}, ${record.tokenEstimate} tok${tool}] — ${record.summary}`;
}

export async function runContextInventory(
	store: ContextGcStore,
	sessionId: string,
	input: ContextInventoryInput = {},
	branchScoped?: readonly ContextRecord[],
): Promise<ContextInventoryResult> {
	// When branch-scoped records are supplied, filter in memory off the branch-effective status
	// rather than trusting the global DB status column.
	const records = branchScoped
		? filterBranchRecords(branchScoped, input)
		: store.listRecords({
				sessionId,
				status: input.status,
				includePinned: input.includePinned ?? true,
				limit: input.limit ?? 100,
			});
	const totalTokens = records.reduce((sum, record) => sum + record.tokenEstimate, 0);
	return { records, totalTokens };
}

function filterBranchRecords(records: readonly ContextRecord[], input: ContextInventoryInput): ContextRecord[] {
	const includePinned = input.includePinned ?? true;
	const matched = records.filter(record => statusMatches(record.status, input.status, includePinned));
	const sorted = [...matched].sort((a, b) => {
		if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	return sorted.slice(0, input.limit ?? 100);
}

function statusMatches(status: ContextStatus, wanted: ContextStatus | undefined, includePinned: boolean): boolean {
	if (wanted) return status === wanted;
	return includePinned || status !== "pinned";
}

export function formatContextInventory(result: ContextInventoryResult): string {
	if (result.records.length === 0) return "No Context GC records found.";
	return [
		`Context GC inventory: ${result.records.length} record(s), ${result.totalTokens} estimated tokens.`,
		...result.records.map(renderRecord),
	].join("\n");
}

export function createContextInventoryTool(store: ContextGcStore): ToolDefinition<typeof inventoryInputSchema> {
	return {
		name: "context_inventory",
		label: "Context inventory",
		description: "List Context GC records available for unload, recall, or pinning in the current session.",
		parameters: inventoryInputSchema,
		async execute(
			_toolCallId: string,
			params: ContextInventoryInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const session = readContextGcSessionState(ctx);
			const result = await runContextInventory(store, session.sessionId, params, branchRecords(store, session));
			return { content: [{ type: "text", text: formatContextInventory(result) }], details: result };
		},
	};
}
