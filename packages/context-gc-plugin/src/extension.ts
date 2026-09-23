/// <reference path="./bun-imports.d.ts" />
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { contentToText } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type ActiveContextAnalysis,
	type ActiveSnapshot,
	analyzeActiveContext,
	createActiveSnapshot,
	isActiveSnapshotValid,
} from "./active-context";
import contextGcSystemPrompt from "./context-gc-system-prompt.md" with { type: "text" };
import { isContextGcInspectionTool, projectUnloadedContext } from "./context-transform";
import {
	AUTO_SHAKE_KINDS,
	type DeferredUnloadSessionState,
	type TrimCandidate,
	decideDeferredUnloads,
	hotTrimPaysOff,
	hotTrimWindow,
	isCacheCold,
	recordRequestMessageCount,
	selectAutoShakeRecords,
	selectTrimByJudgment,
	trimPaysOff,
} from "./deferred-unload";
import { extractMessagePayload, payloadForMessage, payloadFromContent } from "./extract";
import { buildContextGcReminder, buildContextUsageReminder } from "./reminder";
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
import {
	branchRecords,
	type ContextGcSessionState,
	deriveBranchStatuses,
	readContextGcSessionState,
} from "./session-state";
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
import { buildContextGcDelta, createContextUnloadTool, runContextUnload } from "./tools/context-unload";

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
	/**
	 * Unload stale tool output automatically when the prompt cache is already cold, so the
	 * unavoidable cache rewrite starts from a smaller prompt. Default on; `OMP_CONTEXT_GC_AUTO_SHAKE=0` disables.
	 */
	autoShakeOnColdCache?: boolean;
	/**
	 * Shed consumed tool output from the slice the previous request introduced even while the
	 * prompt cache is warm: dropping it re-bills only the rest of that slice, never the older
	 * prefix the provider already cached. Default on; `OMP_CONTEXT_GC_HOT_TRIM=0` disables.
	 */
	hotTrimOnWarmCache?: boolean;
	/** Clock for prompt-cache idle detection; tests inject a controllable one. */
	now?: () => number;
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
/** From this usage the model is told its context percentage every turn so it can apply the
 * phase-boundary compaction rule (system prompt: compact_now ⇔ boundary ∧ usage ≥ 40%). */
const COMPACT_HINT_CONTEXT_USAGE_PERCENT = 40;
/** The hint is a persisted hidden message; emit it once per band (40/60/80) so a long turn stream
 * neither bloats history nor nags. The band resets once usage falls back below it (compaction ran). */
const COMPACT_HINT_BAND_PERCENT = 20;

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

/** `provider/id` key for per-model cache warmth. */
function modelKeyOf(model: { provider: string; id: string } | undefined): string {
	return model ? `${model.provider}/${model.id}` : "unknown";
}

/** Cache read/write tokens of an assistant message, or zeros when it carries no usage. */
function readCacheUsage(message: unknown): { cacheRead: number; cacheWrite: number } {
	if (!message || typeof message !== "object" || !("usage" in message)) return { cacheRead: 0, cacheWrite: 0 };
	const usage = message.usage;
	if (!usage || typeof usage !== "object") return { cacheRead: 0, cacheWrite: 0 };
	const read = "cacheRead" in usage && typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
	const write = "cacheWrite" in usage && typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
	return { cacheRead: read, cacheWrite: write };
}

/** Records at the very tail are the live exchange; a trim never touches them. */
const TRIM_KEEP_TAIL_MESSAGES = 2;
/** Candidates per judgment request: shedding value concentrates in the largest records. */
export const TRIM_MAX_CANDIDATES = 30;
/** Below this keep-probability the upcoming work does not need the record's full content. */
export const TRIM_KEEP_THRESHOLD = 0.35;
/** The instruction the per-candidate questions carry; `{{id}}` is replaced per record. */
const TRIM_SUMMARY_CHARS = 300;

