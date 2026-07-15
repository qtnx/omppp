import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type AgentDefinition,
	type AgentProgress,
	SUBAGENT_RUN_CUSTOM_TYPE,
	type SubagentLifecyclePayload,
	type SubagentRunTelemetry,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

interface SessionHarness {
	session: AgentSession;
	emit(event: AgentSessionEvent): void;
	finishIdle(): void;
	setPending(value: boolean): void;
	notices: string[];
	customEntries: Array<{ customType: string; data: unknown }>;
	disposedAtAppend: boolean[];
	attached: Promise<void>;
}

function assistantMessage(duration: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "working" }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		duration,
	};
}

function yieldEnd(id = "yield-1"): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: { ok: true } },
		},
		isError: false,
	} as AgentSessionEvent;
}

function createSessionHarness(lastAssistantMessage?: AssistantMessage): SessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const idle = Promise.withResolvers<void>();
	const attached = Promise.withResolvers<void>();
	const notices: string[] = [];
	const customEntries: Array<{ customType: string; data: unknown }> = [];
	const disposedAtAppend: boolean[] = [];
	let pending = false;
	let disposed = false;

	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		extensionRunner: undefined as never,
		sessionManager: {
			appendSessionInit: () => {},
			appendCustomEntry: (customType: string, data: unknown) => {
				disposedAtAppend.push(disposed);
				customEntries.push({ customType, data });
				return `entry-${customEntries.length}`;
			},
		} as never,
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: listener => {
			listeners.push(listener);
			attached.resolve();
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => true,
		waitForIdle: () => idle.promise,
		getLastAssistantMessage: () => lastAssistantMessage,
		hasPendingAgentWork: () => pending,
		sendUserMessage: async content => {
			notices.push(typeof content === "string" ? content : JSON.stringify(content));
		},
		abort: async () => {
			idle.resolve();
		},
		dispose: async () => {
			disposed = true;
		},
	};

	return {
		session: session as AgentSession,
		emit: event => {
			for (const listener of [...listeners]) listener(event);
		},
		finishIdle: () => idle.resolve(),
		setPending: value => {
			pending = value;
		},
		notices,
		customEntries,
		disposedAtAppend,
		attached: attached.promise,
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "runtime-telemetry",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

function mockSession(harness: SessionHarness): void {
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session: harness.session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} satisfies CreateAgentSessionResult);
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("subagent early-yield notice", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("waits until 80 percent and a safe event boundary, then sends once", async () => {
		vi.useFakeTimers();
		const harness = createSessionHarness();
		mockSession(harness);
		const run = runSubprocess({ ...baseOptions, maxRuntimeMs: 1_000 });
		await harness.attached;

		vi.advanceTimersByTime(799);
		harness.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		await flushMicrotasks();
		expect(harness.notices).toHaveLength(0);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(harness.notices).toHaveLength(0);
		harness.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		await flushMicrotasks();
		expect(harness.notices).toHaveLength(1);
		harness.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		await flushMicrotasks();
		expect(harness.notices).toHaveLength(1);

		harness.emit(yieldEnd());
		harness.finishIdle();
		await run;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("delays while agent work is pending and delivers at the next safe boundary", async () => {
		vi.useFakeTimers();
		const harness = createSessionHarness();
		harness.setPending(true);
		mockSession(harness);
		const run = runSubprocess({ ...baseOptions, id: "pending-notice", maxRuntimeMs: 1_000 });
		await harness.attached;
		vi.advanceTimersByTime(800);
		harness.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		await flushMicrotasks();
		expect(harness.notices).toHaveLength(0);

		harness.setPending(false);
		harness.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		await flushMicrotasks();
		expect(harness.notices).toHaveLength(1);

		harness.emit(yieldEnd());
		harness.finishIdle();
		await run;
	});

	it("suppresses the notice when yield or abort wins the boundary", async () => {
		vi.useFakeTimers();
		const yielded = createSessionHarness();
		mockSession(yielded);
		const yieldedRun = runSubprocess({ ...baseOptions, id: "yield-suppression", maxRuntimeMs: 1_000 });
		await yielded.attached;
		vi.advanceTimersByTime(800);
		yielded.emit(yieldEnd());
		yielded.finishIdle();
		await yieldedRun;
		expect(yielded.notices).toHaveLength(0);

		vi.restoreAllMocks();
		const aborted = createSessionHarness();
		mockSession(aborted);
		const controller = new AbortController();
		const abortedRun = runSubprocess({
			...baseOptions,
			id: "abort-suppression",
			maxRuntimeMs: 1_000,
			signal: controller.signal,
		});
		await aborted.attached;
		vi.advanceTimersByTime(800);
		controller.abort();
		aborted.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		const result = await abortedRun;
		expect(result.aborted).toBe(true);
		expect(aborted.notices).toHaveLength(0);
	});

	it("rechecks yield-pending state before the queued notice send", async () => {
		vi.useFakeTimers();
		const harness = createSessionHarness();
		mockSession(harness);
		const run = runSubprocess({ ...baseOptions, id: "queued-yield-suppression", maxRuntimeMs: 1_000 });
		await harness.attached;
		vi.advanceTimersByTime(800);

		harness.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		harness.emit({
			type: "tool_execution_start",
			toolCallId: "queued-yield",
			toolName: "yield",
			args: {},
		} as AgentSessionEvent);
		harness.emit(yieldEnd("queued-yield"));
		harness.finishIdle();
		const result = await run;

		expect(harness.notices).toHaveLength(0);
		expect(result.telemetry?.earlyYieldNoticeSent).toBe(false);
	});

	it("rechecks external abort state before the queued notice send", async () => {
		vi.useFakeTimers();
		const harness = createSessionHarness();
		mockSession(harness);
		const controller = new AbortController();
		const run = runSubprocess({
			...baseOptions,
			id: "queued-abort-suppression",
			maxRuntimeMs: 1_000,
			signal: controller.signal,
		});
		await harness.attached;
		vi.advanceTimersByTime(800);

		harness.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		controller.abort();
		const result = await run;

		expect(harness.notices).toHaveLength(0);
		expect(result.telemetry?.earlyYieldNoticeSent).toBe(false);
		expect(result.telemetry?.abortReason).toBe("signal");
	});
	it("keeps the hard timeout authoritative when no safe notice boundary occurs", async () => {
		vi.useFakeTimers();
		const harness = createSessionHarness();
		mockSession(harness);
		const run = runSubprocess({ ...baseOptions, id: "hard-timeout", maxRuntimeMs: 100 });
		await harness.attached;

		vi.advanceTimersByTime(100);
		const result = await run;

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toContain("runtime limit exceeded");
		expect(result.telemetry?.status).toBe("aborted");
		expect(result.telemetry?.abortReason).toBe("timeout");
		expect(harness.notices).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("subagent retry propagation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("marks provider rate limits with their advertised retry delay", async () => {
		const harness = createSessionHarness();
		mockSession(harness);
		const progress: AgentProgress[] = [];
		const run = runSubprocess({
			...baseOptions,
			id: "rate-limit-propagation",
			onProgress: update => progress.push({ ...update, recentTools: update.recentTools.slice() }),
		});
		await harness.attached;
		const providerError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"account rate limit"}} retry-after-ms=11180000';
		harness.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 11_180_000,
			errorMessage: providerError,
		});
		harness.emit({
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError: `Provider requested 11180000ms wait. Original error: ${providerError}`,
		});
		harness.emit(yieldEnd());
		harness.finishIdle();
		const result = await run;

		expect(progress.some(update => update.retryState?.rateLimited === true)).toBe(true);
		expect(result.retryFailure).toMatchObject({
			attempt: 1,
			rateLimited: true,
			retryAfterMs: 11_180_000,
		});
	});

	it("propagates a terminal provider rate limit without auto-retry lifecycle events", async () => {
		const providerError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=10800000';
		const harness = createSessionHarness({
			...assistantMessage(0),
			stopReason: "error",
			errorMessage: providerError,
		});
		mockSession(harness);
		const run = runSubprocess({ ...baseOptions, id: "terminal-rate-limit-propagation" });
		await harness.attached;
		harness.finishIdle();
		const result = await run;

		expect(result.retryFailure).toEqual({
			attempt: 1,
			rateLimited: true,
			retryAfterMs: 10_800_000,
			errorMessage: providerError,
		});
	});

	it("does not label generic retry exhaustion as a rate limit", async () => {
		const harness = createSessionHarness();
		mockSession(harness);
		const run = runSubprocess({ ...baseOptions, id: "generic-retry-propagation" });
		await harness.attached;
		harness.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 1,
			delayMs: 500,
			errorMessage: "503 service unavailable",
		});
		harness.emit({
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError: "503 service unavailable",
		});
		harness.emit(yieldEnd());
		harness.finishIdle();
		const result = await run;

		expect(result.retryFailure).toEqual({
			attempt: 1,
			errorMessage: "503 service unavailable",
			rateLimited: false,
		});
	});
});

