import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { DuoController } from "../../duo/controller";
import { AgentSession } from "../agent-session";
import { AuthStorage } from "../auth-storage";
import { SessionManager } from "../session-manager";

type TurnEndCallback = (
	messages: AgentMessage[],
	signal?: AbortSignal,
	context?: AgentTurnEndContext,
) => Promise<void> | void;

interface TurnEndHarness {
	session: AgentSession;
	messages: AgentMessage[];
	context: AgentTurnEndContext;
	runTurnEnd(): Promise<void>;
}

interface MockHandle {
	mockRestore(): void;
}

type AutoSignalPrototype = DuoController & { notifyAutoSignals?: (report: unknown) => void };

const sessions: AgentSession[] = [];
const tempDirs: TempDir[] = [];
const handles: MockHandle[] = [];
const authStorages: AuthStorage[] = [];
const restoreCallbacks: Array<() => void> = [];

function track<T extends MockHandle>(handle: T): T {
	handles.push(handle);
	return handle;
}

afterEach(async () => {
	for (const restore of restoreCallbacks.splice(0)) restore();
	for (const handle of handles.splice(0)) handle.mockRestore();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const tempDir of tempDirs.splice(0)) await tempDir.remove();
});

function anthropicModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		},
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const planner = anthropicModel("claude-fable-5");
const executor = anthropicModel("claude-opus-4.8");

function createSettings(): Settings {
	return Settings.isolated({
		"advisor.enabled": false,
		"advisor.fallbackModel": "",
		"advisor.syncBacklog": "off",
		"compaction.enabled": false,
		"compaction.strategy": "off",
		"contextPromotion.enabled": false,
		"duo.plannerModel": "",
		"duo.executorModel": "",
		"duo.plannerThinking": "auto",
		"duo.executorThinking": "max",
		"duo.doneGate": "strict",
		"duo.takeover.enabled": true,
		"duo.takeover.cooldownTurns": 2,
		"duo.takeover.maxConsecutive": 2,
		"duo.manualSwitchIntent": "plan",
		"duo.takeover.signals.enabled": true,
		"duo.takeover.signals.sentiment": true,
		"duo.takeover.signals.failureThreshold": 3,
		"duo.takeover.signals.loopThreshold": 3,
	});
}

function createMessages(): AgentMessage[] {
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "completed a tool turn" }],
		timestamp: 2,
	} as AgentMessage;
	return [{ role: "user", content: "please run a tool", timestamp: 1 } as AgentMessage, assistant];
}

async function createTurnEndHarness(): Promise<TurnEndHarness> {
	const tempDir = TempDir.createSync("@pi-duo-turn-end-");
	tempDirs.push(tempDir);
	const messages = createMessages();
	let turnEnd: TurnEndCallback | undefined;
	const agent = new Agent({
		initialState: {
			model: executor,
			systemPrompt: ["Test"],
			tools: [],
			messages,
		},
	});
	const setOnTurnEnd = agent.setOnTurnEnd.bind(agent);
	agent.setOnTurnEnd = ((fn: TurnEndCallback | undefined) => {
		turnEnd = fn;
		setOnTurnEnd(fn);
	}) as Agent["setOnTurnEnd"];
	const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "session.jsonl"));
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorages.push(authStorage);
	authStorage.setRuntimeApiKey("anthropic", "test-api-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	track(spyOn(modelRegistry, "getAvailable").mockReturnValue([planner, executor]));
	track(spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(true));
	track(spyOn(modelRegistry, "refreshSelectedModelMetadata").mockImplementation(async (model: Model) => model));
	const settings = createSettings();
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		persistInitialMCPToolSelection: false,
		agentKind: "main",
		advisorTools: [],
	});
	sessions.push(session);
	await session.setDuoEnabled(true);
	expect(session.getDuoStatus()?.phase).toBe("executing");
	return {
		session,
		messages,
		context: { message: messages[1], toolResults: [], willContinue: true },
		async runTurnEnd(): Promise<void> {
			if (!turnEnd) throw new Error("AgentSession did not register an onTurnEnd callback");
			await turnEnd(messages, undefined, { message: messages[1], toolResults: [], willContinue: true });
		},
	};
}

function installThrowingAutoSignals(): void {
	const proto = DuoController.prototype as AutoSignalPrototype;
	const previous = proto.notifyAutoSignals;
	proto.notifyAutoSignals = () => {
		throw new Error("takeover signals exploded");
	};
	restoreCallbacks.push(() => {
		if (previous) proto.notifyAutoSignals = previous;
		else delete proto.notifyAutoSignals;
	});
}

describe("AgentSession duo turn-end maintenance", () => {
	test("continues to notify turn end when executing duo lacks notifyAutoSignals", async () => {
		const notifyTurnEnd = track(spyOn(DuoController.prototype, "notifyTurnEnd"));
		const harness = await createTurnEndHarness();
		const proto = DuoController.prototype as AutoSignalPrototype;

		expect(proto.notifyAutoSignals).toBeUndefined();
		await harness.runTurnEnd();

		expect(notifyTurnEnd).toHaveBeenCalledTimes(1);
	});

	test("contains takeover-signal failures so notifyTurnEnd still runs", async () => {
		installThrowingAutoSignals();
		const notifyTurnEnd = track(spyOn(DuoController.prototype, "notifyTurnEnd"));
		const harness = await createTurnEndHarness();

		await harness.runTurnEnd();

		expect(notifyTurnEnd).toHaveBeenCalledTimes(1);
	});
});
