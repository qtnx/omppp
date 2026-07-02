/**
 * Contract: while a reasoning turn is waiting for its first content, the
 * working message shows a ticking `thinking… Ns` label, and the label exits
 * the moment ANY assistant stream progress arrives — visible text/thinking,
 * or a toolCall block — regardless of whether the transcript's
 * streamingComponent path is active (duo/plan phases stream assistant
 * messages through other render paths; the label must not outlive the wait).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createContext(overrides?: { thinkingLevel?: ThinkingLevel; isStreaming?: boolean }) {
	const setWorkingMessage = vi.fn();
	const ctx = {
		isInitialized: true,
		settings: { get: () => false },
		statusLine: { invalidate: vi.fn() },
		statusContainer: { clear: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		pendingTools: new Map<string, unknown>(),
		chatContainer: { addChild: vi.fn(), removeChild: vi.fn() },
		hideThinkingBlock: false,
		editor: { getText: vi.fn(() => "") },
		flushPendingModelSwitch: vi.fn(),
		sessionManager: { getSessionName: () => undefined },
		session: {
			agent: { state: { messages: [] } },
			isCompacting: false,
			isTtsrAbortPending: false,
			isAborting: false,
			isStreaming: overrides?.isStreaming ?? true,
			thinkingLevel: overrides?.thinkingLevel ?? ThinkingLevel.Medium,
			retryAttempt: 0,
		},
		ui: { setEagerNativeScrollbackRebuild: vi.fn(), requestRender: vi.fn() },
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		setWorkingMessage,
	} as unknown as InteractiveModeContext;
	return { ctx, setWorkingMessage };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;

function assistantUpdate(content: unknown[]): AgentSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content },
		assistantMessageEvent: { type: "text_delta" },
	} as unknown as AgentSessionEvent;
}

describe("EventController thinking-wait working message", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("shows a ticking thinking label from agent_start while reasoning is enabled", async () => {
		vi.useFakeTimers();
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		const { ctx, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(setWorkingMessage).toHaveBeenCalled();
		expect(setWorkingMessage.mock.calls.at(-1)?.[0]).toMatch(/^thinking… 0s/);

		nowSpy.mockReturnValue(1_002_000);
		vi.advanceTimersByTime(2000);
		expect(setWorkingMessage.mock.calls.at(-1)?.[0]).toMatch(/^thinking… 2s/);
		controller.dispose();
	});

	it("does not enter the label when thinking is off", async () => {
		const { ctx, setWorkingMessage } = createContext({ thinkingLevel: ThinkingLevel.Off });
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(setWorkingMessage).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("keeps the label while assistant updates carry only empty thinking blocks", async () => {
		const { ctx, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		setWorkingMessage.mockClear();
		await controller.handleEvent(assistantUpdate([{ type: "thinking", thinking: "" }]));
		expect(setWorkingMessage).not.toHaveBeenCalledWith(undefined);
		controller.dispose();
	});

	it("restores the default working message on visible text even without a streamingComponent", async () => {
		const { ctx, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(assistantUpdate([{ type: "text", text: "Hello" }]));
		expect(setWorkingMessage).toHaveBeenCalledWith(undefined);
		controller.dispose();
	});

	it("exits the label when a toolCall block streams in", async () => {
		const { ctx, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(assistantUpdate([{ type: "toolCall", id: "t1", name: "read", arguments: {} }]));
		expect(setWorkingMessage).toHaveBeenCalledWith(undefined);
		controller.dispose();
	});
});