describe("subagent run telemetry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("assigns a unique runId to each settlement for the same stable agent identity", async () => {
		const firstHarness = createSessionHarness();
		mockSession(firstHarness);
		const firstRun = runSubprocess({ ...baseOptions, id: "reused-agent-id" });
		await firstHarness.attached;
		firstHarness.emit(yieldEnd("yield-first"));
		firstHarness.finishIdle();
		const firstResult = await firstRun;

		vi.restoreAllMocks();
		const secondHarness = createSessionHarness();
		mockSession(secondHarness);
		const secondRun = runSubprocess({ ...baseOptions, id: "reused-agent-id" });
		await secondHarness.attached;
		secondHarness.emit(yieldEnd("yield-second"));
		secondHarness.finishIdle();
		const secondResult = await secondRun;

		expect(firstResult.telemetry?.agent).toBe("task");
		expect(secondResult.telemetry?.agent).toBe("task");
		expect(firstResult.telemetry?.runId).toEqual(expect.any(String));
		expect(secondResult.telemetry?.runId).toEqual(expect.any(String));
		expect(firstResult.telemetry?.runId).not.toBe(secondResult.telemetry?.runId);
	});

	it("persists and emits matching completed telemetry with cumulative model and tool timing", async () => {
		vi.useFakeTimers();
		const startedBefore = Date.now();
		const harness = createSessionHarness();
		mockSession(harness);
		const eventBus = new EventBus();
		const lifecycle: SubagentLifecyclePayload[] = [];
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => lifecycle.push(data as SubagentLifecyclePayload));
		const run = runSubprocess({
			...baseOptions,
			id: "completed-telemetry",
			eventBus,
			runPhase: "review",
			parentAgentId: "parent-agent",
			parentToolCallId: "parent-tool",
		});
		await harness.attached;

		vi.advanceTimersByTime(100);
		harness.emit({
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: {},
		} as AgentSessionEvent);
		vi.advanceTimersByTime(50);
		harness.emit({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: { content: [] },
			isError: false,
		} as AgentSessionEvent);
		harness.emit({ type: "message_end", message: assistantMessage(120) } as AgentSessionEvent);
		harness.emit({ type: "message_end", message: assistantMessage(80) } as AgentSessionEvent);
		harness.emit(yieldEnd());
		harness.finishIdle();
		const result = await run;

		expect(harness.customEntries).toHaveLength(1);
		expect(harness.customEntries[0]?.customType).toBe(SUBAGENT_RUN_CUSTOM_TYPE);
		const telemetry = harness.customEntries[0]?.data as SubagentRunTelemetry;
		expect(telemetry).toMatchObject({
			version: 1,
			agent: "task",
			phase: "review",
			parentAgentId: "parent-agent",
			parentToolCallId: "parent-tool",
			status: "completed",
			requests: 2,
			toolCalls: 2,
			earlyYieldNoticeSent: false,
			timings: { modelMs: 200, toolMs: 50 },
		});
		expect(telemetry.runId).toEqual(expect.any(String));
		expect(telemetry.runId).not.toBe("completed-telemetry");
		expect(telemetry.startedAt).toBeGreaterThanOrEqual(startedBefore);
		expect(telemetry.completedAt).toBeGreaterThanOrEqual(telemetry.startedAt);
		expect(telemetry.timings.totalMs).toBe(telemetry.completedAt - telemetry.startedAt);
		expect(result.telemetry).toEqual(telemetry);
		expect(lifecycle.at(-1)?.telemetry).toEqual(telemetry);
		expect(lifecycle[0]?.telemetry).toBeUndefined();
		expect(harness.disposedAtAppend).toEqual([false]);
	});

	it("persists and emits matching aborted telemetry with the exact abort discriminator", async () => {
		const harness = createSessionHarness();
		mockSession(harness);
		const eventBus = new EventBus();
		const lifecycle: SubagentLifecyclePayload[] = [];
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => lifecycle.push(data as SubagentLifecyclePayload));
		const controller = new AbortController();
		const run = runSubprocess({
			...baseOptions,
			id: "aborted-telemetry",
			eventBus,
			signal: controller.signal,
		});
		await harness.attached;
		controller.abort(new Error("cancel test"));
		const result = await run;

		expect(harness.customEntries).toHaveLength(1);
		const telemetry = harness.customEntries[0]?.data as SubagentRunTelemetry;
		expect(telemetry).toMatchObject({
			version: 1,
			status: "aborted",
			abortReason: "signal",
		});
		expect(telemetry.runId).toEqual(expect.any(String));
		expect(telemetry.runId).not.toBe("aborted-telemetry");
		expect(result.telemetry).toEqual(telemetry);
		expect(lifecycle.at(-1)?.telemetry).toEqual(telemetry);
		expect(harness.disposedAtAppend).toEqual([false]);
	});
});
