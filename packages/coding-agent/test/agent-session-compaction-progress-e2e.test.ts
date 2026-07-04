import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
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

// Session-level e2e: real AgentSession + real compaction.compact() on the V2
// streaming path. Progress is driven by a fake SSE fetch (no compact() stub).

const V2_ENDPOINT = "https://compact.example/v1/responses";

function makeOpenAiV2Model() {
	return buildModel({
		id: "gpt-5-compaction-e2e",
		name: "GPT-5 compaction e2e",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		remoteCompaction: {
			enabled: true,
			v2StreamingEnabled: true,
			v2Endpoint: V2_ENDPOINT,
		},
	} satisfies Partial<ModelSpec<"openai-responses">>);
}

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

function createAssistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-responses" as const,
		provider: "openai" as const,
		model: "gpt-5-compaction-e2e",
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

/** Emit a high-usage assistant turn to drive threshold (context-full) auto-compaction. */
function emitHighUsageTurn(session: AgentSession): void {
	const assistantMsg = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Done." }],
		api: "openai-responses" as const,
		provider: "openai" as const,
		model: "gpt-5-compaction-e2e",
		stopReason: "stop" as const,
		usage: {
			input: 190_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 191_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
}

describe("AgentSession auto_compaction_progress e2e", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-compaction-progress-e2e-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(): Promise<{ session: AgentSession; events: AgentSessionEvent[] }> {
		const model = makeOpenAiV2Model();

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": false,
			"compaction.strategy": "context-full",
			"compaction.remoteEnabled": true,
			"compaction.remoteStreamingV2Enabled": true,
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
		session.subscribe(event => {
			if (
				event.type === "auto_compaction_start" ||
				event.type === "auto_compaction_progress" ||
				event.type === "auto_compaction_end"
			) {
				events.push(event);
			}
		});

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, events };
	}

	function waitForEnd(events: AgentSessionEvent[]): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setInterval(() => {
			if (events.some(e => e.type === "auto_compaction_end")) {
				clearInterval(timer);
				resolve();
			}
		}, 5);
		return promise;
	}

	it("emits auto_compaction_progress from real V2 streaming compaction without stubbing compact()", async () => {
		const compactionItem = { type: "compaction", encrypted_content: "enc_e2e_progress" };
		const streamEvents: Array<Record<string, unknown>> = [
			{ type: "response.created", response: {} },
			{ type: "response.in_progress", response: {} },
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
			{ type: "response.output_item.done", output_index: 0, item: compactionItem },
			{ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
		];

		const fetchMock: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.startsWith(V2_ENDPOINT)) {
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				expect(body?.stream).toBe(true);
				return sseResponse(streamEvents);
			}
			throw new Error(`Unexpected fetch URL in compaction e2e: ${url}`);
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

		const { session, events } = await createHarness();

		await session.prompt("refactor the parser across modules");
		emitHighUsageTurn(session);
		await waitForEnd(events);

		const startIdx = events.findIndex(e => e.type === "auto_compaction_start");
		const endIdx = events.findIndex(e => e.type === "auto_compaction_end");
		const progress = events.filter(e => e.type === "auto_compaction_progress");

		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(endIdx).toBeGreaterThan(startIdx);
		expect(progress.length).toBeGreaterThanOrEqual(1);

		for (const p of progress) {
			expect(p.action).toBe("context-full");
			expect(p.events).toBeGreaterThan(0);
			expect(p.bytes).toBeGreaterThan(0);
			const idx = events.indexOf(p);
			expect(idx).toBeGreaterThan(startIdx);
			expect(idx).toBeLessThan(endIdx);
		}
	});
});
