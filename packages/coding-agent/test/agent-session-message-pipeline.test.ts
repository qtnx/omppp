import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	clearCustomApis,
	type Message,
	type Model,
	registerCustomApi,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AgentSession,
	type AgentSessionEvent,
	ANTHROPIC_TOOL_CALL_BATCH_CAP,
	resolveToolCallBatchCapForModel,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { CONTEXT_GC_CUSTOM_TYPE, type ContextGcDelta } from "../../context-gc-plugin/src/schema";
import { openContextGcStore } from "../../context-gc-plugin/src/storage";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function createAgent(): Agent {
	return new Agent({
		initialState: {
			systemPrompt: ["system prompt"],
			messages: [],
			tools: [],
		},
	});
}

describe("AgentSession message pipeline", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("enables the tool-call batch cap only for Anthropic Claude Opus 4.8 models", () => {
		const baseModel: Model = {
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};
		const anthropicOpus48: Model = {
			...baseModel,
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			api: "anthropic",
			provider: "anthropic",
		};

		expect(resolveToolCallBatchCapForModel(anthropicOpus48)).toBe(ANTHROPIC_TOOL_CALL_BATCH_CAP);
		expect(resolveToolCallBatchCapForModel({ ...anthropicOpus48, id: "claude-opus-4.8" })).toBe(
			ANTHROPIC_TOOL_CALL_BATCH_CAP,
		);
		expect(resolveToolCallBatchCapForModel({ ...anthropicOpus48, id: "claude-opus-4-8-20260530" })).toBe(
			ANTHROPIC_TOOL_CALL_BATCH_CAP,
		);
		expect(resolveToolCallBatchCapForModel({ ...anthropicOpus48, provider: "openrouter" })).toBeUndefined();
		expect(resolveToolCallBatchCapForModel({ ...anthropicOpus48, id: "claude-sonnet-4-8" })).toBeUndefined();
		expect(resolveToolCallBatchCapForModel({ ...anthropicOpus48, id: "claude-opus-4-7" })).toBeUndefined();
		expect(resolveToolCallBatchCapForModel({ ...anthropicOpus48, id: "claude-opus-4-9" })).toBeUndefined();
		expect(resolveToolCallBatchCapForModel({ ...anthropicOpus48, id: "claude-opus-4-80" })).toBeUndefined();
		expect(resolveToolCallBatchCapForModel(baseModel)).toBeUndefined();
		expect(resolveToolCallBatchCapForModel({ ...baseModel, provider: "openai-codex" })).toBeUndefined();
	});

	it("applies transformContext before convertToLlm", async () => {
		const inputMessages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		const transformedMessages: AgentMessage[] = [
			...inputMessages,
			{ role: "user", content: "injected context", timestamp: Date.now() },
		];
		const convertedMessages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "converted" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		];
		const transformContext = vi.fn(async (messages: AgentMessage[], signal?: AbortSignal) => {
			expect(signal).toBe(abortController.signal);
			return [...messages, ...transformedMessages.slice(messages.length)];
		});
		const convertToLlm = vi.fn(async (_messages: AgentMessage[]) => {
			return convertedMessages;
		});
		const abortController = new AbortController();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext,
			convertToLlm,
		});
		sessions.push(session);

		const result = await session.convertMessagesToLlm(inputMessages, abortController.signal);

		expect(transformContext).toHaveBeenCalledWith(inputMessages, abortController.signal);
		expect(convertToLlm).toHaveBeenCalledWith(transformedMessages);
		expect(result).toEqual(convertedMessages);
	});

	it("reports Context GC projected tokens in context usage", async () => {
		const previousAgentDir = getAgentDir();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-context-gc-usage-"));
		try {
			setAgentDir(tempDir);
			const largeText = "large read output\n".repeat(2_000);
			const secondText = "secondary read output\n".repeat(600);
			const toolResult: AgentMessage = {
				role: "toolResult",
				toolCallId: "call-a",
				toolName: "read",
				content: [{ type: "text", text: largeText }],
				isError: false,
				timestamp: Date.now(),
			};
			const secondToolResult: AgentMessage = {
				role: "toolResult",
				toolCallId: "call-b",
				toolName: "read",
				content: [{ type: "text", text: secondText }],
				isError: false,
				timestamp: Date.now(),
			};
			const model = {
				id: "test-model",
				name: "Test Model",
				api: "anthropic",
				provider: "anthropic",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 4_096,
			} satisfies Model;
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage(toolResult);
			sessionManager.appendMessage(secondToolResult);
			const dbPath = path.join(tempDir, "custom-context-gc.sqlite");
			const store = openContextGcStore({ dbPath });
			try {
				const payload = store.putPayload("text/plain;charset=utf-8", largeText);
				const secondPayload = store.putPayload("text/plain;charset=utf-8", secondText);
				const baseRecord = {
					sessionId: sessionManager.getSessionId(),
					sessionFile: sessionManager.getSessionFile() ?? null,
					status: "candidate" as const,
					kind: "tool_result" as const,
					sourceUri: null,
				};
				store.upsertRecord({
					...baseRecord,
					id: "record-a",
					source: { toolCallId: "call-a", toolName: "read" },
					payloadHash: payload.hash,
					artifactId: "artifact-a",
					summary: "large read output",
					tokenEstimate: Math.ceil(largeText.length / 4),
				});
				store.upsertRecord({
					...baseRecord,
					id: "record-b",
					source: { toolCallId: "call-b", toolName: "read" },
					payloadHash: secondPayload.hash,
					artifactId: "artifact-b",
					summary: "secondary read output",
					tokenEstimate: Math.ceil(secondText.length / 4),
				});
			} finally {
				store.close();
			}
			const delta: ContextGcDelta = {
				op: "unload",
				id: "record-a",
				sessionId: sessionManager.getSessionId(),
				summary: "read output no longer needed",
				createdAt: new Date().toISOString(),
			};
			sessionManager.appendCustomEntry(CONTEXT_GC_CUSTOM_TYPE, delta);
			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["system prompt"],
						messages: [toolResult, secondToolResult],
						tools: [],
					},
				}),
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				contextGcDbPath: dbPath,
				modelRegistry: {} as never,
			});
			sessions.push(session);

			const usage = session.getContextUsage();
			if (!usage?.tokens) throw new Error("Expected Context GC-adjusted usage");
			const assistant = createAssistantMessage("ack");
			assistant.usage.input = usage.tokens;
			session.agent.appendMessage(assistant);
			sessionManager.appendMessage(assistant);

			const afterAssistantUsage = session.getContextUsage();

			expect(afterAssistantUsage?.tokens).toBe(usage.tokens);
			expect(usage.tokens).toBeLessThan(Math.ceil((largeText.length + secondText.length) / 4));

			const secondDelta: ContextGcDelta = {
				op: "unload",
				id: "record-b",
				sessionId: sessionManager.getSessionId(),
				summary: "secondary output no longer needed",
				createdAt: new Date().toISOString(),
			};
			sessionManager.appendCustomEntry(CONTEXT_GC_CUSTOM_TYPE, secondDelta);

			const afterSecondUnload = session.getContextUsage();

			expect(afterSecondUnload?.tokens).toBeLessThan(usage.tokens);
			expect(afterSecondUnload?.tokens).toBeGreaterThan(50);
		} finally {
			setAgentDir(previousAgentDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("composes session payload hooks into direct side-request options", async () => {
		const sessionOnPayload = vi.fn(async (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			session: true,
		}));
		const requestOnPayload = vi.fn(async () => undefined);
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onPayload: sessionOnPayload,
		});
		sessions.push(session);
		const options: SimpleStreamOptions = {
			apiKey: "key",
			onPayload: requestOnPayload,
		};

		const prepared = session.prepareSimpleStreamOptions(options);
		const result = await prepared.onPayload?.({ original: true });

		expect(sessionOnPayload).toHaveBeenCalledWith({ original: true }, undefined);
		expect(requestOnPayload).toHaveBeenCalledWith({ original: true, session: true }, undefined);
		expect(result).toEqual({ original: true, session: true });
	});
	it("keeps ephemeral side-channel cache key separate from provider routing", async () => {
		const api = "test-ephemeral-side-channel";
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = {
			id: "side-model",
			name: "Side Model",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} satisfies Model;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				getApiKey: vi.fn(async () => "key"),
			} as never,
		});
		sessions.push(session);
		const cacheSessionId = session.sessionId;

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Answer");
		expect(capturedOptions?.promptCacheKey).toBe(cacheSessionId);
		expect(capturedOptions?.sessionId).toStartWith(`${cacheSessionId}:side:`);
		expect(capturedOptions?.sessionId).not.toBe(cacheSessionId);
		expect(capturedOptions?.preferWebsockets).toBe(false);
	});

	it("applies configured OpenRouter routing variant to ephemeral side-channel options", async () => {
		const api = "test-ephemeral-openrouter-variant";
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = {
			id: "anthropic/claude-sonnet-4",
			name: "OpenRouter Model",
			api,
			provider: "openrouter",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} satisfies Model;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"providers.openrouterVariant": "nitro",
			}),
			modelRegistry: {
				getApiKey: vi.fn(async () => "key"),
			} as never,
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Answer");
		expect(capturedOptions?.openrouterVariant).toBe("nitro");
	});

	it("records raw SSE diagnostics into the session buffer before request hooks", async () => {
		const requestOnSseEvent = vi.fn();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onSseEvent: requestOnSseEvent,
		});
		sessions.push(session);

		const prepared = session.prepareSimpleStreamOptions({});
		prepared.onSseEvent?.({ event: "message", data: "{}", raw: ["event: message", "data: {}"] });

		expect(session.rawSseDebugBuffer.snapshot().totalEvents).toBe(1);
		expect(requestOnSseEvent).toHaveBeenCalledWith(
			{ event: "message", data: "{}", raw: ["event: message", "data: {}"] },
			undefined,
		);
	});

	it("emits message_update to session listeners before slow extension handlers finish", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const extensionEmit = vi.fn(async (event: { type: string }) => {
			if (event.type === "message_update") {
				await promise;
			}
		});
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			extensionRunner: {
				emit: extensionEmit,
			} as never,
		});
		sessions.push(session);

		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});

		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "edit",
					arguments: {},
					partialJson: '{"file":"preview.txt","steps":[{"kbd":["ggdGi"],"insert":"rep',
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as const;

		session.agent.emitExternalEvent({
			type: "message_update",
			message: assistantMessage as never,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "rep",
			},
		} as never);

		await Bun.sleep(0);

		expect(events.some(event => event.type === "message_update")).toBe(true);
		expect(extensionEmit).toHaveBeenCalledTimes(1);

		resolve();
		await Bun.sleep(0);
	});
});
