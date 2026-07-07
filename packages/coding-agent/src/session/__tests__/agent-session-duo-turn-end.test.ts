import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTurnEndContext, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, Effort, type Model, type TextContent, type Usage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { DuoController } from "../../duo/controller";
import { AgentSession } from "../agent-session";
import { AuthStorage } from "../auth-storage";
import { convertToLlm } from "../messages";
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

interface TurnEndHarnessOptions {
	streamFn?: StreamFn;
}

interface MockHandle {
	mockRestore(): void;
}

type AutoSignalPrototype = Omit<DuoController, "notifyAutoSignals"> & { notifyAutoSignals?: (report: unknown) => void };

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

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function emitTextResponse(stream: AssistantMessageEventStream, model: Model, text: string): void {
	const content: TextContent[] = [];
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	const block: TextContent = { type: "text", text };
	content.push(block);
	stream.push({ type: "text_start", contentIndex: 0, partial: message });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
	stream.push({ type: "done", reason: "stop", message });
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

async function createTurnEndHarness(options: TurnEndHarnessOptions = {}): Promise<TurnEndHarness> {
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
		streamFn: options.streamFn,
		convertToLlm,
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
	test("continues to notify turn end when automatic signals are available", async () => {
		const notifyTurnEnd = track(spyOn(DuoController.prototype, "notifyTurnEnd"));
		const harness = await createTurnEndHarness();
		const proto = DuoController.prototype as AutoSignalPrototype;

		expect(proto.notifyAutoSignals).toBeFunction();
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

	test("duo handoff at turn end starts the next model turn automatically", async () => {
		const providerCalls: Array<{ modelId: string; contextText: string }> = [];
		let session: AgentSession | undefined;
		let requestedHandoff = false;
		const streamFn: StreamFn = (model, context) => {
			const callNumber = providerCalls.length + 1;
			const messageText = context.messages
				.map(message => {
					const content = message.content as unknown;
					if (typeof content === "string") return content;
					if (!Array.isArray(content)) return "";
					return content
						.map(part => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
						.join("");
				})
				.join("\n");
			const contextText = [...(context.systemPrompt ?? []), messageText].join("\n");
			providerCalls.push({ modelId: model.id, contextText });
			const stream = new AssistantMessageEventStream();
			queueMicrotask(async () => {
				try {
					if (!requestedHandoff) {
						requestedHandoff = true;
						const result = await session?.duoHandoffToExecutor(
							"Planner resolved the blocker; continue execution.",
						);
						expect(result).toBe("ok");
					}
					emitTextResponse(stream, model, `turn ${callNumber}`);
				} catch (error) {
					stream.fail(error);
				}
			});
			return stream;
		};
		const harness = await createTurnEndHarness({ streamFn });
		session = harness.session;

		// Regression: duo_handoff runs before the planner turn has fully ended, so
		// the handback brief is a hidden next-turn message rather than a queued user prompt.
		await harness.session.setModelTemporary(planner);
		expect(harness.session.getDuoStatus()?.phase).toBe("planning");

		await harness.session.prompt("finish the plan");

		expect(providerCalls.map(call => call.modelId)).toEqual([planner.id, executor.id]);
		expect(providerCalls[1]?.contextText).toContain("Planner resolved the blocker; continue execution.");
	});
});
