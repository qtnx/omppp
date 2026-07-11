import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	analyzeActiveContext,
	buildContextGcPlaceholder,
	type ActiveContextAnalysis,
} from "./active-context";
import { CONTEXT_GC_PROJECTED_TYPE, type ContextRecord } from "./schema";

type ToolResultSurface = ToolResultMessage<unknown>;

type ProjectedContextMessage = Record<string, unknown> & {
	content: TextContent[];
	customType?: string;
	display?: boolean;
	role?: string;
};

const CONTEXT_GC_INSPECTION_TOOLS = new Set([
	"context_debug",
	"context_global_stats",
	"context_inventory",
	"context_stats",
	"context_tree",
]);

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

export function isContextGcInspectionTool(toolName: string): boolean {
	return CONTEXT_GC_INSPECTION_TOOLS.has(toolName);
}

/**
 * Projects only records that the shared active-context analyzer matched by authoritative identity
 * and canonical stored-payload hash. Unmatched and legacy records stay verbatim in the LLM context.
 */
export function projectUnloadedContext(
	messages: readonly AgentMessage[],
	records: readonly ContextRecord[],
	analysis: ActiveContextAnalysis = analyzeActiveContext(messages, records),
): AgentMessage[] {
	let cleanupSeen = false;
	const staleContextGcInspectionCallIds = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || !isToolResultMessage(message)) continue;
		if (message.toolName === "context_unload" && asRecord(message).isError === false) {
			cleanupSeen = true;
			continue;
		}
		if (cleanupSeen && isContextGcInspectionTool(message.toolName)) {
			staleContextGcInspectionCallIds.add(message.toolCallId);
		}
	}

	const unloadedRecordByMessageIndex = new Map<number, ContextRecord>();
	for (const match of analysis.matches.values()) {
		if (match.record.status === "unloaded") {
			unloadedRecordByMessageIndex.set(match.messageIndex, match.record);
		}
	}
	if (unloadedRecordByMessageIndex.size === 0 && staleContextGcInspectionCallIds.size === 0) {
		return [...messages];
	}

	return messages.map((message, index) => {
		if (isToolResultMessage(message) && staleContextGcInspectionCallIds.has(message.toolCallId)) {
			return renderRemovedInspectionResult(message);
		}
		const record = unloadedRecordByMessageIndex.get(index);
		return record ? renderProjected(message, record) : message;
	});
}

function renderProjected(message: AgentMessage, record: ContextRecord): AgentMessage {
	const content: TextContent[] = [{ type: "text", text: buildContextGcPlaceholder(record) }];
	if (isToolResultMessage(message)) {
		return { ...message, content };
	}
	if (isFileMentionMessage(message) || isExecutionMessage(message)) {
		return {
			role: "custom",
			customType: CONTEXT_GC_PROJECTED_TYPE,
			content,
			display: false,
			timestamp: readTimestamp(message),
		} as unknown as AgentMessage;
	}
	const projected: ProjectedContextMessage = { ...asRecord(message), content };
	delete projected.details;
	return projected as unknown as AgentMessage;
}

function renderRemovedInspectionResult(message: ToolResultSurface): AgentMessage {
	const surface = asRecord(message);
	const projected: Record<string, unknown> = {
		role: "toolResult",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: [{ type: "text", text: "Context GC inspection output removed after context_unload." }],
	};
	if ("isError" in surface) projected.isError = surface.isError;
	if ("timestamp" in surface) projected.timestamp = surface.timestamp;
	return projected as unknown as AgentMessage;
}

function readTimestamp(message: AgentMessage): number {
	const timestamp = asRecord(message).timestamp;
	return typeof timestamp === "number" ? timestamp : Date.now();
}

function isFileMentionMessage(message: AgentMessage): boolean {
	return asRecord(message).role === "fileMention";
}

function isExecutionMessage(message: AgentMessage): boolean {
	const role = asRecord(message).role;
	return role === "bashExecution" || role === "pythonExecution";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultSurface {
	const surface = asRecord(message);
	return (
		surface.role === "toolResult" && typeof surface.toolCallId === "string" && typeof surface.toolName === "string"
	);
}
