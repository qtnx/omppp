import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { CONTEXT_GC_CUSTOM_TYPE, type ContextGcDelta, recallInputSchema } from "../schema";
import { deriveBranchSummaries, readContextGcSessionState } from "../session-state";
import type { ContextGcStore } from "../storage";
import { type PayloadSelector, selectPayload } from "../summary";
import { buildContextGcDelta } from "./context-unload";

type AppendDelta = (customType: string, data: ContextGcDelta) => void;

const DEFAULT_MAX_BYTES = 16_384;

export interface ContextRecallInput {
	id: string;
	mode?: "summary" | "raw" | "range" | "search";
	selector?: string;
	maxBytes?: number;
}

export interface RecalledContext {
	id: string;
	payloadHash: string;
	mode: "summary" | "raw" | "range" | "search";
	text: string;
	bytes: number;
	truncated: boolean;
}

export interface ContextRecallResult {
	items: RecalledContext[];
	skipped: Array<{ id: string; reason: string }>;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function selectorFor(input: ContextRecallInput, summary: string): PayloadSelector {
	const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
	const mode = input.mode ?? "raw";
	if (mode === "summary") return { type: "summary", summary, maxBytes };
	if (mode === "range") {
		const range = input.selector;
		if (!range || !/^\d+(?:-\d+)?$/.test(range))
			throw new Error("context_recall range mode requires selector N or N-M.");
		return { type: "range", range: range as `${number}` | `${number}-${number}`, maxBytes };
	}
	if (mode === "search") {
		if (!input.selector) throw new Error("context_recall search mode requires a selector query.");
		return { type: "search", query: input.selector, maxBytes };
	}
	return { type: "raw", maxBytes };
}

export async function runContextRecall(
	store: ContextGcStore,
	sessionId: string,
	input: ContextRecallInput,
	branchSummaries?: ReadonlyMap<string, string>,
): Promise<ContextRecallResult> {
	const skipped: Array<{ id: string; reason: string }> = [];
	const record = store.getRecord(input.id);
	if (!record) return { items: [], skipped: [{ id: input.id, reason: "missing-record" }] };
	if (record.sessionId !== sessionId) return { items: [], skipped: [{ id: input.id, reason: "cross-session" }] };

	const payload = store.getPayload(record.payloadHash);
	if (!payload) return { items: [], skipped: [{ id: input.id, reason: "missing-payload" }] };

	// Summary recall must surface the branch-effective summary (the active-branch unload summary
	// when present), never the durable DB base summary that a sibling branch may still rely on.
	const effectiveSummary = branchSummaries?.get(record.id) ?? record.summary;
	const selector = selectorFor(input, effectiveSummary);
	const mode = input.mode ?? "raw";
	// Raw recall exposes the lossless stored payload (structured JSON for image-bearing content);
	// summary/range/search operate on the plain-text projection.
	const source = mode === "raw" ? payload.text : payload.textProjection;
	const selected = selectPayload(source, selector);
	const bytes = byteLength(selected);
	const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
	store.incrementRecall(record.id);
	return {
		items: [
			{
				id: record.id,
				payloadHash: record.payloadHash,
				mode,
				text: selected,
				bytes,
				truncated: bytes >= maxBytes && payload.byteLength > bytes,
			},
		],
		skipped,
	};
}

export function formatContextRecall(result: ContextRecallResult): string {
	const lines = [`Context GC recalled ${result.items.length} item(s).`];
	for (const item of result.items) {
		lines.push(`\n## ${item.id} (${item.mode}, ${item.bytes} bytes)`, item.text);
		if (item.truncated)
			lines.push("[Context GC: output truncated; recall with a narrower range/search or larger maxBytes.]");
	}
	if (result.skipped.length > 0)
		lines.push(`\nSkipped: ${result.skipped.map(item => `${item.id} (${item.reason})`).join(", ")}`);
	return lines.join("\n");
}

export function createContextRecallTool(
	store: ContextGcStore,
	appendDelta?: AppendDelta,
): ToolDefinition<typeof recallInputSchema> {
	return {
		name: "context_recall",
		label: "Recall context",
		description:
			"Recall durable Context GC payloads from SQLite by record id. Supports summary, raw, range, and search recall with maxBytes bounds.",
		parameters: recallInputSchema,
		async execute(
			_toolCallId: string,
			params: ContextRecallInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult> {
			const session = readContextGcSessionState(ctx);
			const result = await runContextRecall(store, session.sessionId, params, deriveBranchSummaries(session.deltas));
			for (const item of result.items) {
				const record = store.getRecord(item.id);
				if (record) appendDelta?.(CONTEXT_GC_CUSTOM_TYPE, buildContextGcDelta(record, "recall"));
			}
			return {
				content: [{ type: "text", text: formatContextRecall(result) }],
				details: { items: result.items.map(item => ({ ...item, text: undefined })), skipped: result.skipped },
			};
		},
	};
}
