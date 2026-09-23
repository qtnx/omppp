import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { payloadForMessage } from "./extract";
import type { ContextRecord } from "./schema";
import type { ContextGcSessionState } from "./session-state";
import { estimateTokens as estimateTextTokens } from "./summary";

const MAX_ISSUE_COUNT = 1_000;
const tokenizer = new Tokenizer();

export interface ActiveContextIssueCounts {
	legacy_record: number;
	payload_mismatch: number;
	inactive_identity: number;
	duplicate_claim: number;
}

export interface ActiveContextEstimate {
	readonly id: string;
	readonly sourceTokens: number;
	readonly potentialTokens: number;
	readonly netTokens: number;
}

export interface ActiveContextMatch {
	readonly record: ContextRecord;
	readonly messageIndex: number;
	readonly estimate: ActiveContextEstimate;
}

/**
 * Transient exact-match analysis for one LLM context build. It holds message indexes only; callers
 * persist an ActiveSnapshot when they need a later, branch-validated view.
 */
export interface ActiveContextAnalysis {
	readonly matches: ReadonlyMap<string, ActiveContextMatch>;
	readonly activeRecordIds: readonly string[];
	readonly estimates: ReadonlyMap<string, ActiveContextEstimate>;
	readonly issueCounts: ActiveContextIssueCounts;
}

/**
 * Branch-scoped active-context facts. This deliberately stores IDs and numbers only: the context
 * messages remain owned by the extension event and are never retained by the plugin.
 */
export interface ActiveSnapshot {
	readonly sessionId: string;
	readonly branchEntryIds: readonly string[];
	readonly activeRecordIds: readonly string[];
	readonly estimates: readonly ActiveContextEstimate[];
	readonly issueCounts: ActiveContextIssueCounts;
}

