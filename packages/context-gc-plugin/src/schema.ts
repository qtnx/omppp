import { type } from "@oh-my-pi/omptype";

export const CONTEXT_GC_CUSTOM_TYPE = "context-gc";
/** Custom type used for projected (unloaded) file-mention/execution placeholders. */
export const CONTEXT_GC_PROJECTED_TYPE = "context-gc-projected";
export const CONTEXT_GC_DB_VERSION = 2;

export const contextKindSchema = type.enumerated(
	"tool_result",
	"file_read",
	"file_mention",
	"skill",
	"bash_execution",
	"python_execution",
	"subagent_output",
	"browser_output",
	"mcp_output",
	"custom_tool_output",
);

export const contextStatusSchema = type.enumerated("candidate", "unloaded", "pinned");
export const contextPolicySchema = type.enumerated("candidate", "conservative", "pinned");

export type ContextKind = typeof contextKindSchema.infer;
export type ContextStatus = typeof contextStatusSchema.infer;
export type ContextPolicy = typeof contextPolicySchema.infer;

export type ContextGcReportAction = "stats" | "global" | "tree" | "debug";
export type ContextGcReportGroupBy = "status" | "kind" | "source";

export interface ContextGcReportSessionManager {
	getSessionId(): string | undefined | null;
	getSessionFile(): string | undefined | null;
	getEntries(): unknown;
	getBranch?(): unknown;
}

export interface ContextGcReportOptions {
	agentDir: string;
	cwd: string;
	sessionManager: ContextGcReportSessionManager;
	action: ContextGcReportAction;
	status?: ContextStatus;
	groupBy?: ContextGcReportGroupBy;
	limit?: number;
	includeRecords?: boolean;
	contextUsage?: {
		tokens?: number | null;
		contextWindow: number;
		percent?: number | null;
	};
}
export interface ContextSource {
	entryId?: string;
	customType?: string;
	toolCallId?: string;
	toolName?: string;
	path?: string;
	uri?: string;
	command?: string;
	skillName?: string;
}

export interface ContextRecord {
	id: string;
	sessionId: string;
	sessionFile: string | null;
	status: ContextStatus;
	kind: ContextKind;
	source: ContextSource;
	payloadHash: string;
	artifactId: string | null;
	sourceUri: string | null;
	summary: string;
	tokenEstimate: number;
	createdAt: string;
	updatedAt: string;
	unloadedAt: string | null;
	recallCount: number;
}

export interface ContextPayload {
	hash: string;
	mediaType: string;
	byteLength: number;
	/** Canonical stored payload: structured JSON when image-bearing, else plain text. */
	text: string;
	/** Plain-text projection used for summaries, search, range slices, and projection matching. */
	textProjection: string;
	createdAt: string;
}

export interface ContextGcDelta {
	op: "candidate" | "unload" | "pin" | "unpin" | "recall";
	id: string;
	sessionId: string;
	payloadHash?: string;
	status?: ContextStatus;
	summary?: string;
	reason?: string;
	createdAt: string;
}

export const inventoryInputSchema = type({
	"status?": contextStatusSchema,
	"includePinned?": type("boolean"),
	"limit?": type("number.integer").atLeast(1).atMost(200),
});

export const unloadInputSchema = type({
	ids: type("string").atLeastLength(1).array().atLeastLength(1),
	summary: type("string").atLeastLength(12).atMostLength(4000),
	reason: type("string").atLeastLength(3).atMostLength(1000),
});

export const recallInputSchema = type({
	id: type("string").atLeastLength(1),
	"mode?": type("'summary' | 'range' | 'search' | 'raw'"),
	"selector?": type("string").atMostLength(200),
	"maxBytes?": type("number.integer").atLeast(1024).atMost(200000),
});

export const pinInputSchema = type({
	ids: type("string").atLeastLength(1).array().atLeastLength(1),
	pinned: type("boolean").default(true),
	reason: type("string").atLeastLength(3).atMostLength(1000),
});
