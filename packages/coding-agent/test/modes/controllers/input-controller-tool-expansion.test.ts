import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("InputController tool output expansion", () => {
	it("expands children and forces a full display reset to bypass frozen snapshots", () => {
		const expandable = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const requestRender = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert] },
			ui: { requestRender, resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		// resetDisplay() is the only path that retires the transcript's frozen
		// block snapshots and re-emits the whole transcript at its new heights.
		// A plain requestRender would replay the stale (collapsed) snapshots.
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).not.toHaveBeenCalled();
	});
});

describe("InputController streaming escape cancellation", () => {
	it("routes Esc cancellation through global input listeners when focus is outside the editor", () => {
		type InputListenerResult = { consume?: boolean } | undefined;
		type InputListener = (data: string) => InputListenerResult;

		const inputListeners: InputListener[] = [];
		const abort = vi.fn(async () => {});
		const editor = {
			setActionKeys: vi.fn(),
			getText: vi.fn(() => ""),
			setText: vi.fn(),
			clearCustomKeyHandlers: vi.fn(),
			setCustomKeyHandler: vi.fn(),
			pendingImages: [],
			pendingImageLinks: [],
		};
		const focusedLoader = {};
		const ctx = {
			editor,
			keybindings: {
				getKeys: vi.fn((action: string) => (action === "app.interrupt" ? ["escape"] : [])),
			},
			session: {
				isStreaming: true,
				isBashRunning: false,
				isEvalRunning: false,
				queuedMessageCount: 0,
				subscribe: vi.fn(),
				abort,
				clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
			},
			viewSession: {
				isCompacting: false,
				isGeneratingHandoff: false,
				isRetrying: false,
			},
			ui: {
				addInputListener: vi.fn((listener: InputListener) => {
					inputListeners.push(listener);
				}),
				addStartListener: vi.fn(),
				getFocused: vi.fn(() => focusedLoader),
				requestRender: vi.fn(),
				resetDisplay: vi.fn(),
			},
			loadingAnimation: focusedLoader,
			loopModeEnabled: false,
			focusedAgentId: undefined,
			collabGuest: undefined,
			hasActiveBtw: vi.fn(() => false),
			handleBtwEscape: vi.fn(() => false),
			hasActiveOmfg: vi.fn(() => false),
			handleOmfgEscape: vi.fn(() => false),
			hasActiveUsagePanel: vi.fn(() => false),
			dismissUsagePanel: vi.fn(() => false),
			cancelPendingSubmission: vi.fn(() => false),
			locallySubmittedUserSignatures: new Set(),
			compactionQueuedMessages: [],
			updatePendingMessagesDisplay: vi.fn(),
			showStatus: vi.fn(),
			lastEscapeTime: 0,
			showTreeSelector: vi.fn(),
			showUserMessageSelector: vi.fn(),
			showModelSelector: vi.fn(),
			showDebugSelector: vi.fn(),
			showHistorySearch: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
			handlePlanModeCommand: vi.fn(),
			handleOrchestratorModeCommand: vi.fn(),
			handleClearCommand: vi.fn(),
			showSessionSelector: vi.fn(),
			handleSTTToggle: vi.fn(),
			showAgentHub: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		} as unknown as InteractiveModeContext;

		new InputController(ctx).setupKeyHandlers();

		// Send two interrupts so this regression targets routing loss, not the
		// existing double-Esc confirmation policy.
		for (const listener of inputListeners) listener("\x1b");
		for (const listener of inputListeners) listener("\x1b");

		expect(abort).toHaveBeenCalled();
		expect(abort).toHaveBeenCalledWith({ reason: "Interrupted by user" });
	});
});