/**
 * Records to shed before a prompt rewrite: jev judges each candidate against the
 * upcoming work, and the economic gate prices the shed tokens against the prefix
 * of the model that just answered. Falls back to the kind-based heuristic when
 * signals are unavailable, so a dead classifier keeps today's behavior.
 */
async function selectTrimRecords(input: {
	analysis: ActiveContextAnalysis;
	messages: readonly AgentMessage[];
	ctx: ExtensionContext;
	state: DeferredUnloadSessionState;
	modelKey: string;
}): Promise<ContextRecord[]> {
	const { analysis, messages, ctx, state, modelKey } = input;
	const candidates = buildTrimCandidates(analysis, messages);
	if (candidates.length === 0) return [];
	const target = ctx.model;
	const contextTokens = ctx.getContextUsage()?.tokens ?? null;
	const judgment = ctx.classifyContextTrim
		? await ctx.classifyContextTrim({
				upcomingRequest: latestRequestText(messages),
				sessionDigest: sessionDigest(ctx, messages),
				contextTokens,
				candidates: candidates.map(candidate => ({
					id: candidate.id,
					kind: candidate.kind,
					ageTurns: candidate.ageTurns,
					tokens: candidate.tokens,
					summary: candidate.summary.slice(0, TRIM_SUMMARY_CHARS),
				})),
			})
		: undefined;
	if (!judgment) {
		return selectAutoShakeRecords(
			candidates.map(candidate => ({
				record: candidate.record,
				messageIndex: candidate.messageIndex,
				netTokens: candidate.tokens,
			})),
			messages.length,
		);
	}
	const shed = selectTrimByJudgment(candidates, judgment, TRIM_KEEP_THRESHOLD);
	if (shed.length === 0) return [];
	const shedTokens = shed.reduce((sum, candidate) => sum + candidate.tokens, 0);
	const writePrice = target?.cost.cacheWrite ?? 0;
	const pays = trimPaysOff(state, Date.now(), modelKey, shedTokens, writePrice);
	logger.debug("Context GC: trim judgment", {
		model: modelKey,
		action: judgment.action,
		actionConfidence: judgment.actionConfidence,
		candidates: candidates.length,
		shed: shed.length,
		shedTokens,
		pays,
	});
	// `compact` is the session's own pre-prompt path: a context hook cannot
	// rewrite the prompt it is building, so the recommendation is logged and the
	// recoverable shed (recall-able) runs instead.
	if (!pays) return [];
	return shed.map(candidate => candidate.record);
}

interface TrimCandidateRecord extends TrimCandidate {
	record: ContextRecord;
}

function buildTrimCandidates(
	analysis: ActiveContextAnalysis,
	messages: readonly AgentMessage[],
): TrimCandidateRecord[] {
	const cutoff = messages.length - TRIM_KEEP_TAIL_MESSAGES;
	const turnsAfter = (index: number): number => {
		let turns = 0;
		for (let i = index + 1; i < messages.length; i++) {
			if (messages[i]?.role === "user") turns += 1;
		}
		return turns;
	};
	return [...analysis.matches.values()]
		.filter(match => match.record.status === "candidate" && match.messageIndex < cutoff)
		.map(match => ({
			record: match.record,
			id: match.record.id,
			kind: match.record.kind,
			ageTurns: turnsAfter(match.messageIndex),
			tokens: match.estimate.netTokens,
			summary: match.record.summary,
			messageIndex: match.messageIndex,
		}))
		.filter(candidate => candidate.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, TRIM_MAX_CANDIDATES);
}

/**
 * Records to shed on a WARM cache: the slice the previous request introduced.
 *
 * Shedding there re-bills only the rest of that slice (the tail produced since
 * is written to cache either way), so this path may run while the provider
 * still holds a live prefix — unlike the cold-cache trim, which rewrites a
 * prefix the provider already paid to cache. Position alone cannot
 * tell whether the model is done with a result, so only the jev judgment picks;
 * without a classifier the hot path stays off (the kind-based heuristic keeps
 * the tail by design).
 */
