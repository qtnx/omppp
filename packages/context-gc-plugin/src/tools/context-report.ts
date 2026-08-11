import { type } from "@oh-my-pi/omptype";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import type { ActiveSnapshot } from "../active-context";
import { renderContextGcReportForStore } from "../report";
import { type ContextGcReportGroupBy, type ContextStatus, contextStatusSchema } from "../schema";
import type { ContextGcStore } from "../storage";

const reportBaseSchema = type({
	"status?": contextStatusSchema,
	"limit?": type("number.integer").atLeast(1).atMost(200),
});

const contextStatsInputSchema = type({});
const contextGlobalStatsInputSchema = type({});

const contextTreeInputSchema = type.merge(reportBaseSchema, {
	"groupBy?": type("'status' | 'kind' | 'source'"),
});

const contextDebugInputSchema = type.merge(reportBaseSchema, {
	"includeRecords?": type("boolean"),
});

type ContextStatsInput = Record<string, never>;
type ContextGlobalStatsInput = Record<string, never>;

interface ContextTreeInput {
	status?: ContextStatus;
	groupBy?: ContextGcReportGroupBy;
	limit?: number;
}

interface ContextDebugInput {
	status?: ContextStatus;
	limit?: number;
	includeRecords?: boolean;
}

type GetActiveSnapshot = (ctx: ExtensionContext) => ActiveSnapshot | undefined;

export function createContextStatsTool(
	store: ContextGcStore,
	getActiveSnapshot?: GetActiveSnapshot,
): ToolDefinition<typeof contextStatsInputSchema> {
	return {
		name: "context_stats",
		loadMode: "essential",
		label: "Context stats",
		description: "Show Context GC current-branch stats and token savings.",
		parameters: contextStatsInputSchema,
		async execute(
			_toolCallId: string,
			_params: ContextStatsInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const text = renderContextGcReportForStore(
				{
					agentDir: "",
					cwd: ctx.cwd,
					sessionManager: ctx.sessionManager,
					action: "stats",
					contextUsage: ctx.getContextUsage(),
					activeSnapshot: getActiveSnapshot?.(ctx),
				},
				store,
			);
			return { content: [{ type: "text", text }] };
		},
	};
}

export function createContextGlobalStatsTool(
	store: ContextGcStore,
): ToolDefinition<typeof contextGlobalStatsInputSchema> {
	return {
		name: "context_global_stats",
		loadMode: "essential",
		label: "Context global stats",
		description: "Show Context GC global database stats and total token savings.",
		parameters: contextGlobalStatsInputSchema,
		async execute(
			_toolCallId: string,
			_params: ContextGlobalStatsInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const text = renderContextGcReportForStore(
				{
					agentDir: "",
					cwd: ctx.cwd,
					sessionManager: ctx.sessionManager,
					action: "global",
				},
				store,
			);
			return { content: [{ type: "text", text }] };
		},
	};
}

export function createContextTreeTool(
	store: ContextGcStore,
	getActiveSnapshot?: GetActiveSnapshot,
): ToolDefinition<typeof contextTreeInputSchema> {
	return {
		name: "context_tree",
		loadMode: "essential",
		label: "Context tree",
		description: "Show Context GC current-branch records grouped by status, kind, or source.",
		parameters: contextTreeInputSchema,
		async execute(
			_toolCallId: string,
			params: ContextTreeInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const text = renderContextGcReportForStore(
				{
					agentDir: "",
					cwd: ctx.cwd,
					sessionManager: ctx.sessionManager,
					action: "tree",
					status: params.status,
					groupBy: params.groupBy,
					limit: params.limit,
					activeSnapshot: getActiveSnapshot?.(ctx),
				},
				store,
			);
			return { content: [{ type: "text", text }] };
		},
	};
}

export function createContextDebugTool(
	store: ContextGcStore,
	getActiveSnapshot?: GetActiveSnapshot,
): ToolDefinition<typeof contextDebugInputSchema> {
	return {
		name: "context_debug",
		loadMode: "essential",
		label: "Context debug",
		description: "Show Context GC branch deltas and database aggregates for debugging.",
		parameters: contextDebugInputSchema,
		async execute(
			_toolCallId: string,
			params: ContextDebugInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const text = renderContextGcReportForStore(
				{
					agentDir: "",
					cwd: ctx.cwd,
					sessionManager: ctx.sessionManager,
					action: "debug",
					status: params.status,
					limit: params.limit,
					includeRecords: params.includeRecords,
					activeSnapshot: getActiveSnapshot?.(ctx),
				},
				store,
			);
			return { content: [{ type: "text", text }] };
		},
	};
}
