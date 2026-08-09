import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { CompactionProgressUpdate } from "@oh-my-pi/pi-agent-core/compaction";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// WP4 contract: the PUBLIC manual `compact()` method must forward its
// `CompactOptions.onProgress` into the underlying `compaction.compact()`
// `SummaryOptions.onProgress`, so the manual `/compact` overlay gets the live
// `~N tok` counter (parity with the auto path). This test spies
// `compaction.compact` (no network) and drives the passed onProgress a couple
// of times, then asserts the caller's callback received the cumulative
// {events,bytes,estTokens} updates.

function createAssistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("AgentSession manual compact() onProgress forwarding", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-manual-compaction-progress-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(): Promise<{ session: AgentSession }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": false,
			// context-full (not snapcompact) so manual compact takes the LLM-summary
			// path through #compactWithFallbackModel -> compaction.compact.
			"compaction.strategy": "context-full",
			// Keep almost nothing recent so even a tiny session is compactable.
			"compaction.keepRecentTokens": 1,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockBashTool], messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: () => {
				const response = createAssistantResponse("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		const toolRegistry = new Map<string, AgentTool>([[mockBashTool.name, mockBashTool]]);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, toolRegistry });

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session };
	}

	it("forwards CompactOptions.onProgress into compaction.compact and invokes it with cumulative counters", async () => {
		const { session } = await createHarness();

		// Spy the summary call so the SSE onProgress is driven directly (no network).
		// The spy asserts the callback rode through as SummaryOptions.onProgress and
		// then fires two cumulative updates back to the caller.
		vi.spyOn(compactionModule, "compact").mockImplementation(
			async (preparation, _candidate, _apiKey, _custom, _signal, options) => {
				const onProgress = options?.onProgress;
				expect(typeof onProgress).toBe("function");
				onProgress?.({ events: 1, bytes: 400, estTokens: 100 });
				onProgress?.({ events: 2, bytes: 900, estTokens: 225 });
				return {
					summary: "compacted",
					shortSummary: undefined,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {},
				};
			},
		);

		// Build up some history so prepareCompaction has something to summarize.
		await session.prompt("first question about the parser");
		await session.agent.waitForIdle();
		await session.prompt("second question about the parser");
		await session.agent.waitForIdle();

		const updates: CompactionProgressUpdate[] = [];
		const result = await session.compact(undefined, {
			onProgress: u => updates.push(u),
		});

		// The forwarding chain (public compact -> #compactWithFallbackModel ->
		// compaction.compact.SummaryOptions.onProgress -> caller callback) fired
		// both cumulative updates in order.
		expect(result.summary).toBe("compacted");
		expect(updates).toEqual([
			{ events: 1, bytes: 400, estTokens: 100 },
			{ events: 2, bytes: 900, estTokens: 225 },
		]);
	});
});
