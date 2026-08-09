import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function yieldEmittingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		getAllToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-effort",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function modelOrThrow(): Model {
	const model = getBundledModel("openai-codex", "gpt-5.6-terra");
	if (!model) throw new Error("Expected bundled openai-codex/gpt-5.6-terra model");
	return model;
}

function createModelRegistry(models: Model[]): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		getAvailable: () => models,
		getApiKey: async () => "test-key",
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess effort precedence", () => {
	const model = modelOrThrow();
	const selector = `${model.provider}/${model.id}`;

	function baseOptions(id: string) {
		return {
			cwd: "/tmp",
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: createModelRegistry([model]),
			enableLsp: false,
			agent,
		};
	}

	async function runAndGetForwarded(options: Parameters<typeof runSubprocess>[0]) {
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess(options);
		expect(result.exitCode).toBe(0);
		return spy.mock.calls[0]?.[0];
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards a human-configured explicit thinking level to the spawned session over coarse effort", async () => {
		const forwarded = await runAndGetForwarded({
			...baseOptions("configured-level-wins"),
			modelOverride: `${selector}:high`,
			effort: "hi",
			modelSelectorFromUserConfig: true,
		});

		expect(forwarded?.thinkingLevel).toBe(Effort.High);
	});

	it("forwards coarse hi effort to the spawned session when the selector is not human config", async () => {
		const supported = getSupportedEfforts(model);
		expect(supported.at(-1)).toBe(Effort.Max);
		const forwarded = await runAndGetForwarded({
			...baseOptions("caller-effort-wins"),
			modelOverride: `${selector}:high`,
			effort: "hi",
		});

		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
	});

	it("forwards coarse effort to the spawned session when human config has no explicit level", async () => {
		const supported = getSupportedEfforts(model);
		const forwarded = await runAndGetForwarded({
			...baseOptions("configured-level-absent"),
			modelOverride: selector,
			effort: "lo",
			modelSelectorFromUserConfig: true,
		});

		expect(forwarded?.thinkingLevel).toBe(supported[0]);
	});
});
