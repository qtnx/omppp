import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import {
	type Api,
	type AssistantMessage,
	type Context,
	clearCustomApis,
	type ImageContent,
	type Message,
	type Model,
	type ModelSpec,
	registerCustomApi,
	type SimpleStreamOptions,
	type TextContent,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	convertToLlm,
	stripOversizedCompactionSummaryImagesForCodex,
	wrapSteeringForModel,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { CONTEXT_GC_CUSTOM_TYPE, type ContextGcDelta } from "../../context-gc-plugin/src/schema";
import { openContextGcStore } from "../../context-gc-plugin/src/storage";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const originalCodexPrePromptCompactionBytes = Bun.env.PI_CODEX_PRE_PROMPT_COMPACTION_BYTES;

function createAgent(): Agent {
	return new Agent({
		initialState: {
			systemPrompt: ["system prompt"],
			messages: [],
			tools: [],
		},
	});
}

function getConvertedUserText(message: Message | undefined): string {
	if (message?.role !== "user") {
		throw new Error("Expected converted user message");
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	const text = message.content.find((content): content is TextContent => content.type === "text");
	if (!text) {
		throw new Error("Expected converted text content");
	}
	return text.text;
}

function containsStringValue(value: unknown, needle: string, seen = new Set<object>()): boolean {
	if (typeof value === "string") {
		return value.includes(needle);
	}
	if (!value || typeof value !== "object") {
		return false;
	}
	if (seen.has(value)) {
		return false;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		return value.some(item => containsStringValue(item, needle, seen));
	}
	return Object.values(value).some(item => containsStringValue(item, needle, seen));
}

describe("AgentSession message pipeline", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		if (originalCodexPrePromptCompactionBytes === undefined) {
			delete Bun.env.PI_CODEX_PRE_PROMPT_COMPACTION_BYTES;
		} else {
			Bun.env.PI_CODEX_PRE_PROMPT_COMPACTION_BYTES = originalCodexPrePromptCompactionBytes;
		}
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("injects a single workflow-tool notice for workflow requests", async () => {
		const api = "test-workflow-notice";
		let capturedAgentMessages: AgentMessage[] = [];
		registerCustomApi(api, () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = {
			id: "workflow-model",
			name: "Workflow Model",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
			compat: undefined,
		} satisfies Model;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
				convertToLlm: messages => {
					capturedAgentMessages = messages;
					return convertToLlm(messages);
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "workflow.enabled": true }),
			modelRegistry: {
				getApiKey: vi.fn(async () => "key"),
			} as never,
		});
		sessions.push(session);

		await session.prompt("workflow resolve this?");

		const workflowMessages = capturedAgentMessages.filter(
			(message): message is AgentMessage & { role: "custom"; customType: string; content: string } =>
				message.role === "custom" && message.customType.startsWith("workflow"),
		);
		expect(workflowMessages).toHaveLength(1);
		expect(workflowMessages[0]?.customType).toBe("workflow-notice");
		expect(workflowMessages[0]?.content).toContain("`workflow` tool");
		expect(workflowMessages[0]?.content).not.toContain("Python in the `eval` tool");
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

	it("trims oldest snapcompact frames first for oversized Codex provider contexts", () => {
		const oldFrame: ImageContent = {
			type: "image",
			data: "old-frame".repeat(160),
			mimeType: "image/png",
			detail: "original",
		};
		const recentFrame: ImageContent = {
			type: "image",
			data: "recent-frame".repeat(8),
			mimeType: "image/png",
			detail: "original",
		};
		const userImage: ImageContent = {
			type: "image",
			data: "user-image".repeat(8),
			mimeType: "image/png",
			detail: "high",
		};
		const messages = convertToLlm([
			{
				role: "compactionSummary",
				summary: "The old UI investigation was summarized in text.",
				tokensBefore: 10_000,
				images: [oldFrame, recentFrame],
				timestamp: 1,
			},
			{
				role: "user",
				content: [{ type: "text", text: "current screenshot" }, userImage],
				timestamp: 2,
			},
		]);
		const context: Context = {
			systemPrompt: ["system prompt"],
			messages,
			tools: [],
		};
		const originalBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
		const result = stripOversizedCompactionSummaryImagesForCodex(context, originalBytes - 300);

		expect(result.changed).toBe(true);
		expect(result.strippedFrames).toBe(1);
		expect(result.retainedFrames).toBe(1);
		const compactionContent = result.context.messages[0]?.content;
		if (!Array.isArray(compactionContent)) throw new Error("Expected compaction content blocks");
		const compactionImages = compactionContent.filter((part): part is ImageContent => part.type === "image");
		expect(compactionImages.map(image => image.data)).toEqual([recentFrame.data]);
		const userContent = result.context.messages[1]?.content;
		if (!Array.isArray(userContent)) throw new Error("Expected user content blocks");
		expect(userContent.some(part => part.type === "image" && part.data === userImage.data)).toBe(true);
	});

	it("does not re-measure the full Codex provider context once per stripped snapcompact frame", () => {
		const frames: ImageContent[] = Array.from({ length: 5 }, (_, index) => ({
			type: "image",
			data: `frame-${index}-`.repeat(2048),
			mimeType: "image/png",
			detail: "original",
		}));
		const messages = convertToLlm([
			{
				role: "compactionSummary",
				summary: "The old UI investigation was summarized in text.",
				tokensBefore: 10_000,
				images: frames,
				timestamp: 1,
			},
		]);
		const context: Context = {
			systemPrompt: ["system prompt"],
			messages,
			tools: [],
		};
		const originalBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
		const stringifySpy = vi.spyOn(JSON, "stringify");

		const result = stripOversizedCompactionSummaryImagesForCodex(context, Math.floor(originalBytes / 4));
		const stringifyCalls = stringifySpy.mock.calls.length;

		expect(result.changed).toBe(true);
		expect(result.strippedFrames).toBeGreaterThan(1);
		expect(stringifyCalls).toBeLessThanOrEqual(frames.length + 2);
	});

	it("does not stringify discarded Codex snapcompact frame data while sizing provider context", () => {
		const frameData = "discarded-frame-data".repeat(2048);
		const frames: ImageContent[] = [
			{
				type: "image",
				data: frameData,
				mimeType: "image/png",
				detail: "original",
			},
		];
		const messages = convertToLlm([
			{
				role: "compactionSummary",
				summary: "The old UI investigation was summarized in text.",
				tokensBefore: 10_000,
				images: frames,
				timestamp: 1,
			},
		]);
		const context: Context = {
			systemPrompt: ["system prompt"],
			messages,
			tools: [],
		};
		const stringifySpy = vi.spyOn(JSON, "stringify");

		const result = stripOversizedCompactionSummaryImagesForCodex(context, 256);

		expect(result.changed).toBe(true);
		expect(result.strippedFrames).toBe(1);
		expect(
			stringifySpy.mock.calls.some(([value]) => {
				return containsStringValue(value, frameData);
			}),
		).toBe(false);
	});

	it("runs pre-prompt compaction for oversized OpenAI Codex provider payloads", async () => {
		Bun.env.PI_CODEX_PRE_PROMPT_COMPACTION_BYTES = "1";
		const model = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 200_000,
		});
		const usage: AssistantMessage["usage"] = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const oldUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "old request" }],
			timestamp: Date.now() - 4,
		};
		const oldAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "old response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage,
			timestamp: Date.now() - 3,
		};
		const recentUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "recent request" }],
			timestamp: Date.now() - 2,
		};
		const recentAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "recent response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage,
			timestamp: Date.now() - 1,
		};
		const sessionManager = SessionManager.inMemory();
		for (const message of [oldUser, oldAssistant, recentUser, recentAssistant]) {
			sessionManager.appendMessage(message);
		}
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const events: AgentSessionEvent[] = [];
		const agent = new Agent({
			getApiKey: () => "key",
			initialState: {
				model,
				systemPrompt: ["system prompt"],
				messages: [oldUser, oldAssistant, recentUser, recentAssistant],
				tools: [],
			},
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("Answer");
					message.api = model.api;
					message.provider = model.provider;
					message.model = model.id;
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
			}),
			modelRegistry: {
				getAvailable: vi.fn(() => [model]),
				getApiKey: vi.fn(async () => "key"),
			} as never,
		});
		sessions.push(session);
		session.subscribe(event => events.push(event));

		await session.prompt("new request");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual(expect.objectContaining({ type: "auto_compaction_start", reason: "threshold" }));
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
				compat: undefined,
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

	it("marks queued user steers without changing the public queue text", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		await session.sendUserMessage("raw <steer> &", { deliverAs: "steer" });

		expect(session.getQueuedMessages().steering).toEqual(["raw <steer> &"]);
		const queued = session.agent.popLastSteer();
		if (queued?.role !== "user") {
			throw new Error("Expected queued user steer");
		}
		expect(queued.steering).toBe(true);
		expect(queued.content).toEqual([{ type: "text", text: "raw <steer> &" }]);
		session.clearQueue();
	});

	it("keeps stored steering text raw while pre-LLM conversion wraps it", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext: wrapSteeringForModel,
			convertToLlm,
		});
		sessions.push(session);
		const raw: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "steer with <xml> & ampersand" }],
			steering: true,
			timestamp: 1,
		};
		session.agent.appendMessage(raw);

		const converted = await session.convertMessagesToLlm(session.messages);

		expect(session.messages[0]).toBe(raw);
		expect(raw.content).toEqual([{ type: "text", text: "steer with <xml> & ampersand" }]);
		const convertedText = getConvertedUserText(converted[0]);
		expect(convertedText).toContain("<user_interjection>");
		expect(convertedText).toContain("<message>\nsteer with <xml> & ampersand\n</message>");
		expect(convertedText).not.toContain("&lt;xml&gt;");
		expect(convertedText).not.toContain("&amp;");
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

		const model = buildModel({
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
		} as ModelSpec<Api>) as Model<Api>;
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

		const model = buildModel({
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
		} as ModelSpec<Api>) as Model<Api>;
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

	it("obfuscates the system prompt and messages on ephemeral side-channel requests", async () => {
		const api = "test-ephemeral-secret-redaction";
		const secret = "EPHEMERAL_SECRET_TOKEN_12345";
		let capturedContext: Context | undefined;
		registerCustomApi(api, (_model, context, _options) => {
			capturedContext = context;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = buildModel({
			id: "side-model-secrets",
			name: "Side Model Secrets",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: [`system prompt with ${secret}`],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				getApiKey: vi.fn(async () => "key"),
			} as never,
			obfuscator: new SecretObfuscator([{ type: "plain", content: secret }]),
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: `question about ${secret}` });

		expect(result.replyText).toBe("Answer");
		expect(capturedContext).toBeDefined();
		expect(JSON.stringify(capturedContext)).not.toContain(secret);
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
