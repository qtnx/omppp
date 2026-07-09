import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

// WP2 contract: auto-compaction emits a throttled `auto_compaction_progress`
// session event (fed by agent-core's onProgress) between start and end. This
// test mocks `compaction.compact` so its SummaryOptions.onProgress is driven in
// rapid synchronous bursts, then asserts throttling + chronology on the events
// the session actually emits.

function makeCompactionModel() {
	return buildModel({
		id: "gpt-5-compaction-progress",
		name: "GPT-5 compaction progress",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
	} satisfies Partial<ModelSpec<"openai-responses">>);
}

function createAssistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-responses" as const,
		provider: "openai" as const,
		model: "gpt-5-compaction-progress",
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

/** Emit a high-usage assistant turn above the model's threshold to drive context-full auto-compaction. */
function emitHighUsageTurn(session: AgentSession, contextWindow: number): void {
	const assistantMsg = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Done." }],
		api: "openai-responses" as const,
		provider: "openai" as const,
		model: "gpt-5-compaction-progress",
		stopReason: "stop" as const,
		usage: {
			input: Math.ceil(contextWindow * 0.9),
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: Math.ceil(contextWindow * 0.9) + 1_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
}

describe("AgentSession auto_compaction_progress", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-compaction-progress-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(): Promise<{
		session: AgentSession;
		events: AgentSessionEvent[];
		waitForEnd: Promise<void>;
		contextWindow: number;
	}> {
		const model = makeCompactionModel();

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": false,
			"compaction.strategy": "context-full",
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

		const events: AgentSessionEvent[] = [];
		const compactionEnd = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (
				event.type === "auto_compaction_start" ||
				event.type === "auto_compaction_progress" ||
				event.type === "auto_compaction_end"
			) {
				events.push(event);
				if (event.type === "auto_compaction_end") compactionEnd.resolve();
			}
		});

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return {
			session,
			events,
			waitForEnd: compactionEnd.promise,
			contextWindow: model.contextWindow ?? 200_000,
		};
	}

	it("emits throttled progress between start and end during a real-model compaction", async () => {
		const { session, events, waitForEnd, contextWindow } = await createHarness();

		// Mock the summary so the SSE onProgress is driven directly (no network).
		// Two bursts of 10 synchronous calls each, separated by a >200ms gap, so
		// the ~200ms throttle collapses each burst to a single emitted event.
		vi.spyOn(compactionModule, "compact").mockImplementation(
			async (preparation, _candidate, _apiKey, _custom, _signal, options) => {
				const onProgress = options?.onProgress;
				if (onProgress) {
					for (let i = 1; i <= 10; i++) {
						onProgress({ events: i, bytes: i * 400, estTokens: Math.ceil((i * 400) / 4) });
					}
					await Bun.sleep(220); // Cross the production throttle window intentionally.
					for (let i = 11; i <= 20; i++) {
						onProgress({ events: i, bytes: i * 400, estTokens: Math.ceil((i * 400) / 4) });
					}
				}
				return {
					summary: "compacted",
					shortSummary: undefined,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {},
				};
			},
		);

		await session.prompt("refactor the parser across modules");
		emitHighUsageTurn(session, contextWindow);
		await waitForEnd;

		const startIdx = events.findIndex(e => e.type === "auto_compaction_start");
		const endIdx = events.findIndex(e => e.type === "auto_compaction_end");
		const progress = events.filter(e => e.type === "auto_compaction_progress");

		// (a) at least one progress event with the correct action + monotonic elapsedMs.
		expect(progress.length).toBeGreaterThanOrEqual(1);
		for (const p of progress) {
			expect(p.action).toBe("context-full");
			expect(p.events).toBeGreaterThan(0);
			expect(p.bytes).toBeGreaterThan(0);
		}
		const elapsed = progress.map(p => p.elapsedMs);
		for (let i = 1; i < elapsed.length; i++) {
			expect(elapsed[i]).toBeGreaterThanOrEqual(elapsed[i - 1]!);
		}

		// (b) throttling collapses a 20-call burst to far fewer emitted events.
		expect(progress.length).toBeLessThan(20);

		// (c) every progress event falls chronologically between start and end.
		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(endIdx).toBeGreaterThan(startIdx);
		for (let i = 0; i < events.length; i++) {
			if (events[i]?.type === "auto_compaction_progress") {
				expect(i).toBeGreaterThan(startIdx);
				expect(i).toBeLessThan(endIdx);
			}
		}
	});
});