interface MessageIdentity {
	readonly kind: "tool" | "entry";
	readonly value: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function emptyIssueCounts(): ActiveContextIssueCounts {
	return { legacy_record: 0, payload_mismatch: 0, inactive_identity: 0, duplicate_claim: 0 };
}

function incrementIssue(issues: ActiveContextIssueCounts, key: keyof ActiveContextIssueCounts): void {
	issues[key] = Math.min(MAX_ISSUE_COUNT, issues[key] + 1);
}

function sourceIdentity(record: ContextRecord): MessageIdentity | undefined {
	if (typeof record.source.toolCallId === "string" && record.source.toolCallId.length > 0) {
		return { kind: "tool", value: record.source.toolCallId };
	}
	if (typeof record.source.entryId === "string" && record.source.entryId.length > 0) {
		return { kind: "entry", value: record.source.entryId };
	}
	return undefined;
}

function messageEntryId(message: AgentMessage): string | undefined {
	const surface = asRecord(message);
	for (const key of ["entryId", "id", "messageId"]) {
		const value = surface[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function messageIdentity(message: AgentMessage): MessageIdentity | undefined {
	const surface = asRecord(message);
	if (surface.role === "toolResult" && typeof surface.toolCallId === "string" && surface.toolCallId.length > 0) {
		return { kind: "tool", value: surface.toolCallId };
	}
	const entryId = messageEntryId(message);
	return entryId ? { kind: "entry", value: entryId } : undefined;
}

function identityKey(identity: MessageIdentity): string {
	return `${identity.kind}\u0000${identity.value}`;
}

function hasMatchingNonToolKind(message: AgentMessage, record: ContextRecord): boolean {
	const surface = asRecord(message);
	switch (record.kind) {
		case "custom_tool_output":
			return surface.role === "custom" && surface.customType === record.source.customType;
		case "file_mention":
			return surface.role === "fileMention";
		case "bash_execution":
			return surface.role === "bashExecution";
		case "python_execution":
			return surface.role === "pythonExecution";
		default:
			return false;
	}
}

function isProjectableSnapshotMessage(message: AgentMessage): boolean {
	const surface = asRecord(message);
	switch (surface.role) {
		case "toolResult":
			return typeof surface.toolCallId === "string" && typeof surface.toolName === "string";
		case "custom":
		case "fileMention":
			return true;
		case "bashExecution":
		case "pythonExecution":
			return surface.excludeFromContext !== true;
		default:
			return false;
	}
}

export function buildContextGcPlaceholder(record: Pick<ContextRecord, "id" | "summary" | "artifactId">): string {
	const lines = [`Summary: ${record.summary}`];
	if (record.artifactId) lines.push(`Artifact: ${record.artifactId}`);
	lines.push(`Recall: context_recall {"id":"${escapeJsonString(record.id)}"}`);
	return lines.join("\n");
}

function estimateActiveMessageTokens(message: AgentMessage): number {
	return Math.max(tokenizer.countMessage(message), estimateTextTokens(payloadForMessage(message).text));
}

export function analyzeActiveContext(
	messages: readonly AgentMessage[],
	records: readonly ContextRecord[],
): ActiveContextAnalysis {
	const issues = emptyIssueCounts();
	const matches = new Map<string, ActiveContextMatch>();
	const estimates = new Map<string, ActiveContextEstimate>();
	const claimedMessages = new Set<number>();
	// One pass over the context buckets message indexes by identity, so a record probes only its own
	// candidates instead of rescanning every message, and each candidate is hashed at most once.
	const messagesByIdentity = new Map<string, number[]>();
	for (let index = 0; index < messages.length; index++) {
		const identity = messageIdentity(messages[index]);
		if (!identity) continue;
		const key = identityKey(identity);
		const bucket = messagesByIdentity.get(key);
		if (bucket) bucket.push(index);
		else messagesByIdentity.set(key, [index]);
	}
	const payloadHashes = new Map<number, string>();
	const payloadHashAt = (index: number): string => {
		const cached = payloadHashes.get(index);
		if (cached !== undefined) return cached;
		const hash = Bun.SHA256.hash(payloadForMessage(messages[index]).stored, "hex");
		payloadHashes.set(index, hash);
		return hash;
	};

	for (const record of records) {
		const identity = sourceIdentity(record);
		if (!identity) {
			incrementIssue(issues, "legacy_record");
			continue;
		}

		let identityMatched = false;
		let exactMatched = false;
		let messageIndex: number | undefined;
		for (const index of messagesByIdentity.get(identityKey(identity)) ?? []) {
			// The bucket already guarantees identity equality; only the record-kind authority check
			// for non-tool identities remains.
			if (identity.kind !== "tool" && !hasMatchingNonToolKind(messages[index], record)) continue;
			identityMatched = true;
			if (payloadHashAt(index) !== record.payloadHash) continue;
			exactMatched = true;
			if (claimedMessages.has(index)) continue;
			messageIndex = index;
			break;
		}

		if (!identityMatched) {
			incrementIssue(issues, "inactive_identity");
			continue;
		}
		if (!exactMatched) {
			incrementIssue(issues, "payload_mismatch");
			continue;
		}
		if (messageIndex === undefined) {
			incrementIssue(issues, "duplicate_claim");
			continue;
		}

		claimedMessages.add(messageIndex);
		const message = messages[messageIndex];
		if (!message) continue;
		const potentialTokens = estimateActiveMessageTokens(message);
		const placeholderTokens = estimateTextTokens(buildContextGcPlaceholder(record));
		const netTokens = Math.max(0, potentialTokens - placeholderTokens);
		const estimate: ActiveContextEstimate = {
			id: record.id,
			sourceTokens: record.tokenEstimate,
			potentialTokens,
			netTokens,
		};
		estimates.set(record.id, estimate);
		matches.set(record.id, { record, messageIndex, estimate });
	}

	return { matches, activeRecordIds: [...matches.keys()], estimates, issueCounts: issues };
}

export function createActiveSnapshot(state: ContextGcSessionState, analysis: ActiveContextAnalysis): ActiveSnapshot {
	return {
		sessionId: state.sessionId,
		branchEntryIds: state.messageEntries.map(entry => entry.id),
		activeRecordIds: [...analysis.activeRecordIds],
		estimates: [...analysis.estimates.values()],
		issueCounts: { ...analysis.issueCounts },
	};
}

export function isActiveSnapshotValid(snapshot: ActiveSnapshot | undefined, state: ContextGcSessionState): boolean {
	if (!snapshot || snapshot.sessionId !== state.sessionId) return false;
	const capturedEntryIds = new Set(snapshot.branchEntryIds);
	const currentBranchIds = new Set(state.messageEntries.map(entry => entry.id));
	if (!snapshot.branchEntryIds.every(id => currentBranchIds.has(id))) return false;
	return state.messageEntries.every(
		entry => capturedEntryIds.has(entry.id) || !isProjectableSnapshotMessage(entry.message),
	);
}

export function activeSnapshotEstimate(snapshot: ActiveSnapshot, id: string): ActiveContextEstimate | undefined {
	return snapshot.estimates.find(estimate => estimate.id === id);
}

function escapeJsonString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
