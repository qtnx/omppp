/// <reference path="./bun-imports.d.ts" />
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import contextGcSystemPrompt from "./context-gc-system-prompt.md" with { type: "text" };
import { isContextGcInspectionTool, projectUnloadedContext } from "./context-transform";
import { extractMessagePayload, payloadForMessage, payloadFromContent } from "./extract";
import { buildContextGcReminder } from "./reminder";
import {
	CONTEXT_GC_CUSTOM_TYPE,
	CONTEXT_GC_PROJECTED_TYPE,
	type ContextGcDelta,
	type ContextKind,
	type ContextPolicy,
	type ContextRecord,
	type ContextSource,
	type ContextStatus,
} from "./schema";
import { branchRecords, type ContextGcSessionState, readContextGcSessionState } from "./session-state";
import { type ContextGcStore, openContextGcStore } from "./storage";
import { buildFallbackSummary, estimateTokens, normalizeAgentSummary } from "./summary";
import { classifyContextSurface } from "./tool-classification";
import { createContextInventoryTool } from "./tools/context-inventory";
import { createContextPinTool } from "./tools/context-pin";
import { createContextRecallTool } from "./tools/context-recall";
import {
	createContextDebugTool,
	createContextGlobalStatsTool,
	createContextStatsTool,
	createContextTreeTool,
} from "./tools/context-report";
import { createContextUnloadTool } from "./tools/context-unload";

export { estimateContextGcEffectiveTokens } from "./effective-usage";
export { renderContextGcReport } from "./report";
export type { ContextGcReportOptions, ContextGcReportSessionManager } from "./schema";
export { CONTEXT_GC_CUSTOM_TYPE } from "./schema";
export { getContextGcDbPath } from "./storage";

const LARGE_TOOL_RESULT_TOKENS = 2_000;
const LARGE_CUSTOM_MESSAGE_TOKENS = 2_000;
const LARGE_FILE_MENTION_TOKENS = 2_000;
const LARGE_EXECUTION_TOKENS = 2_000;

export interface ContextGcExtensionOptions {
	dbPath?: string;
}
const CONTEXT_GC_DB_PATH_ENV = "OMP_CONTEXT_GC_DB_PATH";

let defaultDbPath: string | undefined;

export function setDefaultContextGcDbPath(dbPath: string | undefined): () => void {
	const previousDbPath = defaultDbPath;
	const previousEnvValue = process.env[CONTEXT_GC_DB_PATH_ENV];
	defaultDbPath = dbPath;
	if (dbPath === undefined) {
		delete process.env[CONTEXT_GC_DB_PATH_ENV];
	} else {
		process.env[CONTEXT_GC_DB_PATH_ENV] = dbPath;
	}
	return () => {
		defaultDbPath = previousDbPath;
		if (previousEnvValue === undefined) {
			delete process.env[CONTEXT_GC_DB_PATH_ENV];
		} else {
			process.env[CONTEXT_GC_DB_PATH_ENV] = previousEnvValue;
		}
	};
}
const REMINDER_THRESHOLD_TOKENS = 8_000;
export const CONTEXT_GC_SYSTEM_PROMPT = contextGcSystemPrompt.trim();

const REMINDER_CONTEXT_USAGE_THRESHOLD_PERCENT = 50;

type ContextMessage = ContextEvent["messages"][number];

interface StoredContextMetadata {
	record: ContextRecord;
	created: boolean;
}

