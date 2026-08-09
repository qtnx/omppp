import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost, isSafeguardRefusal } from "../../src/advisor";

function model(id: string, provider = "test-provider"): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: `https://${provider}.example.com`,
		input: ["text"],
		reasoning: false,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	});
}

function userMessage(content: string, timestamp: number): AgentMessage {
	return { role: "user", content, timestamp } as AgentMessage;
}

function makeHost(messages: AgentMessage[], failures: unknown[] = []): AdvisorRuntimeHost {
	return {
		snapshotMessages: () => messages,
		enqueueAdvice: () => {},
		notifyFailure: error => failures.push(error),
	};
}

interface FakeAdvisorAgent extends AdvisorAgent {
	readonly model: Model;
	setModel(model: Model): void;
}

function makeAgent(options: {
	primary: Model;
	onPrompt: (
		input: string,
		currentModel: Model,
		state: { messages: AgentMessage[]; error?: string },
	) => Promise<void> | void;
}): FakeAdvisorAgent {
	let currentModel = options.primary;
	const state: { messages: AgentMessage[]; error?: string } = { messages: [] };
	return {
		prompt: input => Promise.resolve(options.onPrompt(input, currentModel, state)),
		abort: () => {},
		reset: () => {
			state.messages.length = 0;
			state.error = undefined;
		},
		get model() {
			return currentModel;
		},
		setModel: nextModel => {
			currentModel = nextModel;
		},
		rollbackTo: count => {
			if (count < state.messages.length) state.messages.length = count;
			state.error = undefined;
		},
		state,
	};
}

async function flushMicrotasks(rounds = 4): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

async function advanceRetryTimer(): Promise<void> {
	vi.advanceTimersByTime(1);
	await flushMicrotasks();
}

