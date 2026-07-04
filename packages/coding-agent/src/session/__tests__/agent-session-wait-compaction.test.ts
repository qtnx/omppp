import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Agent, AgentMessage, AgentTurnEndContext, SessionEntry } from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { AgentSession, type AgentSessionConfig, type AgentSessionEvent } from "../agent-session";
import type { SessionManager } from "../session-manager";

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

const enabledCompactionSettings: compaction.CompactionSettings = {
	enabled: true,
	strategy: "context-full",
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

function createNoopProxy<T extends object>(overrides: Record<string, unknown>): T {
	return new Proxy(overrides, {
		get(target, prop) {
			if (typeof prop === "string" && prop in target) return target[prop];
			return () => undefined;
		},
		set(target, prop, value) {
			if (typeof prop === "string") target[prop] = value;
			return true;
		},
	}) as T;
}

function createSettings(compactionSettings: compaction.CompactionSettings): Settings {
	return createNoopProxy<Settings>({
		get(key: string) {
			if (key === "advisor.enabled") return false;
			if (key === "contextPromotion.enabled") return false;
			return undefined;
		},
		getGroup(key: string) {
			if (key === "compaction") return compactionSettings;
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

function createAgentSessionHarness(compactionSettings: compaction.CompactionSettings): AgentSessionHarness {
	const events: AgentSessionEvent[] = [];
	const appendedCompactions: compaction.CompactionResult[] = [];
	let replacedMessages: AgentMessage[] | undefined;
	let turnEnd: TurnEndCallback | undefined;
	let entryCounter = 0;
	const branchEntries: SessionEntry[] = [];
	const agentState = {
		messages: [{ role: "user", content: "hello".repeat(100), timestamp: Date.now() } as AgentMessage],
		systemPrompt: [],
		model,
		tools: [],
	};
	const hookCompaction: compaction.CompactionResult = {
		summary: "hook compacted summary",
		shortSummary: "hook compacted short summary",
		firstKeptEntryId: "first-kept",
		tokensBefore: 100_000,
	};
	const extensionRunner = createNoopProxy<NonNullable<AgentSessionConfig["extensionRunner"]>>({
		hasHandlers: (eventType: string) => eventType === "session_before_compact",
		emit: (event: { type: string }) => {
			if (event.type === "session_before_compact") return { compaction: hookCompaction };
			return undefined;
		},
	});
	const agent = createNoopProxy({
		state: agentState,
		subscribe: () => () => undefined,
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
			getAvailable: () => [model],
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
		expect(startEvent).toEqual({ type: "auto_compaction_start", reason: "requested", action: "context-full" });
		expect(harness.appendedCompactions).toHaveLength(1);
		expect(harness.replacedMessages).toBeDefined();
		expect(harness.session.considerCompactionWhileWaiting("after boundary").status).toBe("not-needed");
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
