import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	type Agent,
	type AgentMessage,
	type AgentTurnEndContext,
	type SessionEntry,
	Tokenizer,
} from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { disableAnnotateHttp, enableAnnotateHttp } from "../../tools/browser/annotate-http";
import { AgentSession, type AgentSessionConfig, type AgentSessionEvent } from "../agent-session";
import type { AuthStorage } from "../auth-storage";
import type { SessionManager } from "../session-manager";
import { type CompactionMethod, DEFAULT_COMPACTION_METHOD_ORDER } from "../compaction-methods";

const model = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8192,
});

const visionModel = buildModel({
	...model,
	input: ["text", "image"],
});

// Fork settings group carries the ordered method list the session reads.
const enabledCompactionSettings: compaction.CompactionSettings & { methodOrder: CompactionMethod[] } = {
	enabled: true,
	strategy: "context-full",
	methodOrder: [...DEFAULT_COMPACTION_METHOD_ORDER],
	thresholdPercent: 80,
	thresholdTokens: 80_000,
	reserveTokens: 15_000,
	keepRecentTokens: 10_000,
	midTurnEnabled: true,
	autoContinue: false,
	remoteEnabled: false,
	remoteEndpoint: undefined,
};
const offCompactionSettings: compaction.CompactionSettings = {
	...enabledCompactionSettings,
	strategy: "off",
};

type MockHandle = { mockRestore(): void };
const handles: MockHandle[] = [];

afterEach(() => {
	for (const handle of handles.splice(0)) handle.mockRestore();
});

function track<T extends MockHandle>(handle: T): T {
	handles.push(handle);
	return handle;
}

/**
 * AuthStorage and friends expose namespaces (`usage.observe`, `keys.get`, …),
 * so an unknown member has to answer both a call and a nested lookup. `then`
 * stays undefined: an awaited member must not look thenable.
 */
function noopMember(): unknown {
	return new Proxy(() => undefined, {
		get: (_target, prop) => (prop === "then" ? undefined : noopMember()),
		apply: () => undefined,
	});
}

function createNoopProxy<T extends object>(overrides: Record<string, unknown>): T {
	return new Proxy(overrides, {
		get(target, prop) {
			if (typeof prop === "string" && prop in target) return target[prop];
			return noopMember();
		},
		set(target, prop, value) {
			if (typeof prop === "string") target[prop] = value;
			return true;
		},
	}) as T;
}

/**
 * Fork settings expose the ordered method list; these cases still describe the
 * pass they want through the legacy `strategy` field, so mirror it here.
 */
function methodOrderForStrategy(strategy: compaction.CompactionSettings["strategy"]): CompactionMethod[] {
	switch (strategy) {
		case "off":
			return [];
		case "snapcompact":
			return ["snapcompact", "soft"];
		case "handoff":
			return ["handoff", "soft"];
		case "shake":
			return ["shake", "soft"];
		default:
			return ["remote", "soft"];
	}
}

function createSettings(compactionSettings: compaction.CompactionSettings): Settings {
	return createNoopProxy<Settings>({
		get(key: string) {
			if (key === "advisor.enabled") return false;
			if (key === "contextPromotion.enabled") return false;
			return undefined;
		},
		getGroup(key: string) {
			if (key === "compaction") {
				return { ...compactionSettings, methodOrder: methodOrderForStrategy(compactionSettings.strategy) };
			}
			return {};
		},
	});
}

function createPreparedCompaction(settings: compaction.CompactionSettings): compaction.CompactionPreparation {
	return {
		firstKeptEntryId: "first-kept",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: compaction.createFileOps(),
		settings,
	};
}

type TurnEndCallback = (
	messages: AgentMessage[],
	signal?: AbortSignal,
	context?: AgentTurnEndContext,
) => Promise<void> | void;