describe("AdvisorRuntime refusal fallback", () => {
	const primary = model("claude-fable-primary", "anthropic");
	const fallback = model("gpt-5.5-2026-04-23", "aimlapi");

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("recognizes safeguard refusals and wrapped causes", () => {
		expect(isSafeguardRefusal(new Error("Refusal (reasoning_extraction): blocked"))).toBe(true);
		expect(isSafeguardRefusal(new Error("Refusal (no details provided)"))).toBe(true);
		expect(isSafeguardRefusal(new Error("Content flagged by safety filters"))).toBe(true);
		expect(isSafeguardRefusal(new Error("ordinary provider failure"))).toBe(false);
		expect(
			isSafeguardRefusal(new Error("outer", { cause: new Error("Refusal (reasoning_extraction): blocked") })),
		).toBe(true);
	});

	it("falls back on primary refusal, processes the same delta, and does not notify failure", async () => {
		const messages = [userMessage("alpha", 1)];
		const failures: unknown[] = [];
		const promptedModels: string[] = [];
		let calls = 0;
		const agent = makeAgent({
			primary,
			onPrompt: (_input, currentModel) => {
				promptedModels.push(currentModel.id);
				calls++;
				if (calls === 1) throw new Error("Refusal (reasoning_extraction): blocked");
			},
		});
		const setModelSpy = spyOn(agent, "setModel");
		const runtime = new AdvisorRuntime(agent, makeHost(messages, failures), 0, { fallbackModel: fallback });

		runtime.onTurnEnd(messages);
		await flushMicrotasks();

		expect(promptedModels).toEqual([primary.id, fallback.id]);
		expect(setModelSpy).toHaveBeenCalledWith(fallback);
		expect(runtime.backlog).toBe(0);
		expect(failures).toHaveLength(0);
	});

	it("retries only the refused batch on fallback when newer work is queued", async () => {
		const messages = [userMessage("alpha", 1)];
		const promptedModels: string[] = [];
		const firstPrompt = Promise.withResolvers<void>();
		let calls = 0;
		const agent = makeAgent({
			primary,
			onPrompt: (_input, currentModel) => {
				promptedModels.push(currentModel.id);
				calls++;
				if (calls === 1) {
					return firstPrompt.promise.then(() => {
						throw new Error("Refusal (reasoning_extraction): blocked");
					});
				}
			},
		});
		const setModelSpy = spyOn(agent, "setModel");
		const runtime = new AdvisorRuntime(agent, makeHost(messages), 0, { fallbackModel: fallback });

		runtime.onTurnEnd(messages);
		await flushMicrotasks();
		messages.push(userMessage("beta", 2));
		runtime.onTurnEnd(messages);
		firstPrompt.resolve();
		await flushMicrotasks();

		expect(promptedModels).toEqual([primary.id, fallback.id, primary.id]);
		expect(setModelSpy.mock.calls.map(call => call[0].id)).toEqual([fallback.id, primary.id]);
	});

	it("restores the primary immediately after a fallback batch drains", async () => {
		const messages = [userMessage("alpha", 1)];
		const promptedModels: string[] = [];
		let calls = 0;
		const agent = makeAgent({
			primary,
			onPrompt: (_input, currentModel) => {
				promptedModels.push(currentModel.id);
				calls++;
				if (calls === 1) throw new Error("Refusal (reasoning_extraction): blocked");
			},
		});
		const setModelSpy = spyOn(agent, "setModel");
		const runtime = new AdvisorRuntime(agent, makeHost(messages), 0, { fallbackModel: fallback });

		runtime.onTurnEnd(messages);
		await flushMicrotasks();

		expect(promptedModels).toEqual([primary.id, fallback.id]);
		expect(setModelSpy.mock.calls.map(call => call[0].id)).toEqual([fallback.id, primary.id]);
		expect(agent.model).toBe(primary);
	});

	it("reset after fallback success keeps the eagerly restored construction-time primary for the next batch", async () => {
		const messages = [userMessage("alpha", 1)];
		const promptedModels: string[] = [];
		let calls = 0;
		const agent = makeAgent({
			primary,
			onPrompt: (_input, currentModel) => {
				promptedModels.push(currentModel.id);
				calls++;
				if (calls === 1) throw new Error("Refusal (reasoning_extraction): blocked");
			},
		});
		const setModelSpy = spyOn(agent, "setModel");
		const runtime = new AdvisorRuntime(agent, makeHost(messages), 0, { fallbackModel: fallback });

		runtime.onTurnEnd(messages);
		await flushMicrotasks();
		expect(promptedModels).toEqual([primary.id, fallback.id]);
		expect(setModelSpy.mock.calls.map(call => call[0].id)).toEqual([fallback.id, primary.id]);
		expect(agent.model).toBe(primary);

		runtime.reset();
		messages.push(userMessage("beta", 2));
		runtime.onTurnEnd(messages);
		await flushMicrotasks();

		expect(promptedModels).toEqual([primary.id, fallback.id, primary.id]);
		expect(setModelSpy.mock.calls.map(call => call[0].id)).toEqual([fallback.id, primary.id]);
	});

	it("keeps the primary model when the primary succeeds", async () => {
		const messages = [userMessage("alpha", 1)];
		const promptedModels: string[] = [];
		const agent = makeAgent({
			primary,
			onPrompt: (_input, currentModel) => {
				promptedModels.push(currentModel.id);
			},
		});
		const setModelSpy = spyOn(agent, "setModel");
		const runtime = new AdvisorRuntime(agent, makeHost(messages), 0, { fallbackModel: fallback });

		runtime.onTurnEnd(messages);
		await flushMicrotasks();

		expect(promptedModels).toEqual([primary.id]);
		expect(setModelSpy).not.toHaveBeenCalled();
	});

	it("uses the existing failure path after one fallback attempt when both primary and fallback refuse", async () => {
		const messages = [userMessage("alpha", 1)];
		const failures: unknown[] = [];
		const promptedModels: string[] = [];
		const agent = makeAgent({
			primary,
			onPrompt: (_input, currentModel) => {
				promptedModels.push(currentModel.id);
				throw new Error("Refusal (reasoning_extraction): blocked");
			},
		});
		const setModelSpy = spyOn(agent, "setModel");
		const runtime = new AdvisorRuntime(agent, makeHost(messages, failures), 0, { fallbackModel: fallback });

		vi.useFakeTimers();
		runtime.onTurnEnd(messages);
		await flushMicrotasks();
		await advanceRetryTimer();
		await advanceRetryTimer();

		expect(promptedModels).toEqual([primary.id, fallback.id, primary.id, primary.id]);
		expect(setModelSpy.mock.calls.map(call => call[0].id)).toEqual([fallback.id, primary.id]);
		expect(failures).toHaveLength(1);
		expect(runtime.backlog).toBe(0);
	});

	it("does not swap models for non-refusal errors", async () => {
		const messages = [userMessage("alpha", 1)];
		const failures: unknown[] = [];
		const promptedModels: string[] = [];
		const agent = makeAgent({
			primary,
			onPrompt: (_input, currentModel) => {
				promptedModels.push(currentModel.id);
				throw new Error("ordinary provider failure");
			},
		});
		const setModelSpy = spyOn(agent, "setModel");
		const runtime = new AdvisorRuntime(agent, makeHost(messages, failures), 0, { fallbackModel: fallback });

		vi.useFakeTimers();
		runtime.onTurnEnd(messages);
		await flushMicrotasks();
		await advanceRetryTimer();
		await advanceRetryTimer();

		expect(promptedModels).toEqual([primary.id, primary.id, primary.id]);
		expect(setModelSpy).not.toHaveBeenCalled();
		expect(failures).toHaveLength(1);
	});
});
