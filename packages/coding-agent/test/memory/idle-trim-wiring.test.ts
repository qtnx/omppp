import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IdleMemoryTrim } from "@oh-my-pi/pi-coding-agent/memory/idle-trim";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createContext(): InteractiveModeContext {
	const context = {
		isInitialized: true,
		loadingAnimation: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map<string, unknown>(),
		flushPendingModelSwitch: async () => {},
		flushPendingCommandOutput: vi.fn(),
		ui: { requestRender: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		statusContainer: { clear: vi.fn(), disposeChildren: vi.fn() },
		statusLine: {
			invalidate: vi.fn(),
			markActivityStart: vi.fn(),
			markActivityEnd: vi.fn(),
			setHookStatus: vi.fn(),
		},
		updateEditorTopBorder: vi.fn(),
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => undefined },
		todoPhases: [],
		showStatus: () => {},
		clearPinnedError: () => {},
		ensureLoadingAnimation: () => {},
		session: {
			isCompacting: false,
			isStreaming: false,
			runIdleCompaction: () => {},
			runEphemeralTurn: async () => ({ replyText: "", assistantMessage: createAssistantMessage() }),
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			messages: [createAssistantMessage()],
			getContextUsage: () => ({ tokens: 210 }),
			getGoalModeState: () => undefined,
			agent: { state: { messages: [createAssistantMessage()] } },
		},
		get viewSession() {
			return (this as typeof context).session;
		},
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;
	return context;
}

function createSpyCoordinator(): IdleMemoryTrim {
	return {
		notifyActivityEnd: vi.fn(),
		notifyActivityStart: vi.fn(),
		trimNow: vi.fn(async () => {}),
		dispose: vi.fn(),
	} as unknown as IdleMemoryTrim;
}

describe("EventController idle memory trim wiring", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"recap.enabled": false,
				"completion.notify": "off",
			},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("notifies activity end on agent_end", async () => {
		const idleMemoryTrim = createSpyCoordinator();
		const controller = new EventController(createContext(), { idleMemoryTrim });

		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		expect(idleMemoryTrim.notifyActivityEnd).toHaveBeenCalledTimes(1);
		expect(idleMemoryTrim.notifyActivityStart).not.toHaveBeenCalled();
	});

	it("notifies activity start on agent_start", async () => {
		const idleMemoryTrim = createSpyCoordinator();
		const controller = new EventController(createContext(), { idleMemoryTrim });

		await controller.handleEvent({ type: "agent_start" });

		expect(idleMemoryTrim.notifyActivityStart).toHaveBeenCalledTimes(1);
		expect(idleMemoryTrim.notifyActivityEnd).not.toHaveBeenCalled();
	});

	it("disposes the coordinator when the controller disposes", () => {
		const idleMemoryTrim = createSpyCoordinator();
		const controller = new EventController(createContext(), { idleMemoryTrim });

		controller.dispose();

		expect(idleMemoryTrim.dispose).toHaveBeenCalledTimes(1);
	});
});