async function selectHotTrimRecords(input: {
	analysis: ActiveContextAnalysis;
	messages: readonly AgentMessage[];
	ctx: ExtensionContext;
	window: { start: number; end: number };
	onSkip?: (
		why: "no-classifier" | "no-candidates" | "no-judgment" | "judgment-keeps",
		detail?: Record<string, number>,
	) => void;
}): Promise<ContextRecord[]> {
	const { analysis, messages, ctx, window, onSkip } = input;
	if (!ctx.classifyContextTrim) {
		onSkip?.("no-classifier");
		return [];
	}
	const candidates = [...analysis.matches.values()]
		.filter(
			match =>
				match.record.status === "candidate" &&
				AUTO_SHAKE_KINDS[match.record.kind] === true &&
				match.messageIndex >= window.start &&
				match.messageIndex < window.end &&
				match.estimate.netTokens > 0,
		)
		.map(match => ({
			record: match.record,
			id: match.record.id,
			kind: match.record.kind,
			ageTurns: turnsAfterIndex(messages, match.messageIndex),
			tokens: match.estimate.netTokens,
			summary: match.record.summary,
			messageIndex: match.messageIndex,
		}))
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, TRIM_MAX_CANDIDATES);
	if (candidates.length === 0) {
		onSkip?.("no-candidates");
		return [];
	}
	const contextTokens = ctx.getContextUsage()?.tokens ?? null;
	const judgment = await ctx.classifyContextTrim({
		upcomingRequest: latestRequestText(messages),
		sessionDigest: sessionDigest(ctx, messages),
		contextTokens,
		candidates: candidates.map(candidate => ({
			id: candidate.id,
			kind: candidate.kind,
			ageTurns: candidate.ageTurns,
			tokens: candidate.tokens,
			summary: candidate.summary.slice(0, TRIM_SUMMARY_CHARS),
		})),
	});
	if (!judgment) {
		onSkip?.("no-judgment", { candidates: candidates.length });
		return [];
	}
	const shed = selectTrimByJudgment(candidates, judgment, TRIM_KEEP_THRESHOLD);
	if (shed.length === 0) {
		onSkip?.("judgment-keeps", { candidates: candidates.length });
		return [];
	}
	const shedTokens = shed.reduce((sum, candidate) => sum + candidate.tokens, 0);
	const shedIndexes = new Set(shed.map(candidate => candidate.messageIndex));
	const suffixTokens = estimateSuffixTokens(analysis, messages, Math.min(...shedIndexes), window.end, shedIndexes);
	const cacheReadPrice = ctx.model?.cost.cacheRead ?? 0;
	const rewritePrice = Math.max(ctx.model?.cost.cacheWrite ?? 0, ctx.model?.cost.input ?? 0) - cacheReadPrice;
	const pays = hotTrimPaysOff({ shedTokens, suffixTokens, cacheReadPrice, rewritePrice });
	logger.debug("Context GC: hot trim judgment", {
		candidates: candidates.length,
		shed: shed.length,
		shedTokens,
		suffixTokens,
		pays,
	});
	return pays ? shed.map(candidate => candidate.record) : [];
}

/** Conversational turns between `index` and the tail. */
function turnsAfterIndex(messages: readonly AgentMessage[], index: number): number {
	let turns = 0;
	for (let i = index + 1; i < messages.length; i++) {
		if (messages[i]?.role === "user") turns += 1;
	}
	return turns;
}

/**
 * Tokens the provider would pay to rewrite because of the shed records: the
 * non-shed messages from the cut to the END OF THE PREVIOUS REQUEST.
 *
 * Everything past `endIndex` (the assistant step and tool results produced
 * since) is written to cache on this request whether or not anything was shed,
 * so pricing it here would refuse every real trim — a fresh tool result is
 * usually as large as the one being dropped. Known records keep their measured
 * size, shed ones collapse to a placeholder (counted as free), and plain
 * messages fall back to the shared text estimate.
 */
