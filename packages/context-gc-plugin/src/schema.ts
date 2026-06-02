import * as z from "zod/v4";

export const CONTEXT_GC_CUSTOM_TYPE = "context-gc";
/** Custom type used for projected (unloaded) file-mention/execution placeholders. */
export const CONTEXT_GC_PROJECTED_TYPE = "context-gc-projected";
export const CONTEXT_GC_DB_VERSION = 2;

export const contextKindSchema = z.enum([
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
]);

export const contextStatusSchema = z.enum(["candidate", "unloaded", "pinned"]);
export const contextPolicySchema = z.enum(["candidate", "conservative", "pinned"]);

export type ContextKind = z.infer<typeof contextKindSchema>;
export type ContextStatus = z.infer<typeof contextStatusSchema>;
export type ContextPolicy = z.infer<typeof contextPolicySchema>;

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

export const inventoryInputSchema = z.object({
	status: contextStatusSchema.optional(),
	includePinned: z.boolean().optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

export const unloadInputSchema = z.object({
	ids: z.array(z.string().min(1)).min(1),
	summary: z.string().min(12).max(4000),
	reason: z.string().min(3).max(1000),
});

export const recallInputSchema = z.object({
	id: z.string().min(1),
	mode: z.enum(["summary", "range", "search", "raw"]).optional(),
	selector: z.string().max(200).optional(),
	maxBytes: z.number().int().min(1024).max(200000).optional(),
});

export const pinInputSchema = z.object({
	ids: z.array(z.string().min(1)).min(1),
	pinned: z.boolean().default(true),
	reason: z.string().min(3).max(1000),
});
