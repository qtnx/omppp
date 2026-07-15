import type { AssistantMessage, ServiceTier, ServiceTierByFamily, StopReason, Usage } from "@oh-my-pi/pi-ai";
import type { AgentType } from "./shared-types";

export * from "./shared-types";

/**
 * Extracted stats from an assistant message.
 */
export interface MessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Model ID */
	model: string;
	/** Provider name */
	provider: string;
	/** API type */
	api: string;
	/** Unix timestamp in milliseconds */
	timestamp: number;
	/** Request duration in milliseconds */
	duration: number | null;
	/** Time to first token in milliseconds */
	ttft: number | null;
	/** Stop reason */
	stopReason: StopReason;
	/** Error message if stopReason is error */
	errorMessage: string | null;
	/** Token usage */
	usage: Usage;
	/** Which agent produced this message (main agent, task subagent, advisor) */
	agentType: AgentType;
}

/**
 * Full details of a request, including content.
 */
export interface RequestDetails extends MessageStats {
	/** The full conversation history or just the last turn. */
	messages: unknown[];
	/** The model's response. */
	output: unknown;
}

/**
 * Session log entry types.
 */
export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	title?: string;
}

export interface SessionMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AssistantMessage | { role: "user" | "toolResult" };
}

export interface SessionServiceTierChangeEntry {
	type: "service_tier_change";
	id: string;
	parentId?: string | null;
	timestamp: string;
	serviceTier: ServiceTierByFamily | ServiceTier | null;
}

export interface SessionCustomMessageEntry {
	type: "custom_message";
	id: string;
	parentId?: string | null;
	timestamp: string;
	customType: string;
	content: unknown;
	details?: unknown;
	display: boolean;
}

export interface SessionCustomEntry {
	type: "custom";
	id: string;
	parentId?: string | null;
	timestamp: string;
	customType: string;
	data?: unknown;
}

export type SessionEntry =
	| SessionHeader
	| SessionMessageEntry
	| SessionServiceTierChangeEntry
	| SessionCustomMessageEntry
	| SessionCustomEntry
	| { type: string };

/**
 * Behavioral stats extracted from a single user message.
 */
export interface UserMessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path */
	folder: string;
	/** Unix timestamp in ms */
	timestamp: number;
	/** Model that responded to this user message, if linked */
	model: string | null;
	/** Provider that responded to this user message, if linked */
	provider: string | null;
	/** Total characters of message text */
	chars: number;
	/** Whitespace-delimited word count */
	words: number;
	/** Yelling sentences (> 50% uppercase letters) */
	yelling: number;
	/** Profanity hits */
	profanity: number;
	/** Catch-all upset signal: drama runs + `noooo`/`ughh`/... + `dude` + `:(` */
	anguish: number;
	/** Corrective negation ("no", "nope", "thats not what i meant") */
	negation: number;
	/** User repeating themselves ("i meant", "still doesnt work", "like i said") */
	repetition: number;
	/** Second-person reproach ("you didnt", "why did you", "stop X-ing") */
	blame: number;
}

/**
 * Pair emitted by the parser when it sees an assistant message whose
 * `parentId` points to a user message that wasn't parsed in the same pass
 * (e.g. user prompt landed in an earlier incremental sync). The aggregator
 * applies the link to the persisted `user_messages` row so it stops showing
 * up in the "unknown" model bucket.
 */
export interface UserMessageLink {
	sessionFile: string;
	entryId: string;
	model: string;
	provider: string;
}

export interface ReminderStats {
	sessionFile: string;
	entryId: string;
	folder: string;
	timestamp: number;
	model: string;
	provider: string;
	api?: string;
}

export interface DelegationReminderStats extends ReminderStats {
	handsOnCount: number;
	taskCount: number;
	threshold: number;
}

export type SubagentRunPhase = "work" | "review" | "fix";
export type SubagentRunStatus = "completed" | "failed" | "aborted";
export type SubagentAbortReason = "signal" | "terminate" | "timeout" | "budget";

/** Validated v1 telemetry extracted from a `subagent_run` custom entry. */
export interface SubagentRunStats {
	sessionFile: string;
	entryId: string;
	runId: string;
	agent: string;
	phase: SubagentRunPhase;
	parentAgentId?: string;
	parentToolCallId?: string;
	startedAt: number;
	completedAt: number;
	status: SubagentRunStatus;
	abortReason?: SubagentAbortReason;
	model?: string;
	requests: number;
	toolCalls: number;
	maxRuntimeMs: number;
	earlyYieldNoticeSent: boolean;
	queueMs?: number;
	preRunMs?: number;
	setupMs?: number;
	promptToFirstChatMs?: number;
	activeMs?: number;
	totalMs: number;
	modelMs: number;
	toolMs: number;
}

/**
 * One tool call extracted from an assistant message's `toolCall` content
 * blocks. `callsInTurn` records how many calls that assistant turn contained
 * so aggregation can split the turn's real provider usage evenly per call.
 */
export interface ToolCallStats {
	/** Session file path */
	sessionFile: string;
	/** Assistant-message entry ID that emitted the call */
	entryId: string;
	/** Provider-assigned tool call ID (unique within a session) */
	toolCallId: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Tool name */
	toolName: string;
	/** Model that emitted the call */
	model: string;
	/** Provider name */
	provider: string;
	/** Assistant-message timestamp (Unix ms) */
	timestamp: number;
	/** Which agent produced the call */
	agentType: AgentType;
	/** Total tool calls in the same assistant turn (>= 1) */
	callsInTurn: number;
	/** Serialized argument characters */
	argsChars: number;
}

/**
 * Result linkage emitted when the parser sees a `toolResult` message entry.
 * Applied as an UPDATE on the persisted tool-call row — results can land in a
 * later incremental sync pass than the call that produced them.
 */
export interface ToolResultLink {
	sessionFile: string;
	toolCallId: string;
	/** Text characters fed back into context */
	resultChars: number;
	isError: boolean;
}
