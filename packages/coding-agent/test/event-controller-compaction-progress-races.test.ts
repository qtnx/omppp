/**
 * Race/lifecycle invariants for the AUTO compaction progress overlay, driven
 * through the real `EventController.handleEvent` dispatch (public seam) so the
 * private `#handleAutoCompaction*` handlers run exactly as production wires them
 * via the session-event dispatch map.
 *
 * These defend three advisor-flagged hazards:
 *   1. No progress-after-end resurrection — a late throttled progress event that
 *      lands after `auto_compaction_end` must be an inert no-op (no new
 *      component, no re-add to the status container, no new timer).
 *   2. Retry re-entry leaves no leak — start -> end(willRetry) -> start -> end
 *      tears the first cycle's overlay + 1s interval down fully before the
 *      second start; zero leftover components/timers at the finish.
 *   3. Streaming-loader guard released on ALL end variants — after
 *      `auto_compaction_end` (aborted / errorMessage / willRetry / normal
 *      result) the overlay the `#ensureWorkingLoaderWhileStreaming` guard
 *      short-circuits on is gone, so a subsequent streaming event restores the
 *      "Working…" loader, and terminal progress (OSC 9;4) is turned off.
 *
 * Level chosen: the full event-controller `ctx` harness + `handleEvent`. The
 * compaction path touches a modest, fully-mockable slice of `ctx`, so the real
 * private handlers are exercised end-to-end rather than reimplemented. Fake
 * timers make the component's 1s `setInterval` observable via `getTimerCount()`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactionProgressComponent } from "@oh-my-pi/pi-coding-agent/modes/components/compaction-progress";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

// Strip ANSI SGR escapes so assertions target the visible text the overlay emits.
const ANSI = /\x1b\[[0-9;]*m/g;
function plain(component: CompactionProgressComponent, width = 80): string {
	return component.render(width).join("\n").replace(ANSI, "");
}

function disposeChildren(children: unknown[]): void {
	for (const child of children) {
		if (child && typeof child === "object" && "dispose" in child && typeof child.dispose === "function") {
			child.dispose();
		}
	}
	children.length = 0;
}

function createHarness() {
	// A minimal status container that records children so we can observe adds and
	// clears the way the real TUI container would surface them.
	const children: unknown[] = [];
	const addChild = vi.fn((child: unknown) => {
		children.push(child);
	});
	const clear = vi.fn(() => {
		children.length = 0;
	});
	const statusContainer = { children, addChild, clear, disposeChildren: vi.fn(() => disposeChildren(children)) };

	const setProgress = vi.fn();
	const requestRender = vi.fn();
	const ensureLoadingAnimation = vi.fn();

	// One session object shared as both `session` and `viewSession`; the guard
	// reads `viewSession ?? session`, the end handler reads `session.isStreaming`.
	const session = {
		isStreaming: false,
		isAborting: false,
		abortCompaction: vi.fn(),
		abortRetry: vi.fn(),
	};

	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		updateEditorTopBorder: vi.fn(),
		editor: { onEscape: undefined as (() => void) | undefined },
		session,
		viewSession: session,
		// `terminal.showProgress` must be true so `#setTerminalProgress` actually
		// drives OSC 9;4 — the flag under test on the exit paths.
		settings: { get: vi.fn((key: string) => (key === "terminal.showProgress" ? true : undefined)) },
		ui: { requestRender, terminal: { setProgress } },
		statusContainer,
		autoCompactionProgress: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		loadingAnimation: undefined,
		focusedAgentId: undefined,
		ensureLoadingAnimation,
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
		statusLine: { invalidate: vi.fn() },
		lastAssistantUsage: undefined,
		flushCompactionQueue: vi.fn(async () => {}),
		pendingTools: new Map(),
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, ctx, statusContainer, session, setProgress, ensureLoadingAnimation };
}

function startEvent(): Extract<AgentSessionEvent, { type: "auto_compaction_start" }> {
	return { type: "auto_compaction_start", reason: "overflow", action: "context-full" };
}

function progressEvent(
	bytes: number,
	estTokens?: number,
): Extract<AgentSessionEvent, { type: "auto_compaction_progress" }> {
	return { type: "auto_compaction_progress", action: "context-full", elapsedMs: 0, events: 1, bytes, estTokens };
}

function endEvent(
	overrides: Partial<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>> = {},
): Extract<AgentSessionEvent, { type: "auto_compaction_end" }> {
	return {
		type: "auto_compaction_end",
		action: "context-full",
		result: undefined,
		aborted: false,
		willRetry: false,
		...overrides,
	};
}

// A `tool_execution_update` for a tool the controller is not tracking: it runs
// `#ensureWorkingLoaderWhileStreaming` at the top and then no-ops (empty
// pendingTools). The lightest public event that exercises the guard downstream.
function untrackedToolUpdateEvent(): Extract<AgentSessionEvent, { type: "tool_execution_update" }> {
	return {
		type: "tool_execution_update",
		toolCallId: "not-tracked",
		partialResult: { content: [], details: {} },
	} as unknown as Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
}

describe("EventController auto-compaction progress lifecycle/races", () => {
	beforeAll(async () => {
		// `#handleAutoCompactionEnd` reads the process-global config used by the
		// running application, not the harness-local `ctx.settings`.
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		// Overlay pulls spinner frames + colors from the active theme.
		await initTheme(false);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	// Invariant 1.
	it("does not resurrect the overlay when a throttled progress event arrives AFTER end", async () => {
		vi.useFakeTimers();
		const { controller, ctx, statusContainer } = createHarness();

		await controller.handleEvent(startEvent());
		const component = ctx.autoCompactionProgress;
		expect(component).toBeInstanceOf(CompactionProgressComponent);
		expect(statusContainer.addChild).toHaveBeenCalledTimes(1);
		expect(statusContainer.children).toHaveLength(1);
		// The overlay's own 1s tick is the only live timer.
		expect(vi.getTimerCount()).toBe(1);

		await controller.handleEvent(progressEvent(400, 100));
		expect(ctx.autoCompactionProgress).toBe(component);

		await controller.handleEvent(endEvent());
		expect(ctx.autoCompactionProgress).toBeUndefined();
		expect(statusContainer.children).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);

		const addsBeforeLateProgress = statusContainer.addChild.mock.calls.length;

		// LATE throttled progress after end: MUST be an inert no-op.
		await controller.handleEvent(progressEvent(800, 200));

		expect(ctx.autoCompactionProgress).toBeUndefined(); // not resurrected
		expect(statusContainer.addChild.mock.calls.length).toBe(addsBeforeLateProgress); // nothing re-added
		expect(statusContainer.children).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0); // no new timer started
	});

	// Invariant 2.
	it("tears down the first cycle before a retry re-entry, leaving zero leftover components or timers", async () => {
		vi.useFakeTimers();
		const { controller, ctx, statusContainer } = createHarness();

		await controller.handleEvent(startEvent());
		const first = ctx.autoCompactionProgress;
		expect(first).toBeInstanceOf(CompactionProgressComponent);
		expect(vi.getTimerCount()).toBe(1);

		// End of the first cycle with willRetry: the timer + component must be gone.
		await controller.handleEvent(endEvent({ willRetry: true }));
		expect(ctx.autoCompactionProgress).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		expect(statusContainer.children).toHaveLength(0);

		// Retry re-entry: a fresh overlay with EXACTLY one live timer (no leak of
		// the first cycle's interval alongside it).
		await controller.handleEvent(startEvent());
		const second = ctx.autoCompactionProgress;
		expect(second).toBeInstanceOf(CompactionProgressComponent);
		expect(second).not.toBe(first);
		expect(vi.getTimerCount()).toBe(1);

		await controller.handleEvent(endEvent());
		expect(ctx.autoCompactionProgress).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0); // no leftover interval at the finish
		expect(statusContainer.children).toHaveLength(0);
	});

	// Invariant 3 — table over every end variant.
	const exitVariants: {
		name: string;
		overrides: Partial<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>>;
	}[] = [
		{ name: "aborted", overrides: { aborted: true } },
		{ name: "errorMessage set", overrides: { errorMessage: "compaction failed" } },
		{ name: "willRetry", overrides: { willRetry: true } },
		{
			name: "normal result",
			overrides: { result: {} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>["result"] },
		},
	];

	for (const variant of exitVariants) {
		it(`releases the streaming-loader guard and turns terminal progress OFF on ${variant.name} exit`, async () => {
			vi.useFakeTimers();
			const { controller, ctx, session, setProgress, ensureLoadingAnimation } = createHarness();

			await controller.handleEvent(startEvent());
			expect(setProgress).toHaveBeenLastCalledWith(true);
			expect(ctx.autoCompactionProgress).toBeInstanceOf(CompactionProgressComponent);

			await controller.handleEvent(endEvent(variant.overrides));

			// Guard release: the three references `#ensureWorkingLoaderWhileStreaming`
			// short-circuits on are all cleared, so the guard no longer blocks.
			expect(ctx.autoCompactionProgress).toBeUndefined();
			expect(ctx.autoCompactionLoader).toBeUndefined();
			expect(ctx.retryLoader).toBeUndefined();
			// Terminal progress toggled off on the way out.
			expect(setProgress).toHaveBeenLastCalledWith(false);

			// Downstream proof: with the overlay gone, a later streaming event DOES
			// restore the working loader. (End ran with isStreaming=false so nothing
			// restored it during the handler itself — this isolates the guard.)
			session.isStreaming = true;
			ensureLoadingAnimation.mockClear();
			await controller.handleEvent(untrackedToolUpdateEvent());
			expect(ensureLoadingAnimation).toHaveBeenCalledTimes(1);
		});
	}

	// Happy path — controller wiring (event -> overlay.update) forwards the token
	// estimate, distinct from the isolated component test.
	it("forwards a bytes>0 progress to the overlay (token counter renders) and clears the container on end", async () => {
		vi.useFakeTimers();
		const { controller, ctx, statusContainer } = createHarness();

		await controller.handleEvent(startEvent());
		const component = ctx.autoCompactionProgress as unknown as CompactionProgressComponent;
		// Render wide: the long auto-compaction label would otherwise push the
		// `~N tok` counter past a narrow width cap and truncate it.
		expect(plain(component, 120)).not.toContain("tok"); // no streamed payload yet

		await controller.handleEvent(progressEvent(400, 100));
		const line = plain(component, 120);
		expect(line).toContain("tok");
		expect(line).toContain("100"); // estTokens forwarded verbatim

		await controller.handleEvent(
			endEvent({ result: {} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>["result"] }),
		);
		expect(statusContainer.children).toHaveLength(0);
		expect(ctx.autoCompactionProgress).toBeUndefined();
	});
});
