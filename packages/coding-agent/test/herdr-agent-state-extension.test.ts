import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createHerdrAgentStateExtension,
	HERDR_AGENT_STATE_LABEL,
	HERDR_MANAGED_FALLBACK_SENTINEL,
	HERDR_NATIVE_AGENT_STATE_ENV,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/herdr-agent-state";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
	createAgentSession,
	discoverSessionExtensionPaths,
	loadSessionExtensions,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Snowflake } from "@oh-my-pi/pi-utils";

type CapturedRequest = {
	method: string;
	params: Record<string, unknown>;
};

const tempDirs: string[] = [];

function makeTempDir(): string {
	const tempDir = path.join(os.tmpdir(), `pi-herdr-agent-state-${Snowflake.next()}`);
	tempDirs.push(tempDir);
	fs.mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

const originalEnv = {
	HERDR_ENV: process.env.HERDR_ENV,
	HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
	HERDR_PANE_ID: process.env.HERDR_PANE_ID,
	HERDR_OMP_IDLE_DEBOUNCE_MS: process.env.HERDR_OMP_IDLE_DEBOUNCE_MS,
	HERDR_OMP_RETRY_GRACE_MS: process.env.HERDR_OMP_RETRY_GRACE_MS,
	[HERDR_NATIVE_AGENT_STATE_ENV]: process.env[HERDR_NATIVE_AGENT_STATE_ENV],
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

function configureHerdrEnv(options: { idleDebounceMs?: number; retryGraceMs?: number } = {}): void {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
	process.env.HERDR_PANE_ID = "w1:p1";
	// This harness only exercises the state channel; keep it off the real
	// `~/.omp/run/control` run dir.
	process.env.HERDR_CONTROL_SOCKET = "0";
	process.env.HERDR_OMP_IDLE_DEBOUNCE_MS = String(options.idleDebounceMs ?? 0);
	process.env.HERDR_OMP_RETRY_GRACE_MS = String(options.retryGraceMs ?? 0);
	delete process.env[HERDR_NATIVE_AGENT_STATE_ENV];
}

async function flushTimers(): Promise<void> {
	vi.advanceTimersByTime(1);
	for (let i = 0; i < 5; i += 1) {
		await Promise.resolve();
	}
}

function assistantMessage(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: errorMessage ?? "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason,
		errorMessage,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
}

async function createHarness(
	options: {
		idleDebounceMs?: number;
		retryGraceMs?: number;
		transport?: (request: CapturedRequest) => Promise<void>;
	} = {},
) {
	configureHerdrEnv(options);
	const requests: CapturedRequest[] = [];
	const eventBus = new EventBus();
	let idle = true;
	let pending = false;
	let pendingAgentWork = false;
	let asyncRunning = 0;
	let deliveryQueued = 0;
	let deliveryDelivering = false;
	const extension = await loadExtensionFromFactory(
		createHerdrAgentStateExtension({
			transport: async request => {
				const captured = request as CapturedRequest;
				requests.push(captured);
				await options.transport?.(captured);
			},
		}),
		process.cwd(),
		eventBus,
		new ExtensionRuntime(),
		"<native-herdr-agent-state>",
	);
	const runner = new ExtensionRunner(
		[extension],
		new ExtensionRuntime(),
		process.cwd(),
		SessionManager.inMemory(),
		{} as ModelRegistry,
	);
	runner.initialize(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => true,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		},
		{
			getContextUsage: () => undefined,
			compact: async () => {},
			getModel: () => undefined,
			isIdle: () => idle,
			getAsyncJobSnapshot: () => ({
				running: Array.from({ length: asyncRunning }, (_, index) => ({
					id: `job-${index}`,
					type: "bash" as const,
					status: "running" as const,
					label: `job ${index}`,
					startTime: 0,
				})),
				recent: [],
				delivery: { queued: deliveryQueued, delivering: deliveryDelivering, pendingJobIds: [] },
			}),
			getGoalModeState: () => undefined,
			abort: () => {},
			hasPendingMessages: () => pending,
			hasPendingAgentWork: () => pendingAgentWork,
			shutdown: () => {},
			getSystemPrompt: () => [],
		},
	);
	return {
		eventBus,
		runner,
		requests,
		setIdle(value: boolean) {
			idle = value;
		},
		setPending(value: boolean) {
			pending = value;
		},
		setPendingAgentWork(value: boolean) {
			pendingAgentWork = value;
		},
		setAsyncRunning(value: number) {
			asyncRunning = value;
		},
		setDelivery(value: { queued?: number; delivering?: boolean }) {
			deliveryQueued = value.queued ?? deliveryQueued;
			deliveryDelivering = value.delivering ?? deliveryDelivering;
		},
	};
}

describe("native Herdr agent state extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		restoreEnv();
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		AsyncJobManager.resetForTests();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("publishes idle immediately on registration before any event", async () => {
		const harness = await createHarness();
		await flushTimers();

		expect(harness.requests).toHaveLength(1);
		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();
		expect(process.env[HERDR_NATIVE_AGENT_STATE_ENV]).toBe("1");

		await harness.runner.emit({ type: "session_start" });
		await flushTimers();

		expect(harness.requests).toHaveLength(1);
		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();
	});

	it("reports working with a running visual status until tools drain", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "session_start" });
		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} });
		await harness.runner.emit({ type: "agent_end", messages: [] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("running");

		harness.setIdle(true);
		await harness.runner.emit({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "bash",
			result: "done",
			isError: false,
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();
	});

	it("tracks before-turn and nested compaction lifecycle events", async () => {
		const harness = await createHarness();

		harness.setIdle(false);
		await harness.runner.emitBeforeAgentStart("", undefined, []);
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("running");

		harness.setIdle(true);
		await harness.runner.emit({ type: "turn_start", turnIndex: 0, timestamp: 0 });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		await harness.runner.emit({
			type: "turn_end",
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			},
			toolResults: [],
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();

		await harness.runner.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		await harness.runner.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		await harness.runner.emit({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		await harness.runner.emit({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
	});

	it("keeps Herdr working across compaction retry handoff", async () => {
		const harness = await createHarness({ retryGraceMs: 100 });

		await harness.runner.emit({ type: "auto_compaction_start", reason: "overflow", action: "context-full" });
		await harness.runner.emit({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: true,
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		await harness.runner.emitBeforeAgentStart("", undefined, []);
		await harness.runner.emit({ type: "agent_start" });
		vi.advanceTimersByTime(101);
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");
		expect(harness.requests.at(-1)?.params.message).toBeUndefined();
	});

	it("keeps Herdr working while a subagent outlives the main turn", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		harness.eventBus.emit("task:subagent:lifecycle", { id: "sub-1", status: "started" });
		await harness.runner.emit({ type: "agent_end", messages: [] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		harness.eventBus.emit("task:subagent:lifecycle", { id: "sub-1", status: "completed" });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
	});

	it("keeps Herdr working while an async job outlives the main turn", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		harness.eventBus.emit("async:job:lifecycle", { id: "job-1", status: "running", type: "bash" });
		await harness.runner.emit({ type: "agent_end", messages: [] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		harness.eventBus.emit("async:job:lifecycle", { id: "job-1", status: "completed", type: "bash" });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
	});

	it("idles after agent_end even while the prompt is still marked in flight", async () => {
		const harness = await createHarness();
		harness.setIdle(false);

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
	});

	it("reports ask tool execution as need review until the tool drains", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({
			type: "tool_execution_start",
			toolCallId: "ask-1",
			toolName: "ask",
			args: {},
			intent: "confirm deployment",
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("blocked");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("need review");
		expect(harness.requests.at(-1)?.params.message).toBe("confirm deployment");

		await harness.runner.emit({
			type: "tool_execution_end",
			toolCallId: "ask-1",
			toolName: "ask",
			result: "approved",
			isError: false,
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("running");
	});

	it("reports tool approval as need review until resolved", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({
			type: "tool_approval_requested",
			sessionId: "session-1",
			toolCallId: "approval-1",
			toolName: "bash",
			reason: "dangerous command",
			approvalMode: "always-ask",
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("blocked");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("need review");
		expect(harness.requests.at(-1)?.params.message).toBe("dangerous command");

		await harness.runner.emit({
			type: "tool_approval_resolved",
			sessionId: "session-1",
			toolCallId: "approval-1",
			toolName: "bash",
			approved: true,
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("running");
	});

	it("drops pending approval waits after run end and follows the run outcome", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({
			type: "tool_approval_requested",
			sessionId: "session-1",
			toolCallId: "approval-after-end",
			toolName: "bash",
			reason: "dangerous command",
			approvalMode: "always-ask",
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("blocked");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("need review");
		expect(harness.requests.at(-1)?.params.message).toBe("dangerous command");

		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("stop")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("done");
	});

	it("drops live ask waits after aborted run end", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({
			type: "tool_execution_start",
			toolCallId: "ask-aborted",
			toolName: "ask",
			args: {},
			intent: "confirm deployment",
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("blocked");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("need review");

		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("aborted")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();
	});

	it("reports successful run completion as done and clears done on input", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("stop")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("done");

		await harness.runner.emitInput("next", undefined, "interactive");
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("stop")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("done");
	});

	it("does not report done for aborted assistant runs", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("aborted")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();
	});

	it.each([
		["toolUse" as const, "done"],
		["length" as const, "done"],
		[undefined, undefined],
	])("maps agent_end stop reason %s to the expected idle status", async (stopReason, expectedCustomStatus) => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: stopReason ? [assistantMessage(stopReason)] : [] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBe(expectedCustomStatus);
	});

	it("rechecks terminal delivery work so a completed run does not stay running", async () => {
		const harness = await createHarness({ idleDebounceMs: 250 });
		harness.setDelivery({ delivering: true });

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("stop")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("running");

		harness.setDelivery({ delivering: false });
		vi.advanceTimersByTime(250);
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("done");
	});

	it("reports non-retryable agent errors as need review", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("error", "invalid api key")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("blocked");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("need review");
		expect(harness.requests.at(-1)?.params.message).toContain("invalid api key");
	});

	it("clears a stranded need-review failure when the user submits input without starting a run", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("error", "invalid api key")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("blocked");

		// e.g. a slash command: input fires but no before_agent_start/agent_start follows.
		await harness.runner.emitInput("/model", undefined, "interactive");
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();
	});

	it("clears done status on session switch without clearing external pane blockers", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("stop")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("done");

		await harness.runner.emit({ type: "session_switch", reason: "resume", previousSessionFile: "old-session.json" });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();
	});

	it("does not carry a stale running state into the next session on switch", async () => {
		const harness = await createHarness();

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "turn_start", turnIndex: 0, timestamp: 0 });
		await harness.runner.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		// Switch mid-run: agent_end/turn_end/tool_execution_end may never arrive for the
		// old session, so the switch itself must drop run-scoped work flags.
		await harness.runner.emit({ type: "session_switch", reason: "resume", previousSessionFile: "old-session.json" });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBeUndefined();
	});

	it("debounces plain idle after prompt submit so a new run does not flash idle", async () => {
		const harness = await createHarness({ idleDebounceMs: 250 });

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("stop")] });
		vi.advanceTimersByTime(251);
		await flushTimers();
		const doneIndex = harness.requests.length - 1;

		expect(harness.requests.at(doneIndex)?.params.state).toBe("idle");
		expect(harness.requests.at(doneIndex)?.params.custom_status).toBe("done");

		await harness.runner.emitInput("next", undefined, "interactive");
		harness.setIdle(false);
		await harness.runner.emitBeforeAgentStart("", undefined, []);
		vi.advanceTimersByTime(251);
		await flushTimers();

		const nextWorkingIndex = harness.requests.findIndex(
			(request, index) =>
				index > doneIndex && request.params.state === "working" && request.params.custom_status === "running",
		);
		expect(nextWorkingIndex).toBeGreaterThan(doneIndex);
		expect(
			harness.requests
				.slice(doneIndex + 1, nextWorkingIndex)
				.some(request => request.params.state === "idle" && request.params.custom_status === undefined),
		).toBe(false);
	});

	it("keeps Herdr working after agent_end when queued messages can continue", async () => {
		const harness = await createHarness();
		harness.setPending(true);
		harness.setPendingAgentWork(true);

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		harness.setPending(false);
		harness.setPendingAgentWork(false);
		await harness.runner.emit({ type: "session_start" });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
	});

	it("reports done when only hidden next-turn context remains queued", async () => {
		const harness = await createHarness();
		harness.setPending(true);
		harness.setPendingAgentWork(false);

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [assistantMessage("stop")] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("done");
	});

	it("keeps retrying work active when auto retry starts before the grace timer fires", async () => {
		const harness = await createHarness({ retryGraceMs: 100 });
		const messages: AssistantMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "rate limited" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "error",
				errorMessage: "rate limit 429",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			},
		];

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		await harness.runner.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 1_000,
			errorMessage: "rate limit 429",
		});
		vi.advanceTimersByTime(101);
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		await harness.runner.emit({ type: "auto_retry_end", success: true, attempt: 1 });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
	});

	it("keeps retry hold active when input clears a prior failure blocker", async () => {
		const harness = await createHarness({ retryGraceMs: 100 });

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({
			type: "agent_end",
			messages: [assistantMessage("error", "upstream request failed")],
		});
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("running");

		await harness.runner.emitInput("next", undefined, "interactive");
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");
		expect(harness.requests.at(-1)?.params.custom_status).toBe("running");
	});

	it("holds working for usage-limit retryable errors before auto retry starts", async () => {
		const harness = await createHarness({ retryGraceMs: 100 });
		const messages: AssistantMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "quota" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "error",
				errorMessage: "You have exhausted your capacity. Your quota will reset after 30 minutes.",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			},
		];

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		vi.advanceTimersByTime(101);
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("blocked");
		expect(harness.requests.at(-1)?.params.message).toBe(
			"You have exhausted your capacity. Your quota will reset after 30 minutes.",
		);
	});

	it("cancels stale retry grace timers when a new foreground attempt starts", async () => {
		const harness = await createHarness({ retryGraceMs: 100 });
		const messages: AssistantMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "retryable" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "error",
				errorMessage: "upstream request failed",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			},
		];

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages });
		await harness.runner.emitBeforeAgentStart("", undefined, []);
		await harness.runner.emit({ type: "agent_start" });
		vi.advanceTimersByTime(101);
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");
		expect(harness.requests.at(-1)?.params.message).toBeUndefined();
	});

	it("preserves retry failure state after an explicit blocker clears", async () => {
		const harness = await createHarness({ retryGraceMs: 100 });
		const messages: AssistantMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "retryable" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "error",
				errorMessage: "HTTP2StreamReset",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			},
		];

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages });
		harness.eventBus.emit("herdr:blocked", { active: true, label: "approval required" });
		vi.advanceTimersByTime(101);
		await flushTimers();

		harness.eventBus.emit("herdr:blocked", { active: false });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("blocked");
		expect(harness.requests.at(-1)?.params.message).toBe("HTTP2StreamReset");

		harness.eventBus.emit("task:subagent:lifecycle", { id: "sub-after-failure", status: "started" });
		await flushTimers();
		harness.eventBus.emit("task:subagent:lifecycle", { id: "sub-after-failure", status: "completed" });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("blocked");
		expect(harness.requests.at(-1)?.params.message).toBe("HTTP2StreamReset");
	});

	it("does not load native Herdr support without a complete Herdr environment", async () => {
		vi.useRealTimers();
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_PANE_ID;
		delete process.env[HERDR_NATIVE_AGENT_STATE_ENV];
		const tempDir = makeTempDir();
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});

		try {
			expect(
				result.extensionsResult.extensions.some(extension => extension.path === "<native-herdr-agent-state>"),
			).toBe(false);
			expect(process.env[HERDR_NATIVE_AGENT_STATE_ENV]).toBeUndefined();
		} finally {
			await result.session.dispose();
		}
	});

	it("reports and clears blocked state, then releases Herdr authority on shutdown", async () => {
		const harness = await createHarness();

		harness.eventBus.emit("herdr:blocked", { active: true, label: "approval required" });
		await flushTimers();

		expect(harness.requests.at(-1)?.method).toBe("pane.report_agent");
		expect(harness.requests.at(-1)?.params.state).toBe("blocked");
		expect(harness.requests.at(-1)?.params.message).toBe("approval required");

		harness.eventBus.emit("herdr:blocked", { active: false });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");

		await harness.runner.emit({ type: "session_shutdown" });

		expect(harness.requests.at(-1)).toMatchObject({
			method: "pane.release_agent",
			params: {
				pane_id: "w1:p1",
				agent: "omp",
			},
		});
		expect(harness.requests.at(-1)?.params.source).toMatch(/^herdr:omp:/);
		expect(typeof harness.requests.at(-1)?.params.seq).toBe("number");
	});

	it("ignores post-shutdown lifecycle events and best-effort release failures", async () => {
		const harness = await createHarness({
			transport: async request => {
				if (request.method === "pane.release_agent") throw new Error("release failed");
			},
		});

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [] });
		await flushTimers();

		await expect(harness.runner.emit({ type: "session_shutdown" })).resolves.toBeUndefined();
		const requestCountAfterRelease = harness.requests.length;

		await harness.runner.emit({ type: "agent_start" });
		harness.eventBus.emit("task:subagent:lifecycle", { id: "sub-after-shutdown", status: "started" });
		vi.advanceTimersByTime(10_000);
		await flushTimers();

		expect(harness.requests).toHaveLength(requestCountAfterRelease);
	});

	it("loads native Herdr support during createAgentSession when Herdr env is present", async () => {
		vi.useRealTimers();
		configureHerdrEnv();
		const tempDir = makeTempDir();
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});

		try {
			expect(result.extensionsResult.extensions.some(extension => extension.label === HERDR_AGENT_STATE_LABEL)).toBe(
				true,
			);
			expect(process.env[HERDR_NATIVE_AGENT_STATE_ENV]).toBe("1");
		} finally {
			await result.session.dispose();
		}
	});

	it("loads native Herdr when a preloaded managed fallback has the Herdr label", async () => {
		vi.useRealTimers();
		configureHerdrEnv();
		const tempDir = makeTempDir();
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");

		const eventBus = new EventBus();
		const runtime = new ExtensionRuntime();
		const managedFallback = await loadExtensionFromFactory(
			pi => {
				pi.setLabel(HERDR_AGENT_STATE_LABEL);
			},
			tempDir,
			eventBus,
			runtime,
			"/home/work/.omp/agent/extensions/herdr-omp-agent-state.ts",
		);

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model,
			eventBus,
			preloadedExtensions: { extensions: [managedFallback], errors: [], runtime },
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});

		try {
			expect(
				result.extensionsResult.extensions.some(extension => extension.path === "<native-herdr-agent-state>"),
			).toBe(true);
			expect(process.env[HERDR_NATIVE_AGENT_STATE_ENV]).toBe("1");
		} finally {
			await result.session.dispose();
		}
	});

	it("does not reuse preloaded native Herdr extensions in subagent sessions", async () => {
		vi.useRealTimers();
		configureHerdrEnv();
		const tempDir = makeTempDir();
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");

		const eventBus = new EventBus();
		const runtime = new ExtensionRuntime();
		const nativeHerdr = await loadExtensionFromFactory(
			createHerdrAgentStateExtension(),
			tempDir,
			eventBus,
			runtime,
			"<native-herdr-agent-state>",
		);

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model,
			parentTaskPrefix: "1-Sub",
			taskDepth: 1,
			eventBus,
			preloadedExtensions: { extensions: [nativeHerdr], errors: [], runtime },
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});

		try {
			expect(
				result.extensionsResult.extensions.some(extension => extension.path === "<native-herdr-agent-state>"),
			).toBe(false);
		} finally {
			await result.session.dispose();
		}
	});

	it("keeps SDK-managed fallback alive until native factory marks itself live", async () => {
		vi.useRealTimers();
		configureHerdrEnv();
		const tempDir = makeTempDir();
		const managedPath = path.join(tempDir, "herdr-omp-agent-state.ts");
		await Bun.write(
			managedPath,
			`export default function(pi) {
	if (process.env.OMP_NATIVE_HERDR_AGENT_STATE !== "1") {
		pi.setLabel("managed fallback active");
	}
}
`,
		);

		const result = await loadSessionExtensions(
			{
				agentDir: tempDir,
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [managedPath],
			},
			tempDir,
			Settings.isolated(),
			new EventBus(),
		);

		expect(process.env[HERDR_NATIVE_AGENT_STATE_ENV]).toBeUndefined();
		expect(result.extensions.some(extension => extension.label === "managed fallback active")).toBe(true);
	});

	it("drops stale discovered managed Herdr fallback from main sessions when native is env-eligible", async () => {
		vi.useRealTimers();
		configureHerdrEnv(); // native marker unset -> native reporter is active by default under Herdr env
		const tempDir = makeTempDir();
		const managedPath = path.join(tempDir, "herdr-omp-agent-state.ts");
		await Bun.write(managedPath, 'export default function(pi) {\n\tpi.setLabel("managed fallback active");\n}\n');

		const paths = await discoverSessionExtensionPaths(
			{ additionalExtensionPaths: [managedPath] },
			tempDir,
			Settings.isolated(),
		);

		expect(paths.some(extensionPath => path.resolve(extensionPath) === managedPath)).toBe(false);
	});

	it("keeps sentinel managed Herdr fallback discoverable until native marks live", async () => {
		vi.useRealTimers();
		configureHerdrEnv();
		const tempDir = makeTempDir();
		const managedPath = path.join(tempDir, "herdr-omp-agent-state.ts");
		await Bun.write(
			managedPath,
			`export const sentinel = "${HERDR_MANAGED_FALLBACK_SENTINEL}";
export default function(pi) {
	pi.setLabel("managed fallback active");
}
`,
		);

		const paths = await discoverSessionExtensionPaths(
			{ additionalExtensionPaths: [managedPath] },
			tempDir,
			Settings.isolated(),
		);

		expect(paths.some(extensionPath => path.resolve(extensionPath) === managedPath)).toBe(true);
	});

	it("keeps the managed Herdr fallback discoverable when native reporting is disabled", async () => {
		vi.useRealTimers();
		configureHerdrEnv();
		process.env[HERDR_NATIVE_AGENT_STATE_ENV] = "0";
		const tempDir = makeTempDir();
		const managedPath = path.join(tempDir, "herdr-omp-agent-state.ts");
		await Bun.write(managedPath, 'export default function(pi) {\n\tpi.setLabel("managed fallback active");\n}\n');

		const paths = await discoverSessionExtensionPaths(
			{ additionalExtensionPaths: [managedPath] },
			tempDir,
			Settings.isolated(),
		);

		expect(paths.some(extensionPath => path.resolve(extensionPath) === managedPath)).toBe(true);
	});

	it("does not preload managed Herdr fallback paths into subagent sessions", async () => {
		vi.useRealTimers();
		configureHerdrEnv();
		const tempDir = makeTempDir();
		const managedPath = path.join(tempDir, "herdr-omp-agent-state.ts");
		await Bun.write(
			managedPath,
			`export default function(pi) {
	pi.setLabel("managed fallback active");
}
`,
		);
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model,
			parentTaskPrefix: "1-Sub",
			taskDepth: 1,
			preloadedExtensionPaths: [managedPath],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});

		try {
			expect(
				result.extensionsResult.extensions.some(extension => extension.label === "managed fallback active"),
			).toBe(false);
		} finally {
			await result.session.dispose();
		}
	});
	it("does not load native Herdr reporting for subagent sessions", async () => {
		vi.useRealTimers();
		configureHerdrEnv();
		const tempDir = makeTempDir();
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model,
			parentTaskPrefix: "1-Sub",
			taskDepth: 1,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});

		try {
			expect(
				result.extensionsResult.extensions.some(extension => extension.path === "<native-herdr-agent-state>"),
			).toBe(false);
		} finally {
			await result.session.dispose();
		}
	});
});
