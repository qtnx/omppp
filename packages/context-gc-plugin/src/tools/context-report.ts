import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import * as z from "zod/v4";
import { renderContextGcReportForStore } from "../report";
import { type ContextGcReportGroupBy, type ContextStatus, contextStatusSchema } from "../schema";
import type { ContextGcStore } from "../storage";

const reportBaseSchema = z.object({
	status: contextStatusSchema.optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

const contextStatsInputSchema = z.object({});
const contextGlobalStatsInputSchema = z.object({});

const contextTreeInputSchema = reportBaseSchema.extend({
	groupBy: z.enum(["status", "kind", "source"]).optional(),
});

const contextDebugInputSchema = reportBaseSchema.extend({
	includeRecords: z.boolean().optional(),
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

export function createContextStatsTool(store: ContextGcStore): ToolDefinition<typeof contextStatsInputSchema> {
	return {
		name: "context_stats",
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

export function createContextTreeTool(store: ContextGcStore): ToolDefinition<typeof contextTreeInputSchema> {
	return {
		name: "context_tree",
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
				},
				store,
			);
			return { content: [{ type: "text", text }] };
		},
	};
}

export function createContextDebugTool(store: ContextGcStore): ToolDefinition<typeof contextDebugInputSchema> {
	return {
		name: "context_debug",
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
				},
				store,
			);
			return { content: [{ type: "text", text }] };
		},
	};
}
