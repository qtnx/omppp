import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { payloadForMessage } from "./extract";
import { CONTEXT_GC_PROJECTED_TYPE, type ContextRecord } from "./schema";

type ToolResultSurface = ToolResultMessage<unknown>;

type ProjectedContextMessage = Record<string, unknown> & {
	content: TextContent[];
	customType?: string;
	display?: boolean;
	role?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

interface ContextRecordSource {
	readonly entryId?: string;
	readonly artifactId?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly messageRole?: string;
	readonly customType?: string;
	readonly path?: string;
}

interface UnloadedContextRecord {
	readonly id: string;
	readonly kind: string;
	readonly summary: string;
	readonly payloadHash: string;
	readonly status: string;
	readonly source: ContextRecordSource;
	readonly artifactId?: string | null;
}

export function projectUnloadedContext(
	messages: readonly AgentMessage[],
	records: readonly ContextRecord[],
): AgentMessage[] {
	const unloadedRecords = records.filter(isUnloadedRecord);
	if (unloadedRecords.length === 0) {
		return [...messages];
	}
	// An unloaded record projects at most one live message per pass. Tracking consumed record ids
	// stops a single fallback (hash-only) record from collapsing several duplicate-content live
	// messages into placeholders, and lets distinct same-content records map to distinct messages.
	const consumed = new Set<string>();
	return messages.map(message => {
		if (!isProjectableMessage(message)) {
			return message;
		}
		const record = unloadedRecords.find(
			candidate => !consumed.has(candidate.id) && matchesMessage(message, candidate),
		);
		if (!record) {
			return message;
		}
		consumed.add(record.id);
		return renderProjected(message, record);
	});
}

function renderProjected(message: AgentMessage, record: UnloadedContextRecord): AgentMessage {
	const content: TextContent[] = [{ type: "text", text: buildPlaceholder(record) }];
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

function isProjectableMessage(message: AgentMessage): boolean {
	if (isExecutionMessage(message) && isExcludedFromContext(message)) {
		return false;
	}
	return (
		isToolResultMessage(message) ||
		isCustomMessage(message) ||
		isFileMentionMessage(message) ||
		isExecutionMessage(message)
	);
}

function matchesMessage(message: AgentMessage, record: UnloadedContextRecord): boolean {
	if (isToolResultMessage(message)) {
		return matchesToolResultMessage(message, record);
	}
	if (isCustomMessage(message) || isFileMentionMessage(message) || isExecutionMessage(message)) {
		return matchesNonToolMessage(message, record);
	}
	return false;
}

/**
 * Match a custom/file-mention/execution message to an unloaded record. Kind, custom type, and the
 * lossless stored-payload hash are always validated.
 *
 * Entry-id linkage is authoritative, not advisory: a record bound to a stable session entry id
 * projects ONLY onto the live message carrying that exact id. There is deliberately no payload-hash
 * fallback for an entry-bound record — when several occurrences share a payload, a hash-only match
 * would collapse onto the wrong (e.g. first positional) occurrence. If the entry-bound record's
 * live message has dropped its id, it simply does not match here. Hash matching is reserved for
 * records that never resolved an entry id at inventory time.
 */
function matchesNonToolMessage(message: AgentMessage, record: UnloadedContextRecord): boolean {
	if (isCustomMessage(message) && !hasMatchingCustomType(message, record)) {
		return false;
	}
	if (!hasMatchingKind(message, record)) {
		return false;
	}
	if (record.source.entryId) {
		const surface = asRecord(message);
		if (!messageCarriesEntryId(surface) || !hasMatchingEntryId(surface, record.source.entryId)) {
			return false;
		}
	}
	return hasMatchingPayloadHash(message, record);
}

function hasMatchingCustomType(message: AgentMessage, record: UnloadedContextRecord): boolean {
	if (record.kind !== "custom_tool_output") {
		return true;
	}
	const recordType = record.source.customType;
	if (typeof recordType !== "string") {
		return false;
	}
	return asRecord(message).customType === recordType;
}

function hasMatchingKind(message: AgentMessage, record: UnloadedContextRecord): boolean {
	const role = asRecord(message).role;
	return (
		(record.kind === "custom_tool_output" && role === "custom") ||
		(record.kind === "file_mention" && role === "fileMention") ||
		(record.kind === "bash_execution" && role === "bashExecution") ||
		(record.kind === "python_execution" && role === "pythonExecution")
	);
}

function hasMatchingPayloadHash(message: AgentMessage, record: UnloadedContextRecord): boolean {
	const persisted = payloadForMessage(message);
	return Bun.SHA256.hash(persisted.stored, "hex") === record.payloadHash;
}

function readTimestamp(message: AgentMessage): number {
	const timestamp = asRecord(message).timestamp;
	return typeof timestamp === "number" ? timestamp : Date.now();
}

function matchesToolResultMessage(message: ToolResultSurface, record: UnloadedContextRecord): boolean {
	if (record.source.toolCallId) {
		return record.source.toolCallId === message.toolCallId;
	}
	return record.source.toolName === message.toolName;
}

function isFileMentionMessage(message: AgentMessage): boolean {
	const surface = asRecord(message);
	return surface.role === "fileMention";
}

function isExecutionMessage(message: AgentMessage): boolean {
	const role = asRecord(message).role;
	return role === "bashExecution" || role === "pythonExecution";
}

function isExcludedFromContext(message: AgentMessage): boolean {
	return asRecord(message).excludeFromContext === true;
}

function hasMatchingEntryId(surface: Record<string, unknown>, entryId: string): boolean {
	return surface.id === entryId || surface.messageId === entryId || surface.entryId === entryId;
}

/** Whether a live message still exposes any stable entry-id field for disambiguation. */
function messageCarriesEntryId(surface: Record<string, unknown>): boolean {
	return (
		typeof surface.id === "string" || typeof surface.messageId === "string" || typeof surface.entryId === "string"
	);
}

function isToolResultMessage(message: AgentMessage): message is ToolResultSurface {
	const surface = asRecord(message);
	return (
		surface.role === "toolResult" && typeof surface.toolCallId === "string" && typeof surface.toolName === "string"
	);
}

function isCustomMessage(message: AgentMessage): boolean {
	const surface = asRecord(message);
	return surface.role === "custom";
}

function isUnloadedRecord(record: ContextRecord): record is ContextRecord & UnloadedContextRecord {
	const surface = asRecord(record);
	return (
		typeof surface.id === "string" &&
		typeof surface.kind === "string" &&
		typeof surface.summary === "string" &&
		typeof surface.payloadHash === "string" &&
		surface.status === "unloaded" &&
		isSource(surface.source)
	);
}

function isSource(source: unknown): source is ContextRecordSource {
	if (!source || typeof source !== "object") {
		return false;
	}
	const surface = source as Record<string, unknown>;
	return (
		optionalString(surface.entryId) &&
		optionalString(surface.artifactId) &&
		optionalString(surface.toolCallId) &&
		optionalString(surface.toolName) &&
		optionalString(surface.messageRole) &&
		optionalString(surface.customType) &&
		optionalString(surface.path)
	);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function buildPlaceholder(record: UnloadedContextRecord): string {
	const lines = [`Context unloaded: ${record.id}`, `Kind: ${record.kind}`, `Summary: ${record.summary}`];
	if (record.artifactId) {
		lines.push(`Artifact: ${record.artifactId}`);
	}
	lines.push(`Recall: context_recall {"id":"${escapeJsonString(record.id)}"}`);
	return lines.join("\n");
}

function escapeJsonString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
