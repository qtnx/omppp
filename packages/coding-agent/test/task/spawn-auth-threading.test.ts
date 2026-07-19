import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const TASK_AGENT: AgentDefinition = {
	name: "task",
	description: "test task agent",
	systemPrompt: "You are a test task agent.",
	source: "bundled",
};

function createYieldingAgentSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-auth-threading",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function createAuthStorage(): AuthStorage {
	return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
}

function createParentModelRegistry(authStorage: AuthStorage): ModelRegistry {
	return {
		authStorage,
		refresh: async () => {},
		getAvailable: () => [],
		getAll: () => [],
		getApiKey: async () => undefined,
		resolver: () => async () => undefined,
	} as unknown as ModelRegistry;
}

function createToolSession(authStorage: AuthStorage, modelRegistry: ModelRegistry): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "task.isolation.mode": "none" }),
		authStorage,
		modelRegistry,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => undefined,
		getModelString: () => undefined,
		eventBus: new EventBus(),
		enableLsp: false,
	} as unknown as ToolSession;
}

describe("task subagent auth threading", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reuses the parent registry and auth storage through the task-tool spawn path", async () => {
		const authStorage = createAuthStorage();
		await authStorage.reload();
		const modelRegistry = createParentModelRegistry(authStorage);
		const discoverAuthStorageSpy = vi
			.spyOn(sdkModule, "discoverAuthStorage")
			.mockRejectedValue(new Error("discoverAuthStorage must not be called when parent registry is supplied"));
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(createYieldingAgentSession()));
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TASK_AGENT], projectAgentsDir: null });

		const tool = await TaskTool.create(createToolSession(authStorage, modelRegistry));
		await tool.execute("tool-auth-threading", {
			agent: "task",
			id: "AuthThreading",
			description: "auth threading",
			assignment: "Return success.",
		} as TaskParams);
		expect(discoverAuthStorageSpy).not.toHaveBeenCalled();
		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		const forwarded = createAgentSessionSpy.mock.calls[0]?.[0];
		expect(forwarded?.modelRegistry).toBe(modelRegistry);
		expect(forwarded?.authStorage).toBe(authStorage);
		expect(modelRegistry.authStorage).toBe(authStorage);
	});

	it("keeps the standalone executor fallback when only auth storage is supplied", async () => {
		const authStorage = createAuthStorage();
		await authStorage.reload();
		const discoverAuthStorageSpy = vi.spyOn(sdkModule, "discoverAuthStorage");
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(createYieldingAgentSession()));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: TASK_AGENT,
			task: "Return success.",
			index: 0,
			id: "standalone-auth-fallback",
			settings: Settings.isolated(),
			authStorage,
			enableLsp: false,
		});

		expect(result.exitCode).toBe(0);
		expect(discoverAuthStorageSpy).not.toHaveBeenCalled();
		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		const forwarded = createAgentSessionSpy.mock.calls[0]?.[0];
		expect(forwarded?.authStorage).toBe(authStorage);
		expect(forwarded?.modelRegistry?.authStorage).toBe(authStorage);
	});
});
