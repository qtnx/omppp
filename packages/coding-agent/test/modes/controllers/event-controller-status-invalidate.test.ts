/**
 * Regression guard: `EventController.handleEvent` must NOT invalidate the
 * status-line git/PR caches on every event. The per-event invalidate forced a
 * sync git resolve plus a back-to-back `gh pr view` subprocess on every
 * streaming delta (the cache's own TTL/watcher were defeated). The top border
 * still refreshes per event (token counts grow while streaming); the git/PR
 * caches are refreshed once at turn end instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createContext() {
	const statusLine = { invalidate: vi.fn() };
	const updateEditorTopBorder = vi.fn();
	const ctx = {
		isInitialized: true,
		settings: { get: () => false },
		statusLine,
		updateEditorTopBorder,
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
			retryAttempt: 0,
		},
		ui: { setEagerNativeScrollbackRebuild: vi.fn(), requestRender: vi.fn() },
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, statusLine, updateEditorTopBorder };
}

// A tool_execution_update for a non-pending id is a no-op in its handler, so it
// isolates the handleEvent-level chrome refresh (the part under test).
const NON_TURN_EVENT = {
	type: "tool_execution_update",
	toolCallId: "not-pending",
	partialResult: { content: [], details: {} },
} as unknown as AgentSessionEvent;

describe("EventController status-line invalidation", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("does not invalidate git/PR caches per event, but still refreshes the top border", async () => {
		const { ctx, statusLine, updateEditorTopBorder } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(NON_TURN_EVENT);
		await controller.handleEvent(NON_TURN_EVENT);

		expect(statusLine.invalidate).not.toHaveBeenCalled();
		expect(updateEditorTopBorder).toHaveBeenCalled();
	});

	it("invalidates git/PR caches once at turn end (agent_end safety net)", async () => {
		const { ctx, statusLine } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "agent_end" } as unknown as AgentSessionEvent);

		expect(statusLine.invalidate).toHaveBeenCalledTimes(1);
	});
});
