import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { CONTEXT_GC_CUSTOM_TYPE, type ContextGcDelta, pinInputSchema } from "../schema";
import { readContextGcSessionState } from "../session-state";
import type { ContextGcStore } from "../storage";
import { buildContextGcDelta } from "./context-unload";

type AppendDelta = (customType: string, data: ContextGcDelta) => void;

export interface ContextPinInput {
	ids: string[];
	pinned?: boolean;
	reason: string;
}

export interface ContextPinResult {
	pinned: string[];
	unpinned: string[];
	skipped: Array<{ id: string; reason: string }>;
}

export async function runContextPin(
	store: ContextGcStore,
	sessionId: string,
	input: ContextPinInput,
): Promise<ContextPinResult> {
	const pin = input.pinned ?? true;
	const pinned: string[] = [];
	const unpinned: string[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];

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
		store.setStatus(id, pin ? "pinned" : "candidate");
		if (pin) pinned.push(id);
		else unpinned.push(id);
	}

	return { pinned, unpinned, skipped };
}

export function formatContextPin(result: ContextPinResult): string {
	const lines = [`Context GC updated ${result.pinned.length + result.unpinned.length} record(s).`];
	if (result.pinned.length > 0) lines.push(`Pinned: ${result.pinned.join(", ")}`);
	if (result.unpinned.length > 0) lines.push(`Unpinned: ${result.unpinned.join(", ")}`);
	if (result.skipped.length > 0)
		lines.push(`Skipped: ${result.skipped.map(item => `${item.id} (${item.reason})`).join(", ")}`);
	return lines.join("\n");
}

export function createContextPinTool(
	store: ContextGcStore,
	appendDelta?: AppendDelta,
): ToolDefinition<typeof pinInputSchema> {
	return {
		name: "context_pin",
		label: "Pin context",
		description: "Pin or unpin Context GC records. Pinned records are not automatically unloaded.",
		parameters: pinInputSchema,
		async execute(
			_toolCallId: string,
			params: ContextPinInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const session = readContextGcSessionState(ctx);
			const result = await runContextPin(store, session.sessionId, params);
			for (const id of [...result.pinned, ...result.unpinned]) {
				const record = store.getRecord(id);
				if (record)
					appendDelta?.(
						CONTEXT_GC_CUSTOM_TYPE,
						buildContextGcDelta(record, result.pinned.includes(id) ? "pin" : "unpin", params.reason),
					);
			}
			return { content: [{ type: "text", text: formatContextPin(result) }], details: result };
		},
	};
}
