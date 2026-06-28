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
	HERDR_NATIVE_AGENT_STATE_ENV,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/herdr-agent-state";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { createAgentSession, loadSessionExtensions } from "@oh-my-pi/pi-coding-agent/sdk";
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
	let asyncRunning = 0;
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
				delivery: { queued: 0, delivering: false, pendingJobIds: [] },
			}),
			getGoalModeState: () => undefined,
			abort: () => {},
			hasPendingMessages: () => pending,
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
		setAsyncRunning(value: number) {
			asyncRunning = value;
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

	it("keeps Herdr working after agent_end when queued messages remain", async () => {
		const harness = await createHarness();
		harness.setPending(true);

		await harness.runner.emit({ type: "agent_start" });
		await harness.runner.emit({ type: "agent_end", messages: [] });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("working");

		harness.setPending(false);
		await harness.runner.emit({ type: "session_start" });
		await flushTimers();

		expect(harness.requests.at(-1)?.params.state).toBe("idle");
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
				source: "herdr:omp",
				agent: "omp",
			},
		});
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

	it("sets the native Herdr marker before SDK-managed extension preload", async () => {
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

		expect(process.env[HERDR_NATIVE_AGENT_STATE_ENV]).toBe("1");
		expect(result.extensions.some(extension => extension.label === "managed fallback active")).toBe(false);
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
