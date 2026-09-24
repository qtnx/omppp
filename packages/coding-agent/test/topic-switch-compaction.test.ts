import { afterEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { TurnSignalService, TypeSafeClient } from "@oh-my-pi/pi-coding-agent/signals/index";

const HOUR_MS = 60 * 60 * 1000;

function userMessage(text: string, ageMs: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() - ageMs };
}

function signals(noul: number, onState?: (state: Record<string, unknown>) => void): TurnSignalService {
	const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { state: Record<string, unknown> };
		onState?.(body.state);
		return Response.json({
			model: "jev",
			answers: { topic_switch: { type: "noul", noul } },
			usage: { input_tokens: 1, output_tokens: 1 },
		});
	}) as typeof fetch;
	return new TurnSignalService(new TypeSafeClient({ apiKey: "k", fetch: fetchImpl }));
}

function createMaintenance(options: {
	turnSignals?: TurnSignalService;
	messages?: AgentMessage[];
	settings?: Record<string, unknown>;
}): SessionMaintenance {
	const messages = options.messages ?? [userMessage("fix the tokenizer", 3 * HOUR_MS)];
	const host = {
		agent: { tokenizer: new Tokenizer(undefined), state: { tools: [] } },
		sessionManager: {
			getSessionName: () => "refactor parser",
			getBranch: () => [],
		},
		settings: Settings.isolated({
			"compaction.enabled": true,
			"compaction.topicSwitchEnabled": true,
			"compaction.topicSwitchIdleSeconds": 1800,
			"compaction.topicSwitchMinContextTokens": 1,
			"compaction.topicSwitchThreshold": 0.7,
			...options.settings,
		}),
		isStreaming: () => false,
		isDisposed: () => false,
		messages: () => messages,
		nonMessageTokenSource: () => ({}),
		turnSignals: () => options.turnSignals,
	} as unknown as SessionMaintenanceHost;
	return new SessionMaintenance(host);
}

describe("idle topic-switch compaction", () => {
	test("compacts with the topic-switch reason and sends only a digest to jev", async () => {
		let state: Record<string, unknown> | undefined;
		const maintenance = createMaintenance({ turnSignals: signals(0.9, next => (state = next)) });
		const compact = vi.spyOn(maintenance, "runAutoCompaction").mockResolvedValue({
			historyRewritten: true,
		} as never);

		expect(await maintenance.runTopicSwitchCompactionIfNeeded("Set up the billing webhook")).toBe(true);
		expect(compact.mock.calls[0]?.[0]).toBe("topic-switch");
		expect(compact.mock.calls[0]?.[4]).toMatchObject({ phase: "pre_turn", suppressContinuation: true });
		expect(state?.new_request).toBe("Set up the billing webhook");
		expect(state?.prior_context).toBe("Title: refactor parser\n\nRecent requests:\n- fix the tokenizer");
	});

	test("leaves the context alone when the request stays on topic", async () => {
		const maintenance = createMaintenance({ turnSignals: signals(0.2) });
		const compact = vi.spyOn(maintenance, "runAutoCompaction");

		expect(await maintenance.runTopicSwitchCompactionIfNeeded("keep going on the parser")).toBe(false);
		expect(compact).not.toHaveBeenCalled();
	});

	test("does not classify a request that follows a short idle gap", async () => {
		let called = false;
		const maintenance = createMaintenance({
			turnSignals: signals(0.9, () => (called = true)),
			messages: [userMessage("fix the tokenizer", 60_000)],
		});
		const compact = vi.spyOn(maintenance, "runAutoCompaction");

		expect(await maintenance.runTopicSwitchCompactionIfNeeded("Set up the billing webhook")).toBe(false);
		expect(called).toBe(false);
		expect(compact).not.toHaveBeenCalled();
	});

	test("does not classify a context smaller than the floor", async () => {
		let called = false;
		const maintenance = createMaintenance({
			turnSignals: signals(0.9, () => (called = true)),
			settings: { "compaction.topicSwitchMinContextTokens": 1_000_000 },
		});
		const compact = vi.spyOn(maintenance, "runAutoCompaction");

		expect(await maintenance.runTopicSwitchCompactionIfNeeded("Set up the billing webhook")).toBe(false);
		expect(called).toBe(false);
		expect(compact).not.toHaveBeenCalled();
	});

	test("fails open when signals are unavailable or the feature is off", async () => {
		const withoutSignals = createMaintenance({});
		const compact = vi.spyOn(withoutSignals, "runAutoCompaction");
		expect(await withoutSignals.runTopicSwitchCompactionIfNeeded("Set up the billing webhook")).toBe(false);

		const disabled = createMaintenance({
			turnSignals: signals(0.9),
			settings: { "compaction.topicSwitchEnabled": false },
		});
		const disabledCompact = vi.spyOn(disabled, "runAutoCompaction");
		expect(await disabled.runTopicSwitchCompactionIfNeeded("Set up the billing webhook")).toBe(false);

		expect(compact).not.toHaveBeenCalled();
		expect(disabledCompact).not.toHaveBeenCalled();
	});
});

describe("topic-switch compaction on a new user prompt", () => {
	const cleanup: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const fn of cleanup.splice(0).reverse()) await fn();
		vi.restoreAllMocks();
	});

	test("checks an idle new request and compacts unrelated context before dispatch", async () => {
		const tempDir = TempDir.createSync("@pi-topic-switch-");
		cleanup.push(async () => {
			try {
				await tempDir.remove();
			} catch {}
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		cleanup.push(() => authStorage.close());
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
				"compaction.keepRecentTokens": 1,
				"compaction.topicSwitchEnabled": true,
				"compaction.topicSwitchIdleSeconds": 1800,
				"compaction.topicSwitchMinContextTokens": 1,
				"compaction.topicSwitchThreshold": 0.7,
				"signals.enabled": true,
				"signals.apiKey": "k",
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		cleanup.push(() => session.dispose());
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		const turnSignals = session.turnSignals;
		if (!turnSignals) throw new Error("Expected signals to be configured");
		const classify = vi.spyOn(turnSignals, "classifyTopicSwitch").mockResolvedValue({ topicSwitch: 0.95 });

		const previousTurn = Date.now() - 3 * HOUR_MS;
		const seedUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "refactor the tokenizer" }],
			timestamp: previousTurn,
		};
		const seedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "tokenizer refactored ".repeat(200) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: previousTurn + 1,
		};
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);
		session.agent.replaceMessages([seedUser, seedAssistant]);

		const order: string[] = [];
		const compact = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			order.push("compact");
			return {
				summary: "topic-switch compacted",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			order.push("dispatch");
		});

		await session.prompt("Set up the billing webhook");

		expect(classify.mock.calls[0]?.[1]).toBe("Set up the billing webhook");
		expect(classify.mock.calls[0]?.[0]).toContain("Recent requests:\n- refactor the tokenizer");
		expect(compact).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["compact", "dispatch"]);
		expect(
			events
				.filter(event => event.type === "auto_compaction_start")
				.map(event => (event as { reason: string }).reason),
		).toEqual(["topic-switch"]);
	});
});