function estimateSuffixTokens(
	analysis: ActiveContextAnalysis,
	messages: readonly AgentMessage[],
	startIndex: number,
	endIndex: number,
	shedIndexes: ReadonlySet<number>,
): number {
	const known = new Map<number, number>();
	for (const match of analysis.matches.values()) known.set(match.messageIndex, match.estimate.potentialTokens);
	let total = 0;
	for (let index = startIndex; index < Math.min(endIndex, messages.length); index++) {
		if (shedIndexes.has(index)) continue;
		const measured = known.get(index);
		if (measured !== undefined) {
			total += measured;
			continue;
		}
		const message = messages[index];
		if (message) total += estimateTokens(extractMessagePayload(message).text);
	}
	return total;
}

/** The latest duo handoff brief, else the last user request — what work comes next. */
function latestRequestText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "toolResult" || message.toolName !== "duo_handoff") continue;
		const text = contentToText(message.content).trim();
		if (text) return text;
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		const text = contentToText(message.content).trim();
		if (text) return text;
	}
	return "";
}

function sessionDigest(ctx: ExtensionContext, messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	const title = ctx.sessionManager.getSessionName();
	if (title) parts.push(`Title: ${title}`);
	const requests: string[] = [];
	for (let i = messages.length - 1; i >= 0 && requests.length < 3; i--) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		const text = contentToText(message.content).slice(0, 500).trim();
		if (text) requests.push(text);
	}
	if (requests.length > 0)
		parts.push(
			`Recent requests:\n${requests
				.reverse()
				.map(text => `- ${text}`)
				.join("\n")}`,
		);
	return parts.join("\n\n");
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