interface PersistPayloadInput {
	text: string;
	stored: string;
	mediaType: string;
	summary: string;
	kind: ContextKind;
	policy: ContextPolicy;
	source: ContextSource;
	sourceUri?: string | null;
	toolType: string;
	recordId?: (sessionId: string, payloadHash: string) => string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function nowIso(): string {
	return new Date().toISOString();
}

function hashText(text: string): string {
	return Bun.SHA256.hash(text, "hex");
}

function statusForPolicy(policy: ContextPolicy): ContextStatus {
	return policy === "pinned" ? "pinned" : "candidate";
}

function statusForDeltaOp(op: ContextGcDelta["op"]): ContextStatus {
	switch (op) {
		case "pin":
			return "pinned";
		case "unload":
			return "unloaded";
		case "candidate":
		case "recall":
		case "unpin":
			return "candidate";
	}
}

function buildDelta(record: ContextRecord, op: ContextGcDelta["op"], reason?: string): ContextGcDelta {
	return {
		op,
		id: record.id,
		sessionId: record.sessionId,
		payloadHash: record.payloadHash,
		status: statusForDeltaOp(op),
		summary: record.summary,
		reason,
		createdAt: nowIso(),
	};
}

function appendDelta(pi: ExtensionAPI, record: ContextRecord): void {
	pi.appendEntry(CONTEXT_GC_CUSTOM_TYPE, buildDelta(record, "candidate"));
}

function needsCandidateDelta(state: ContextGcSessionState, record: ContextRecord, created: boolean): boolean {
	return created || !state.deltas.some(delta => delta.id === record.id);
}

/** Preserve a previously resolved stable entry id when the current pass could not resolve one. */
function preserveEntryId(next: ContextSource, previous: ContextSource | undefined): ContextSource {
	if (next.entryId || !previous?.entryId) return next;
	return { ...next, entryId: previous.entryId };
}

async function persistPayload(
	store: ContextGcStore,
	ctx: ExtensionContext,
	state: ContextGcSessionState,
	input: PersistPayloadInput,
): Promise<StoredContextMetadata> {
	const payload = store.putPayload(input.mediaType, input.stored, input.text);
	const id = input.recordId?.(state.sessionId, payload.hash);
	const existing = id ? store.getRecord(id) : null;
	// Persist the lossless `stored` payload (structured JSON for image-bearing content, plain text
	// otherwise) as the artifact, never the flattened `text` projection. The placeholder surfaces
	// this artifact handle as the recall target, so a `[image:*]`-flattened artifact would silently
	// drop the image bytes. `stored === text` for text-only payloads, so this is a no-op there.
	const artifactId = existing?.artifactId ?? (await ctx.sessionManager.saveArtifact(input.stored, input.toolType));
	const record = store.upsertRecord({
		id,
		sessionId: state.sessionId,
		sessionFile: state.sessionFile ?? null,
		// Re-inventory must not downgrade an already unloaded/pinned record back to candidate;
		// branch deltas remain the source of truth for visible status.
		status: existing ? existing.status : statusForPolicy(input.policy),
		kind: input.kind,
		source: preserveEntryId(input.source, existing?.source),
		payloadHash: payload.hash,
		artifactId,
		sourceUri: input.sourceUri ?? null,
		summary: existing ? existing.summary : input.summary,
		tokenEstimate: estimateTokens(input.text),
	});
	return { record, created: !existing };
}

async function collectLargeToolResult(
	store: ContextGcStore,
	pi: ExtensionAPI,
	event: ToolResultEvent,
	ctx: ExtensionContext,
): Promise<void> {
	if (event.isError) return;
	if (isContextGcInspectionTool(event.toolName)) return;
	const persisted = payloadFromContent(event.content);
	if (persisted.text.length === 0) return;
	if (estimateTokens(persisted.text) < LARGE_TOOL_RESULT_TOKENS) return;
	const classification = classifyContextSurface({ toolName: event.toolName, input: event.input });
	const summary = normalizeAgentSummary(undefined, buildFallbackSummary(persisted.text));
	const state = readContextGcSessionState(ctx);
	const stored = await persistPayload(store, ctx, state, {
		text: persisted.text,
		stored: persisted.stored,
		mediaType: persisted.mediaType,
		summary,
		kind: classification.kind,
		policy: classification.policy,
		source: { toolName: event.toolName, toolCallId: event.toolCallId },
		toolType: `context-gc-${event.toolName}`,
		recordId: (sessionId, payloadHash) => `tool:${sessionId}:${event.toolCallId}:${payloadHash}`,
	});
	if (needsCandidateDelta(state, stored.record, stored.created)) appendDelta(pi, stored.record);
}

function isCustomMessage(message: ContextMessage): boolean {
	const candidate = asRecord(message);
	return candidate.role === "custom" && typeof candidate.customType === "string";
}

function isFileMentionMessage(message: ContextMessage): boolean {
	const candidate = asRecord(message);
	return candidate.role === "fileMention" && Array.isArray(candidate.files);
}

function isBashExecutionMessage(message: ContextMessage): boolean {
	return asRecord(message).role === "bashExecution";
}

function isPythonExecutionMessage(message: ContextMessage): boolean {
	return asRecord(message).role === "pythonExecution";
}

function isExcludedExecution(message: ContextMessage): boolean {
	return asRecord(message).excludeFromContext === true;
}

function fileMentionPaths(message: ContextMessage): string {
	const candidate = message as { files?: Array<{ path?: unknown }> };
	return (candidate.files ?? [])
		.map(file => file.path)
		.filter((path): path is string => typeof path === "string")
		.join(", ");
}

function executionCommand(message: ContextMessage): string {
	const record = asRecord(message);
	const command = record.command ?? record.code;
	return typeof command === "string" ? command : "";
}

function liveMessageEntryId(message: ContextMessage): string | undefined {
	const entryId = asRecord(message).entryId;
	return typeof entryId === "string" ? entryId : undefined;
}

/**
 * Find the stable session entry id for an inventoried message by matching role (+ custom type) and
 * the lossless stored-payload hash. The stored hash — not the lossy text projection — is used so
 * two image-bearing messages that flatten to the same text projection (e.g. identical caption,
 * different image bytes) never alias onto the same entry id.
 */
function resolveBranchEntryId(
	role: string,
	storedHash: string,
	state: ContextGcSessionState,
	consumedEntryIds?: Set<string>,
	customType?: string,
): string | undefined {
	for (const entry of state.messageEntries) {
		if (consumedEntryIds?.has(entry.id)) continue;
		const extracted = extractMessagePayload(entry.message);
		if (extracted.role !== role) continue;
		if (role === "custom" && customType !== undefined && extracted.customType !== customType) continue;
		if (hashText(payloadForMessage(entry.message).stored) !== storedHash) continue;
		consumedEntryIds?.add(entry.id);
		return entry.id;
	}
	return undefined;
}

async function inventoryLargeCustomMessages(
	store: ContextGcStore,
	pi: ExtensionAPI,
	messages: readonly ContextMessage[],
	ctx: ExtensionContext,
	state: ContextGcSessionState,
): Promise<void> {
	const consumedEntryIds = new Set<string>();
	for (const message of messages) {
		if (!isCustomMessage(message)) continue;
		const extracted = extractMessagePayload(message);
		const customType = extracted.customType ?? "custom";
		// Never re-inventory our own reminder or projected placeholder messages.
		if (customType === CONTEXT_GC_CUSTOM_TYPE || customType === CONTEXT_GC_PROJECTED_TYPE) continue;
		const persisted = payloadForMessage(message);
		if (persisted.text.length === 0) continue;
		if (estimateTokens(persisted.text) < LARGE_CUSTOM_MESSAGE_TOKENS) continue;
		const summary = normalizeAgentSummary(undefined, buildFallbackSummary(persisted.text));
		const storedHash = hashText(persisted.stored);
		const liveEntryId = liveMessageEntryId(message);
		const entryId = liveEntryId ?? resolveBranchEntryId("custom", storedHash, state, consumedEntryIds, customType);
		if (liveEntryId) consumedEntryIds.add(liveEntryId);
		const source: ContextSource = entryId ? { customType, entryId } : { customType };
		const stored = await persistPayload(store, ctx, state, {
			text: persisted.text,
			stored: persisted.stored,
			mediaType: persisted.mediaType,
			summary,
			kind: "custom_tool_output",
			policy: "candidate",
			source,
			toolType: "context-gc-custom-message",
			// Per-occurrence id off the stable entry id when resolvable, else hash-only fallback.
			recordId: (sessionId, hash) =>
				entryId ? `custom:${sessionId}:${entryId}:${hash}` : `custom:${sessionId}:${customType}:${hash}`,
		});
		if (needsCandidateDelta(state, stored.record, stored.created)) appendDelta(pi, stored.record);
	}
}

async function inventoryLargeFileMentionMessages(
	store: ContextGcStore,
	pi: ExtensionAPI,
	messages: readonly ContextMessage[],
	ctx: ExtensionContext,
	state: ContextGcSessionState,
): Promise<void> {
	const consumedEntryIds = new Set<string>();
	for (const message of messages) {
		if (!isFileMentionMessage(message)) continue;
		const persisted = payloadForMessage(message);
		if (persisted.text.length === 0) continue;
		if (estimateTokens(persisted.text) < LARGE_FILE_MENTION_TOKENS) continue;
		const paths = fileMentionPaths(message);
		const summary = normalizeAgentSummary(undefined, buildFallbackSummary(persisted.text));
		const storedHash = hashText(persisted.stored);
		const liveEntryId = liveMessageEntryId(message);
		const entryId = liveEntryId ?? resolveBranchEntryId("fileMention", storedHash, state, consumedEntryIds);
		if (liveEntryId) consumedEntryIds.add(liveEntryId);
		const source: ContextSource = entryId ? { path: paths, entryId } : { path: paths };
		const stored = await persistPayload(store, ctx, state, {
			text: persisted.text,
			stored: persisted.stored,
			mediaType: persisted.mediaType,
			summary,
			kind: "file_mention",
			policy: "candidate",
			source,
			sourceUri: paths,
			toolType: "context-gc-file-mention",
			// Per-occurrence id off the stable entry id when resolvable, else hash-only fallback.
			recordId: (sessionId, hash) =>
				entryId ? `file-mention:${sessionId}:${entryId}:${hash}` : `file-mention:${sessionId}:${hash}`,
		});
		if (needsCandidateDelta(state, stored.record, stored.created)) appendDelta(pi, stored.record);
	}
}

async function inventoryLargeExecutionMessages(
	store: ContextGcStore,
	pi: ExtensionAPI,
	messages: readonly ContextMessage[],
	ctx: ExtensionContext,
	state: ContextGcSessionState,
): Promise<void> {
	const consumedEntryIds = new Set<string>();
	for (const message of messages) {
		const bash = isBashExecutionMessage(message);
		const python = isPythonExecutionMessage(message);
		if (!bash && !python) continue;
		// Respect !!/$$ executions that the user excluded from LLM context.
		if (isExcludedExecution(message)) continue;
		const persisted = payloadForMessage(message);
		if (persisted.text.length === 0) continue;
		if (estimateTokens(persisted.text) < LARGE_EXECUTION_TOKENS) continue;
		const role = bash ? "bashExecution" : "pythonExecution";
		const kind: ContextKind = bash ? "bash_execution" : "python_execution";
		const prefix = bash ? "bash" : "python";
		const summary = normalizeAgentSummary(undefined, buildFallbackSummary(persisted.text));
		const storedHash = hashText(persisted.stored);
		const liveEntryId = liveMessageEntryId(message);
		const entryId = liveEntryId ?? resolveBranchEntryId(role, storedHash, state, consumedEntryIds);
		if (liveEntryId) consumedEntryIds.add(liveEntryId);
		const command = executionCommand(message);
		const source: ContextSource = entryId ? { command, entryId } : { command };
		const stored = await persistPayload(store, ctx, state, {
			text: persisted.text,
			stored: persisted.stored,
			mediaType: persisted.mediaType,
			summary,
			kind,
			policy: "candidate",
			source,
			toolType: `context-gc-${prefix}-execution`,
			// Per-occurrence id off the stable entry id when resolvable, else hash-only fallback.
			recordId: (sessionId, hash) =>
				entryId ? `${prefix}:${sessionId}:${entryId}:${hash}` : `${prefix}:${sessionId}:${hash}`,
		});
		if (needsCandidateDelta(state, stored.record, stored.created)) appendDelta(pi, stored.record);
	}
}

export function createContextGcExtension(options: ContextGcExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		registerContextGcExtension(pi, options);
	};
}

