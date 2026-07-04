import { afterEach, describe, expect, test } from "bun:test";
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { AgentSession } from "../agent-session";
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

const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) {
		await session.dispose();
	}
});

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

function createSettings(): Settings {
	return createNoopProxy<Settings>({
		get(key: string) {
			if (key === "steering.holdDuringSubagentWaits") return true;
			if (key === "advisor.enabled") return false;
			if (key === "contextPromotion.enabled") return false;
			return undefined;
		},
		getGroup() {
			return {};
		},
	});
}

function createSessionHarness(): { session: AgentSession; steeringQueue: AgentMessage[] } {
	const steeringQueue: AgentMessage[] = [];
	const followUpQueue: AgentMessage[] = [];
	const agentState = {
		messages: [] as AgentMessage[],
		systemPrompt: [],
		model,
		tools: [],
	};
	const agent = createNoopProxy({
		state: agentState,
		subscribe: () => () => undefined,
		setOnTurnEnd: () => {},
		peekSteeringQueue: () => steeringQueue,
		peekFollowUpQueue: () => followUpQueue,
		replaceQueues: (steering: AgentMessage[], followUp: AgentMessage[]) => {
			steeringQueue.length = 0;
			steeringQueue.push(...steering);
			followUpQueue.length = 0;
			followUpQueue.push(...followUp);
		},
		steer: (message: AgentMessage) => {
			steeringQueue.push(message);
		},
		hasQueuedMessages: () => steeringQueue.length > 0 || followUpQueue.length > 0,
		metadataForProvider: () => ({}),
	}) as unknown as Agent;
	const sessionManager = createNoopProxy({
		getCwd: () => "/tmp",
		getSessionFile: () => undefined,
		getSessionId: () => "session-oversight",
		getArtifactsDir: () => undefined,
		getBranch: () => [],
		getEntries: () => [],
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
		settings: createSettings(),
		modelRegistry: createNoopProxy<ModelRegistry>({ getAvailable: () => [model] }),
		persistInitialMCPToolSelection: false,
	});
	sessions.push(session);
	return { session, steeringQueue };
}

describe("AgentSession oversight contracts", () => {
	test("holds steering during a subagent wait and flushes one wrapped steer after exit", async () => {
		const { session, steeringQueue } = createSessionHarness();

		session.enterSubagentWait();
		await session.steer("change scope after the current subagents finish");

		expect(steeringQueue).toHaveLength(0);
		expect(session.queuedMessageCount).toBe(1);
		expect(session.getQueuedMessages().steering).toEqual(["change scope after the current subagents finish"]);

		session.exitSubagentWait();

		expect(steeringQueue).toHaveLength(1);
		const message = steeringQueue[0];
		expect("content" in message).toBe(true);
		if (!("content" in message)) throw new Error("Expected queued steering message to include content");
		const content = message.content;
		expect(typeof content).toBe("string");
		if (typeof content === "string") {
			expect(content).toContain("User steering received while you were blocked waiting on subagents");
			expect(content).toContain("change scope after the current subagents finish");
			expect(content).toContain("Subagent results in this wait batch are authoritative");
		}
	});
});