interface AgentSessionHarness {
	session: AgentSession;
	runTurnEnd(messages: AgentMessage[], context: AgentTurnEndContext): Promise<void>;
	runPostTurn(message: AssistantMessage): Promise<void>;
	events: AgentSessionEvent[];
	appendedCompactions: compaction.CompactionResult[];
	replacedMessages: AgentMessage[] | undefined;
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc-job", name: "job", arguments: { poll: ["job-1"] } }],
		api: "openai-responses",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createAgentSessionHarness(
	compactionSettings: compaction.CompactionSettings,
	options: { model?: Model | null; models?: Model[]; useHook?: boolean } = {},
): AgentSessionHarness {
	const events: AgentSessionEvent[] = [];
	const appendedCompactions: compaction.CompactionResult[] = [];
	let replacedMessages: AgentMessage[] | undefined;
	let turnEnd: TurnEndCallback | undefined;
	const agentEventHandlers = new Set<
		(event: { type: string; message?: AssistantMessage; messages?: AgentMessage[] }) => Promise<void> | void
	>();
	let entryCounter = 0;
	const branchEntries: SessionEntry[] = [];
	const agentState = {
		messages: [{ role: "user", content: "hello".repeat(100), timestamp: Date.now() } as AgentMessage],
		systemPrompt: [],
		model: options.model === null ? undefined : (options.model ?? model),
		tools: [],
	};
	const hookCompaction: compaction.CompactionResult = {
		summary: "hook compacted summary",
		shortSummary: "hook compacted short summary",
		firstKeptEntryId: "first-kept",
		tokensBefore: 100_000,
	};
	const extensionRunner = createNoopProxy<NonNullable<AgentSessionConfig["extensionRunner"]>>({
		hasHandlers: (eventType: string) => options.useHook !== false && eventType === "session_before_compact",
		emit: (event: { type: string }) => {
			if (event.type === "session_before_compact") return { compaction: hookCompaction };
			return undefined;
		},
	});
	const agent = createNoopProxy({
		state: agentState,
		tokenizer: new Tokenizer(),
		subscribe: (
			handler: (event: {
				type: string;
				message?: AssistantMessage;
				messages?: AgentMessage[];
			}) => Promise<void> | void,
		) => {
			agentEventHandlers.add(handler);
			return () => agentEventHandlers.delete(handler);
		},
		peekSteeringQueue: () => [],
		peekFollowUpQueue: () => [],
		setOnTurnEnd: (fn: TurnEndCallback | undefined) => {
			turnEnd = fn;
		},
		replaceMessages: (messages: AgentMessage[]) => {
			replacedMessages = messages;
			agentState.messages = messages;
		},
		hasQueuedMessages: () => false,
		metadataForProvider: () => ({}),
	}) as unknown as Agent;
	const sessionManager = createNoopProxy({
		getBranch: () => branchEntries,
		getEntries: () => branchEntries,
		getSessionFile: () => undefined,
		getCredentialPins: () => [],
		appendMessage: (message: AgentMessage) => {
			branchEntries.push({
				type: "message",
				id: `message-${++entryCounter}`,
				parentId: null,
				timestamp: new Date(message.timestamp ?? Date.now()).toISOString(),
				message,
			} as SessionEntry);
		},
		appendCompaction: (
			summary: string,
			shortSummary: string | undefined,
			firstKeptEntryId: string,
			tokensBefore: number,
			details: unknown,
			fromExtension: boolean,
			preserveData: Record<string, unknown> | undefined,
		) => {
			const result: compaction.CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			appendedCompactions.push(result);
			branchEntries.push({
				type: "compaction",
				id: `compaction-${++entryCounter}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
				fromExtension,
			} as SessionEntry);
		},
		buildSessionContext: () => ({
			messages: agentState.messages,
			systemPrompt: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
		}),
	}) as unknown as SessionManager;
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: createSettings(compactionSettings),
		modelRegistry: createNoopProxy<ModelRegistry>({
			authStorage: createNoopProxy<AuthStorage>({}),
			getAvailable: () => options.models ?? (options.model ? [options.model] : [model]),
			getApiKey: async () => "test-api-key",
		}),
		extensionRunner,
		persistInitialMCPToolSelection: false,
	});
	session.subscribe(event => events.push(event));
	return {
		session,
		events,
		appendedCompactions,
		get replacedMessages() {
			return replacedMessages;
		},
		async runTurnEnd(messages: AgentMessage[], context: AgentTurnEndContext): Promise<void> {
			if (!turnEnd) throw new Error("AgentSession did not register an onTurnEnd callback");
			await turnEnd(messages, undefined, context);
		},
		async runPostTurn(message: AssistantMessage): Promise<void> {
			agentState.messages = [
				{ role: "user", content: "poll the running job", timestamp: message.timestamp - 1 } as AgentMessage,
				message,
			];
			for (const handler of agentEventHandlers) {
				await handler({ type: "message_end", message });
			}
			for (const handler of agentEventHandlers) {
				await handler({ type: "agent_end", messages: agentState.messages });
			}
		},
	};
}

describe("AgentSession.considerCompactionWhileWaiting", () => {
	test("returns already-scheduled after a waiting compaction has been scheduled", () => {
		const session = createAgentSessionHarness(enabledCompactionSettings).session;
		track(
			spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction(enabledCompactionSettings)),
		);
		track(spyOn(compaction, "shouldCompact").mockReturnValue(true));

		expect(session.considerCompactionWhileWaiting("first").status).toBe("scheduled");
		expect(session.considerCompactionWhileWaiting("second").status).toBe("already-scheduled");
	});

	test("returns unavailable when compaction strategy is off", () => {
		const session = createAgentSessionHarness(offCompactionSettings).session;

		const result = session.considerCompactionWhileWaiting("blocked wait");

		expect(result.status).toBe("unavailable");
		if (result.status === "unavailable") {
			expect(result.detail).toContain("strategy is set to off");
		}
	});
});

describe("AgentSession mid-run waiting compaction", () => {
	test("runs requested compaction at the mid-run boundary below the usage threshold and clears the request", async () => {
		const harness = createAgentSessionHarness(enabledCompactionSettings);
		track(
			spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction(enabledCompactionSettings)),
		);
		track(spyOn(compaction, "shouldCompact").mockReturnValueOnce(true).mockReturnValue(false));
		expect(harness.session.considerCompactionWhileWaiting("blocked wait").status).toBe("scheduled");
		const assistant = createAssistantMessage();
		const messages: AgentMessage[] = [
			{ role: "user", content: "poll the running job", timestamp: assistant.timestamp - 1 } as AgentMessage,
			assistant,
		];

		await harness.runTurnEnd(messages, { message: assistant, toolResults: [], willContinue: true });

		const startEvent = harness.events.find(event => event.type === "auto_compaction_start");
		expect(startEvent).toEqual({ type: "auto_compaction_start", reason: "requested", action: "remote" });
		expect(harness.appendedCompactions).toHaveLength(1);
		expect(harness.replacedMessages).toBeDefined();
		expect(harness.session.considerCompactionWhileWaiting("after boundary").status).toBe("not-needed");
	});

	test("uses remote summary compaction with built-in and caller wait focus under snapcompact", async () => {
		const settings = { ...enabledCompactionSettings, strategy: "snapcompact" as const };
		const harness = createAgentSessionHarness(settings, { model: visionModel, useHook: false });
		track(spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction(settings)));
		track(spyOn(compaction, "shouldCompact").mockReturnValueOnce(true).mockReturnValue(false));
		const summarySpy = track(
			spyOn(compaction, "compact").mockImplementation(async preparation => ({
				summary: "summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			})),
		);
		const snapcompactSpy = track(
			spyOn(snapcompact, "compact").mockImplementation(async () => {
				throw new Error("snapcompact should not run");
			}),
		);

		expect(
			harness.session.considerCompactionWhileWaiting("blocked wait", { focus: "keep subagent ids" }).status,
		).toBe("scheduled");
		const assistant = createAssistantMessage();
		await harness.runTurnEnd(
			[
				{ role: "user", content: "poll the running job", timestamp: assistant.timestamp - 1 } as AgentMessage,
				assistant,
			],
			{ message: assistant, toolResults: [], willContinue: true },
		);

		expect(harness.events).toContainEqual({
			type: "auto_compaction_start",
			reason: "requested",
			action: "context-full",
		});
		expect(snapcompactSpy).not.toHaveBeenCalled();
		expect(summarySpy).toHaveBeenCalled();
		const customInstructions = summarySpy.mock.calls[0]?.[3];
		expect(customInstructions).toContain("active plan and todo phases");
		expect(customInstructions).toContain("keep subagent ids");
	});

	test("merges caller wait focus into an already-scheduled compaction request", async () => {
		const settings = { ...enabledCompactionSettings, strategy: "snapcompact" as const };
		const harness = createAgentSessionHarness(settings, { model: visionModel, useHook: false });
		track(spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction(settings)));
		track(spyOn(compaction, "shouldCompact").mockReturnValueOnce(true).mockReturnValue(false));
		const summarySpy = track(
			spyOn(compaction, "compact").mockImplementation(async preparation => ({
				summary: "summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			})),
		);
		const snapcompactSpy = track(
			spyOn(snapcompact, "compact").mockImplementation(async () => {
				throw new Error("snapcompact should not run");
			}),
		);

		expect(harness.session.considerCompactionWhileWaiting("first wait").status).toBe("scheduled");
		expect(harness.session.considerCompactionWhileWaiting("second wait", { focus: "watch P3" }).status).toBe(
			"already-scheduled",
		);
		const assistant = createAssistantMessage();
		await harness.runTurnEnd(
			[
				{ role: "user", content: "poll the running job", timestamp: assistant.timestamp - 1 } as AgentMessage,
				assistant,
			],
			{ message: assistant, toolResults: [], willContinue: true },
		);

		expect(snapcompactSpy).not.toHaveBeenCalled();
		expect(summarySpy).toHaveBeenCalled();
		const customInstructions = summarySpy.mock.calls[0]?.[3];
		expect(customInstructions).toContain("active plan and todo phases");
		expect(customInstructions).toContain("watch P3");
	});

	test("keeps remote mode and focus when a requested compaction is consumed post-turn", async () => {
		const settings = { ...enabledCompactionSettings, strategy: "snapcompact" as const };
		const harness = createAgentSessionHarness(settings, { model: visionModel, useHook: false });
		track(spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction(settings)));
		const summarySpy = track(
			spyOn(compaction, "compact").mockImplementation(async preparation => ({
				summary: "summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			})),
		);

		expect(harness.session.requestCompactionFromAgent("phase boundary", { focus: "keep P3" }).status).toBe(
			"scheduled",
		);
		await harness.runPostTurn(createAssistantMessage());

		expect(harness.events).toContainEqual({
			type: "auto_compaction_start",
			reason: "requested",
			action: "context-full",
		});
		expect(summarySpy.mock.calls[0]?.[3]).toContain("keep P3");
	});

	test("keeps threshold-triggered snapcompact unchanged without an agent request", async () => {
		const settings = { ...enabledCompactionSettings, strategy: "snapcompact" as const };
		const harness = createAgentSessionHarness(settings, { model: visionModel, useHook: false });
		track(spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction(settings)));
		track(spyOn(compaction, "shouldCompact").mockReturnValue(true));
		const snapcompactSpy = track(spyOn(snapcompact, "compact"));
		const assistant = createAssistantMessage();

		await harness.runTurnEnd(
			[
				{ role: "user", content: "poll the running job", timestamp: assistant.timestamp - 1 } as AgentMessage,
				assistant,
			],
			{ message: assistant, toolResults: [], willContinue: true },
		);

		expect(harness.events).toContainEqual({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "snapcompact",
		});
		expect(snapcompactSpy).toHaveBeenCalled();
	});

	test("does not compact mid-run below threshold without a pending waiting request", async () => {
		const harness = createAgentSessionHarness(enabledCompactionSettings);
		track(spyOn(compaction, "shouldCompact").mockReturnValue(false));
		const assistant = createAssistantMessage();
		const messages: AgentMessage[] = [
			{ role: "user", content: "poll the running job", timestamp: assistant.timestamp - 1 } as AgentMessage,
			assistant,
		];

		await harness.runTurnEnd(messages, { message: assistant, toolResults: [], willContinue: true });

		expect(harness.events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(harness.appendedCompactions).toHaveLength(0);
		expect(harness.replacedMessages).toBeUndefined();
	});
});

describe("AgentSession annotation intake cleanup", () => {
	test("dispose stops annotation intake server after enabling HTTP annotations", async () => {
		let stoppedWith: boolean | undefined;
		track(
			spyOn(Bun, "serve").mockImplementation(((options: { hostname?: string; port?: number }) => {
				return {
					hostname: options.hostname ?? "127.0.0.1",
					port: options.port ?? 0,
					stop: async (closeActiveConnections?: boolean) => {
						stoppedWith = closeActiveConnections;
					},
				} as unknown as Bun.Server<undefined>;
			}) as typeof Bun.serve),
		);
		const { session } = createAgentSessionHarness(enabledCompactionSettings);
		let registered = false;

		try {
			await enableAnnotateHttp({
				key: session,
				sessionLabel: "Dispose cleanup",
				host: "127.0.0.1",
				port: 38_481,
				deliver: () => {},
			});
			registered = true;

			await session.dispose();

			expect(stoppedWith).toBe(true);
		} finally {
			if (registered) {
				await disableAnnotateHttp(session);
			}
		}
	});
});