export function appendContextGcSystemPrompt(systemPrompt: readonly string[]): string[] | undefined {
	if (systemPrompt.some(item => item.trim() === CONTEXT_GC_SYSTEM_PROMPT)) return undefined;
	return [...systemPrompt, CONTEXT_GC_SYSTEM_PROMPT];
}

function contextGcReminderMessage(reminder: string): {
	customType: string;
	content: string;
	display: false;
	attribution: "agent";
	details: { kind: "reminder" };
} {
	return {
		customType: CONTEXT_GC_CUSTOM_TYPE,
		content: reminder,
		display: false,
		attribution: "agent",
		details: { kind: "reminder" },
	};
}

export default function contextGcExtension(pi: ExtensionAPI): void {
	registerContextGcExtension(pi, { dbPath: defaultDbPath ?? process.env[CONTEXT_GC_DB_PATH_ENV] });
}

function registerContextGcExtension(pi: ExtensionAPI, options: ContextGcExtensionOptions = {}): void {
	pi.setLabel("Context GC");
	let store: ContextGcStore;
	try {
		store = openContextGcStore({ dbPath: options.dbPath });
	} catch (error) {
		logger.warn("Context GC store unavailable; disabling native context GC for this session", {
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}

	pi.registerTool(createContextStatsTool(store));
	pi.registerTool(createContextGlobalStatsTool(store));
	pi.registerTool(createContextTreeTool(store));
	pi.registerTool(createContextDebugTool(store));
	pi.registerTool(createContextInventoryTool(store));
	pi.registerTool(createContextUnloadTool(store, pi.appendEntry.bind(pi)));
	pi.registerTool(createContextRecallTool(store, pi.appendEntry.bind(pi)));
	pi.registerTool(createContextPinTool(store, pi.appendEntry.bind(pi)));

	pi.on("tool_result", async (event, ctx) => {
		await collectLargeToolResult(store, pi, event, ctx);
	});

	pi.on("context", async (event, ctx) => {
		const state = readContextGcSessionState(ctx);
		await inventoryLargeCustomMessages(store, pi, event.messages, ctx, state);
		await inventoryLargeFileMentionMessages(store, pi, event.messages, ctx, state);
		await inventoryLargeExecutionMessages(store, pi, event.messages, ctx, state);
		const records = branchRecords(store, readContextGcSessionState(ctx));
		return { messages: projectUnloadedContext(event.messages, records) };
	});

	pi.on("before_agent_start", (event, ctx) => {
		const systemPrompt = appendContextGcSystemPrompt(event.systemPrompt);
		const reminder = buildContextGcReminder(branchRecords(store, readContextGcSessionState(ctx)), {
			thresholdTokens: REMINDER_THRESHOLD_TOKENS,
			contextUsage: ctx.getContextUsage(),
			minContextUsagePercent: REMINDER_CONTEXT_USAGE_THRESHOLD_PERCENT,
		});
		if (!reminder && !systemPrompt) return undefined;
		return {
			...(reminder ? { message: contextGcReminderMessage(reminder) } : {}),
			...(systemPrompt ? { systemPrompt } : {}),
		};
	});

	pi.on("session_shutdown", () => {
		store.close();
	});
}