function sourcesEquivalent(left: ContextSource, right: ContextSource): boolean {
	return (
		left.entryId === right.entryId &&
		left.customType === right.customType &&
		left.toolCallId === right.toolCallId &&
		left.toolName === right.toolName &&
		left.path === right.path &&
		left.uri === right.uri &&
		left.command === right.command &&
		left.skillName === right.skillName
	);
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
	const source = preserveEntryId(input.source, existing?.source);
	const tokenEstimate = estimateTokens(input.text);
	if (
		existing &&
		existing.payloadHash === payload.hash &&
		existing.kind === input.kind &&
		existing.sessionId === state.sessionId &&
		(existing.sessionFile ?? null) === (state.sessionFile ?? null) &&
		(existing.sourceUri ?? null) === (input.sourceUri ?? null) &&
		existing.tokenEstimate === tokenEstimate &&
		sourcesEquivalent(existing.source, source)
	) {
		return { record: existing, created: false };
	}
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
		source,
		payloadHash: payload.hash,
		artifactId,
		sourceUri: input.sourceUri ?? null,
		summary: existing ? existing.summary : input.summary,
		tokenEstimate,
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

interface BranchEntryCandidate {
	readonly id: string;
	readonly customType: string | undefined;
}

/**
 * Find the stable session entry id for an inventoried message by matching role (+ custom type) and
 * the lossless stored-payload hash. The stored hash — not the lossy text projection — is used so
 * two image-bearing messages that flatten to the same text projection (e.g. identical caption,
 * different image bytes) never alias onto the same entry id.
 */
type BranchEntryResolver = (
	role: string,
	storedHash: string,
	consumedEntryIds?: Set<string>,
	customType?: string,
) => string | undefined;

/**
 * Build a resolver that indexes the branch entries by role + stored-payload hash once, lazily on
 * the first lookup, so an inventory pass no longer re-extracts and re-hashes every entry per
 * message. Entry order inside a bucket is the branch order, so the resolved entry is unchanged.
 */
function createBranchEntryResolver(state: ContextGcSessionState): BranchEntryResolver {
	let index: Map<string, BranchEntryCandidate[]> | undefined;
	return (role, storedHash, consumedEntryIds, customType) => {
		if (!index) {
			index = new Map();
			for (const entry of state.messageEntries) {
				const extracted = extractMessagePayload(entry.message);
				const key = `${extracted.role}\u0000${hashText(payloadForMessage(entry.message).stored)}`;
				const candidate: BranchEntryCandidate = { id: entry.id, customType: extracted.customType };
				const bucket = index.get(key);
				if (bucket) bucket.push(candidate);
				else index.set(key, [candidate]);
			}
		}
		for (const candidate of index.get(`${role}\u0000${storedHash}`) ?? []) {
			if (consumedEntryIds?.has(candidate.id)) continue;
			if (role === "custom" && customType !== undefined && candidate.customType !== customType) continue;
			consumedEntryIds?.add(candidate.id);
			return candidate.id;
		}
		return undefined;
	};
}

async function inventoryLargeCustomMessages(
	store: ContextGcStore,
	pi: ExtensionAPI,
	messages: readonly ContextMessage[],
	ctx: ExtensionContext,
	state: ContextGcSessionState,
	resolveEntryId: BranchEntryResolver,
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
		const entryId = liveEntryId ?? resolveEntryId("custom", storedHash, consumedEntryIds, customType);
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
	resolveEntryId: BranchEntryResolver,
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
		const entryId = liveEntryId ?? resolveEntryId("fileMention", storedHash, consumedEntryIds);
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
	resolveEntryId: BranchEntryResolver,
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
		const entryId = liveEntryId ?? resolveEntryId(role, storedHash, consumedEntryIds);
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

	const activeSnapshots = new Map<string, ActiveSnapshot>();
	const compactHintBands = new Map<string, number>();
	const deferredUnloads = new Map<string, DeferredUnloadSessionState>();
	const now = options.now ?? Date.now;
	const autoShake = options.autoShakeOnColdCache ?? process.env.OMP_CONTEXT_GC_AUTO_SHAKE !== "0";
	const hotTrim = options.hotTrimOnWarmCache ?? process.env.OMP_CONTEXT_GC_HOT_TRIM !== "0";
	const deferredUnloadState = (sessionId: string): DeferredUnloadSessionState => {
		let state = deferredUnloads.get(sessionId);
		if (!state) {
			state = { applied: new Set(), lastResponseByModel: new Map(), requestMessageCounts: [] };
			deferredUnloads.set(sessionId, state);
		}
		return state;
	};

	function usageHintDue(sessionId: string, percent: number | null | undefined): boolean {
		if (percent === null || percent === undefined || percent < COMPACT_HINT_CONTEXT_USAGE_PERCENT) {
			compactHintBands.delete(sessionId);
			return false;
		}
		const band = Math.floor((percent - COMPACT_HINT_CONTEXT_USAGE_PERCENT) / COMPACT_HINT_BAND_PERCENT);
		const last = compactHintBands.get(sessionId);
		if (last !== undefined && band <= last) return false;
		compactHintBands.set(sessionId, band);
		return true;
	}
	const getActiveSnapshot = (ctx: ExtensionContext): ActiveSnapshot | undefined => {
		const state = readContextGcSessionState(ctx);
		const snapshot = activeSnapshots.get(state.sessionId);
		if (isActiveSnapshotValid(snapshot, state)) return snapshot;
		activeSnapshots.delete(state.sessionId);
		return undefined;
	};

	pi.registerTool(createContextStatsTool(store, getActiveSnapshot));
	pi.registerTool(createContextGlobalStatsTool(store));
	pi.registerTool(createContextTreeTool(store, getActiveSnapshot));
	pi.registerTool(createContextDebugTool(store, getActiveSnapshot));
	pi.registerTool(createContextInventoryTool(store, getActiveSnapshot));
	pi.registerTool(createContextUnloadTool(store, pi.appendEntry.bind(pi)));
	pi.registerTool(createContextRecallTool(store, pi.appendEntry.bind(pi)));
	pi.registerTool(createContextPinTool(store, pi.appendEntry.bind(pi)));

	pi.on("tool_result", async (event, ctx) => {
		await collectLargeToolResult(store, pi, event, ctx);
	});

	pi.on("context", async (event, ctx) => {
		const state = readContextGcSessionState(ctx);
		const resolveEntryId = createBranchEntryResolver(state);
		await inventoryLargeCustomMessages(store, pi, event.messages, ctx, state, resolveEntryId);
		await inventoryLargeFileMentionMessages(store, pi, event.messages, ctx, state, resolveEntryId);
		await inventoryLargeExecutionMessages(store, pi, event.messages, ctx, state, resolveEntryId);
		let currentState = readContextGcSessionState(ctx);
		let records = branchRecords(store, currentState);
		let analysis = analyzeActiveContext(event.messages, records);
		const deferred = deferredUnloadState(currentState.sessionId);
		const modelKey = modelKeyOf(ctx.model);
		// Cold-cache trim: the target model's prompt cache holds nothing, so the
		// provider rewrites the whole prompt on this request regardless and anything
		// shed now is free. A duo phase switch lands here — the other model keeps its
		// own live prefix, which the economic gate below prices before shedding.
		if (autoShake && isCacheCold(deferred, now(), modelKey)) {
			const shed = await selectTrimRecords({
				analysis,
				messages: event.messages,
				ctx,
				state: deferred,
				modelKey,
			});
			if (shed.length > 0) {
				const reason = "auto-trim: prompt cache cold";
				const result = await runContextUnload(
					store,
					currentState.sessionId,
					{ ids: shed.map(record => record.id), summary: "", reason },
					deriveBranchStatuses(currentState.deltas.filter(delta => delta.sessionId === currentState.sessionId)),
				);
				for (const record of shed) {
					if (!result.unloaded.includes(record.id)) continue;
					pi.appendEntry(CONTEXT_GC_CUSTOM_TYPE, buildContextGcDelta(record, "unload", reason, record.summary));
				}
				logger.debug("Context GC: auto-trim on cold cache", {
					model: modelKey,
					unloaded: result.unloaded.length,
					tokens: shed.reduce((sum, record) => sum + record.tokenEstimate, 0),
				});
				currentState = readContextGcSessionState(ctx);
				records = branchRecords(store, currentState);
				analysis = analyzeActiveContext(event.messages, records);
			}
		}
		// Hot-cache trim: the previous request introduced a slice the model has now
		// read exactly once, and that slice sits after every anchor the provider
		// cached — dropping a consumed record from it costs only the rest of that
		// slice, not the live prefix. Cold-cache trim above owns the opposite case.
		if (hotTrim && !isCacheCold(deferred, now(), modelKey)) {
			const window = hotTrimWindow(deferred);
			if (window) {
				const shed = await selectHotTrimRecords({
					analysis,
					messages: event.messages,
					ctx,
					window,
					// One line per skipped request: without it a production run that never
					// trims is indistinguishable from a run with nothing to trim.
					onSkip: (why, detail) =>
						logger.debug("Context GC: hot trim skipped", { model: modelKey, why, window, ...detail }),
				});
				if (shed.length > 0) {
					const reason = "auto-trim: consumed tool result";
					const result = await runContextUnload(
						store,
						currentState.sessionId,
						{ ids: shed.map(record => record.id), summary: "", reason },
						deriveBranchStatuses(currentState.deltas.filter(delta => delta.sessionId === currentState.sessionId)),
					);
					const projected: string[] = [];
					for (const record of shed) {
						if (!result.unloaded.includes(record.id)) continue;
						pi.appendEntry(CONTEXT_GC_CUSTOM_TYPE, buildContextGcDelta(record, "unload", reason, record.summary));
						projected.push(record.id);
					}
					if (projected.length > 0) {
						// Project on THIS request: leaving it to the lazy path would keep the
						// record in the very prompt the trim was priced to shrink.
						for (const id of projected) deferred.applied.add(id);
						logger.debug("Context GC: hot trim applied", {
							model: modelKey,
							records: projected.length,
							window,
						});
						currentState = readContextGcSessionState(ctx);
						records = branchRecords(store, currentState);
						analysis = analyzeActiveContext(event.messages, records);
					}
				}
			} else {
				logger.debug("Context GC: hot trim skipped", {
					model: modelKey,
					why: "no-window",
					requestMessageCounts: deferred.requestMessageCounts,
					messagesLength: event.messages.length,
				});
			}
		}
		activeSnapshots.set(currentState.sessionId, createActiveSnapshot(currentState, analysis));
		// Unloads are honored lazily: rewriting an early message re-writes the provider
		// prompt cache for everything after it, so pending unloads wait until the cache is
		// cold anyway or the freed share of context is large enough to pay for the rewrite.
		const unloaded = [...analysis.matches.values()]
			.filter(match => match.record.status === "unloaded")
			.map(match => match.record);
		const decision = decideDeferredUnloads({
			unloaded,
			state: deferred,
			contextTokens: ctx.getContextUsage()?.tokens ?? null,
			modelKey,
			now: now(),
		});
		if (decision.reason === "deferred" || decision.newlyApplied.length > 0) {
			logger.debug("Context GC: deferred unload decision", {
				reason: decision.reason,
				deferredTokens: decision.deferredTokens,
				applied: decision.newlyApplied.length,
			});
		}
		// The count is the request as built, before projection (which is 1:1), so the
		// next call can tell which records this one introduced.
		recordRequestMessageCount(deferred, event.messages.length);
		return { messages: projectUnloadedContext(event.messages, records, analysis, decision.projectIds) };
	});

	// Warmth is a per-REQUEST fact: every assistant message the provider returned
	// left a cached prefix behind. Keying it on `turn_end` alone reads cold for
	// the whole first tool loop of a session (the eval: 14 requests, zero hot
	// trims), so the hot path — which only exists for mid-turn work — never ran.
	const recordModelResponse = (message: unknown, ctx: ExtensionContext): void => {
		// Only a model reply proves a cached prefix; a turn that ended on a user or
		// tool message says nothing about warmth.
		if (message && typeof message === "object" && "role" in message && message.role !== "assistant") return;
		const state = deferredUnloadState(readContextGcSessionState(ctx).sessionId);
		const model = ctx.model;
		const { cacheRead, cacheWrite } = readCacheUsage(message);
		const modelKey = modelKeyOf(model);
		const wasCold = isCacheCold(state, now(), modelKey);
		state.lastResponseByModel.set(modelKey, {
			at: now(),
			prefixTokens: cacheRead + cacheWrite,
			writePricePerToken: model?.cost.cacheWrite ?? 0,
		});
		// The first request on a cold prefix is the one a trim was meant to shrink.
		if (wasCold && cacheWrite > 0) {
			logger.debug("Context GC: cold-prefix write", { model: modelKey, cacheWrite, cacheRead });
		}
	};
	pi.on("message_end", (event, ctx) => recordModelResponse(event.message, ctx));
	pi.on("turn_end", (event, ctx) => recordModelResponse(event.message, ctx));

	pi.on("before_agent_start", (event, ctx) => {
		const systemPrompt = appendContextGcSystemPrompt(event.systemPrompt);
		const state = readContextGcSessionState(ctx);
		const snapshot = getActiveSnapshot(ctx);
		const records = branchRecords(store, state);
		const activeRecords = snapshot ? records.filter(record => snapshot.activeRecordIds.includes(record.id)) : records;
		const contextUsage = ctx.getContextUsage();
		const reminder =
			buildContextGcReminder(activeRecords, {
				thresholdTokens: REMINDER_THRESHOLD_TOKENS,
				contextUsage,
				minContextUsagePercent: REMINDER_CONTEXT_USAGE_THRESHOLD_PERCENT,
			}) ??
			(usageHintDue(state.sessionId, contextUsage?.percent)
				? buildContextUsageReminder(contextUsage, COMPACT_HINT_CONTEXT_USAGE_PERCENT)
				: undefined);
		if (!reminder && !systemPrompt) return undefined;
		return {
			...(reminder ? { message: contextGcReminderMessage(reminder) } : {}),
			...(systemPrompt ? { systemPrompt } : {}),
		};
	});

	pi.on("session_shutdown", () => {
		activeSnapshots.clear();
		compactHintBands.clear();
		deferredUnloads.clear();
		store.close();
	});
}
