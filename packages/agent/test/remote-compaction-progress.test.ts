import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	buildCompactionV2Request,
	type CompactionProgressUpdate,
	requestCompactionV2Streaming,
	shouldUseCompactionV2Streaming,
	shouldUseOpenAiRemoteCompaction,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Local copies of the minimal helpers so this WP's progress test stays
// self-contained and isolated from the broader remote-compaction suite.
function makeOpenAiModel(overrides: Partial<ModelSpec<"openai-responses">> = {}): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	});
}

// Build a fake SSE streaming Response: one `event:/data:` frame per event.
function sseResponse(events: Array<Record<string, unknown>>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [{ role: "user", content: "old work", timestamp: 1 } satisfies AgentMessage],
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent question", timestamp: 2 } satisfies AgentMessage],
		isSplitTurn: false,
		tokensBefore: 123,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: true },
		...overrides,
	};
}

// Minimal local-summarizer output: a single assistant text block, mirroring the
// shape the broader remote-compaction suite feeds through `ai.completeSimple`.
function localSummaryMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: ZERO_USAGE,
		stopReason: "stop",
	} as unknown as AssistantMessage;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("requestCompactionV2Streaming onProgress", () => {
	test("reports cumulative SSE progress and preserves the returned compaction response", async () => {
		const compactionItem = { type: "compaction", encrypted_content: "enc_progress" };
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"instructions",
		);

		// Several data events precede the terminal compaction item + completion.
		const streamEvents: Array<Record<string, unknown>> = [
			{ type: "response.created", response: {} },
			{ type: "response.in_progress", response: {} },
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
			{ type: "response.output_item.done", output_index: 0, item: compactionItem },
			{ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
		];
		const fetchMock: FetchImpl = async () => sseResponse(streamEvents);

		// Spy on a recorder method (no mock.module()) so we can inspect each call.
		const recorder = { onProgress: (_u: CompactionProgressUpdate) => {} };
		const spy = vi.spyOn(recorder, "onProgress");

		const result = await requestCompactionV2Streaming(model, "test-key", request, undefined, {
			fetch: fetchMock,
			onProgress: u => recorder.onProgress(u),
		});

		// The callback fired — once per dispatched SSE data event.
		expect(spy).toHaveBeenCalled();
		expect(spy.mock.calls.length).toBe(streamEvents.length);

		const updates = spy.mock.calls.map(call => call[0]);

		// The first update always arrives; `events` is cumulative (== ordinality).
		for (let i = 0; i < updates.length; i++) {
			expect(updates[i].events).toBe(i + 1);
		}

		// `bytes` is cumulative and monotonically non-decreasing.
		for (let i = 1; i < updates.length; i++) {
			expect(updates[i].bytes).toBeGreaterThanOrEqual(updates[i - 1].bytes);
		}

		// estTokens tracks the byte estimate; bytes are actually accumulating.
		const last = updates[updates.length - 1];
		expect(last.bytes).toBeGreaterThan(0);
		expect(last.estTokens).toBe(Math.ceil(last.bytes / 4));

		// The returned response shape is unchanged: exactly one compaction item.
		expect(result.compactionItem).toEqual(compactionItem);
		expect(result.replacementHistory.at(-1)).toEqual(compactionItem);
		expect(result.usedTokens).toBe(10);
	});
});

describe("compact() onProgress is a V2-streaming-only sink", () => {
	// Contract (agent CHANGELOG: "Only the V2 streaming path emits it; V1 and
	// local summarization are unchanged"). onProgress reports cumulative SSE
	// counters ONLY while the OpenAI V2 streaming compaction runs. The V1
	// `/responses/compact` remote path and the local-summarization path must run
	// to completion without ever invoking the caller's onProgress. These pin the
	// negative half so a future change that wires onProgress into either path
	// (flickering a live progress indicator on a non-streaming compaction) reddens.

	test("V1 /responses/compact remote path completes without invoking onProgress", async () => {
		// Default openai-responses model: provider "openai" makes the V1 remote
		// path eligible; the absence of remoteCompaction.v2StreamingEnabled keeps
		// V2 streaming out of the running.
		const model = makeOpenAiModel();
		expect(shouldUseCompactionV2Streaming(model)).toBe(false);
		expect(shouldUseOpenAiRemoteCompaction(model)).toBe(true);

		// Any local summarizer call would mean the V1 path did not actually run.
		const completeSpy = vi
			.spyOn(ai, "completeSimple")
			.mockRejectedValue(new Error("local summarizer should not run on the V1 path"));
		// The V1 `/responses/compact` endpoint answers with a compaction_summary.
		const fetchMock: FetchImpl = async () =>
			Response.json({ output: [{ type: "compaction_summary", summary: "V1 compact summary" }] });

		const recorder = { onProgress: (_u: CompactionProgressUpdate) => {} };
		const spy = vi.spyOn(recorder, "onProgress");

		const result = await compact(makePreparation(), model, "test-key", undefined, undefined, {
			fetch: fetchMock,
			onProgress: recorder.onProgress,
		});

		// The V1 path ran end to end: its remote summary is used verbatim, with
		// no fallback to a local summarization round.
		expect(result.summary).toBe("V1 compact summary");
		expect(completeSpy).not.toHaveBeenCalled();
		// Negative contract: no streaming progress on the non-streaming path.
		expect(spy).not.toHaveBeenCalled();
	});

	test("local summarization path completes without invoking onProgress", async () => {
		// remoteEnabled:false gates BOTH remote branches off, so compaction is
		// forced down the local `ai.completeSimple` summarization path.
		const model = makeOpenAiModel();
		const preparation = makePreparation({
			settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		});

		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary text"));

		const recorder = { onProgress: (_u: CompactionProgressUpdate) => {} };
		const spy = vi.spyOn(recorder, "onProgress");

		const result = await compact(preparation, model, "test-key", undefined, undefined, {
			onProgress: recorder.onProgress,
		});

		// The local path ran: completeSimple produced the summary text.
		expect(completeSpy).toHaveBeenCalled();
		expect(result.summary).toContain("local summary text");
		// Negative contract: local summarization emits no streaming progress.
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("compact() e2e: caller onProgress survives the summaryOptions rebuild", () => {
	test("drives the real V2 streaming path so onProgress fires and a compacted result is produced", async () => {
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		expect(shouldUseCompactionV2Streaming(model)).toBe(true);

		const compactionItem = { type: "compaction", encrypted_content: "enc_progress" };
		const streamEvents: Array<Record<string, unknown>> = [
			{ type: "response.created", response: {} },
			{ type: "response.in_progress", response: {} },
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
			{ type: "response.output_item.done", output_index: 0, item: compactionItem },
			{ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
		];
		const fetchMock: FetchImpl = async () => sseResponse(streamEvents);

		const recorder = { onProgress: (_u: CompactionProgressUpdate) => {} };
		const spy = vi.spyOn(recorder, "onProgress");

		const result = await compact(makePreparation(), model, "test-key", undefined, undefined, {
			fetch: fetchMock,
			onProgress: u => recorder.onProgress(u),
		});

		expect(spy).toHaveBeenCalled();

		const updates = spy.mock.calls.map(call => call[0]);
		for (let i = 0; i < updates.length; i++) {
			expect(updates[i].events).toBe(i + 1);
		}
		for (let i = 1; i < updates.length; i++) {
			expect(updates[i].bytes).toBeGreaterThanOrEqual(updates[i - 1].bytes);
		}

		expect(result.shortSummary).toBe("Remote compaction");
		expect(result.summary).toContain("Remote compaction preserved provider-native history");
	});
});
