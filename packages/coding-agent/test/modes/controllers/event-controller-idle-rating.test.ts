import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { listSessionFeedback, recordSessionFeedback } from "@oh-my-pi/pi-coding-agent/session/session-feedback";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

function createAssistantMessage(text = "done"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

interface Harness {
	context: InteractiveModeContext;
	manager: SessionManager;
	showHookSelector: Mock<() => Promise<string | undefined>>;
	showHookInput: Mock<() => Promise<string | undefined>>;
	showStatus: Mock<(message: string, options?: { dim?: boolean }) => void>;
}

function createHarness(
	options: {
		editorText?: string;
		withAssistant?: boolean;
		selectorChoice?: string | undefined;
		inputText?: string | undefined;
	} = {},
): Harness {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	if (options.withAssistant ?? true) manager.appendMessage(createAssistantMessage("Fixed the bug"));
	const showHookSelector = vi.fn(async () => options.selectorChoice);
	const showHookInput = vi.fn(async () => options.inputText);
	const showStatus = vi.fn((_: string, _options?: { dim?: boolean }) => {});
	const session = {
		isCompacting: false,
		isStreaming: false,
		runIdleCompaction: () => {},
		runEphemeralTurn: async () => ({ replyText: "", assistantMessage: createAssistantMessage() }),
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		messages: [createAssistantMessage()],
		getContextUsage: () => ({ tokens: 210 }),
		getGoalModeState: () => undefined,
		agent: { state: { messages: [createAssistantMessage()] } },
		sessionManager: manager,
	};
	const context = {
		isInitialized: true,
		loadingAnimation: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map<string, unknown>(),
		flushPendingModelSwitch: async () => {},
		flushPendingCommandOutput: () => {},
		ui: { requestRender: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		statusContainer: { clear: vi.fn() },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		editor: { getText: () => options.editorText ?? "" },
		sessionManager: manager,
		todoPhases: [],
		showStatus,
		showHookSelector,
		showHookInput,
		hookSelector: undefined,
		hookInput: undefined,
		hookEditor: undefined,
		session,
		get viewSession() {
			return session;
		},
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;
	return { context, manager, showHookSelector, showHookInput, showStatus };
}

describe("EventController idle rating prompt", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
				"recap.enabled": false,
				"feedback.ratingIdleSeconds": 5,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("asks for a rating after the idle delay, then asks for detail on a low score and stores both", async () => {
		const harness = createHarness({ selectorChoice: "2. Poor", inputText: "it ignored my instructions" });
		const controller = new EventController(harness.context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(4_999);
		expect(harness.showHookSelector).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(harness.showHookSelector).toHaveBeenCalledTimes(1);
		expect(harness.showHookInput).toHaveBeenCalledTimes(1);

		const [record] = listSessionFeedback(harness.manager);
		expect(record).toMatchObject({
			score: 2,
			rating: "negative",
			text: "it ignored my instructions",
			source: "rating-prompt",
			targetPreview: "Fixed the bug",
		});
		expect(harness.showStatus.mock.calls[0]?.[0]).toContain("rated 2/5 with your note");

		// A later idle turn in the same session must not ask again.
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
		expect(harness.showHookSelector).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("skips the detail question on a high score", async () => {
		const harness = createHarness({ selectorChoice: "5. Excellent" });
		const controller = new EventController(harness.context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();

		expect(harness.showHookInput).not.toHaveBeenCalled();
		expect(listSessionFeedback(harness.manager)[0]).toMatchObject({ score: 5, rating: "positive", text: "" });
		controller.dispose();
	});

	it("stores nothing when dismissed and does not re-prompt that session", async () => {
		const harness = createHarness({ selectorChoice: undefined });
		const controller = new EventController(harness.context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(harness.showHookSelector).toHaveBeenCalledTimes(1);
		expect(listSessionFeedback(harness.manager)).toHaveLength(0);

		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(harness.showHookSelector).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("stays silent when disabled, when the session is already rated, when the editor has a draft, or before any reply", async () => {
		const disabled = createHarness({ selectorChoice: "4. Good" });
		Settings.instance.override("feedback.ratingPrompt", false);
		let controller = new EventController(disabled.context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(disabled.showHookSelector).not.toHaveBeenCalled();
		controller.dispose();
		Settings.instance.clearOverride("feedback.ratingPrompt");

		const rated = createHarness({ selectorChoice: "4. Good" });
		recordSessionFeedback({ sessionManager: rated.manager }, { score: 3 });
		controller = new EventController(rated.context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(rated.showHookSelector).not.toHaveBeenCalled();
		controller.dispose();

		const drafting = createHarness({ editorText: "typing", selectorChoice: "4. Good" });
		controller = new EventController(drafting.context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(drafting.showHookSelector).not.toHaveBeenCalled();
		controller.dispose();

		const noReply = createHarness({ withAssistant: false, selectorChoice: "4. Good" });
		controller = new EventController(noReply.context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(noReply.showHookSelector).not.toHaveBeenCalled();
		controller.dispose();
	});
});
