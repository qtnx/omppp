import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { Loader } from "@oh-my-pi/pi-tui";

/**
 * Regression: auto-compaction (inline pre-prompt or mid-turn) and auto-retry
 * cleared the status container without stopping `ctx.loadingAnimation`. The
 * stale handle made every later `ensureLoadingAnimation()` a no-op, so the
 * rest of the turn ran with no working spinner.
 */
function disposeChildren(children: unknown[]): void {
	for (const child of children) {
		if (child && typeof child === "object" && "dispose" in child && typeof child.dispose === "function") {
			child.dispose();
		}
	}
	children.length = 0;
}

function createHarness(options: { isStreaming: boolean; withSpinner: boolean }): {
	context: InteractiveModeContext;
	controller: EventController;
} {
	const statusChildren: unknown[] = [];
	const statusContainer = {
		children: statusChildren,
		clear: vi.fn(() => {
			statusChildren.length = 0;
		}),
		addChild: vi.fn((child: unknown) => {
			statusChildren.push(child);
		}),
		disposeChildren: vi.fn(() => disposeChildren(statusChildren)),
	};
	const context = {
		isInitialized: true,
		updateEditorTopBorder: vi.fn(),
		loadingAnimation: undefined as Loader | undefined,
		autoCompactionLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryLoader: undefined,
		retryEscapeHandler: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map<string, unknown>(),
		ui: { requestRender: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		statusContainer,
		statusLine: { invalidate: vi.fn() },
		editor: { getText: () => "", onEscape: undefined },
		ensureLoadingAnimation: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
		showWarning: vi.fn(),
		showError: vi.fn(),
		sessionManager: { getSessionName: () => undefined },
		session: {
			isCompacting: false,
			isStreaming: options.isStreaming,
			abortCompaction: vi.fn(),
			abortRetry: vi.fn(),
		},
	} as unknown as InteractiveModeContext;

	if (options.withSpinner) {
		context.loadingAnimation = { stop: vi.fn() } as unknown as Loader;
	}

	return { context, controller: new EventController(context) };
}

describe("EventController spinner across compaction and retry", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("stops and releases the working spinner when auto-compaction starts", async () => {
		const { context, controller } = createHarness({ isStreaming: true, withSpinner: true });
		const spinner = context.loadingAnimation;

		await controller.handleEvent({
			type: "auto_compaction_start",
			reason: "requested",
			action: "context-full",
		});

		expect(spinner?.stop).toHaveBeenCalled();
		expect(context.loadingAnimation).toBeUndefined();
	});

	it("restores the working spinner after compaction while a prompt is in flight", async () => {
		const { context, controller } = createHarness({ isStreaming: true, withSpinner: false });

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			skipped: true,
			willRetry: false,
		});

		expect(context.ensureLoadingAnimation).toHaveBeenCalled();
	});

	it("leaves the spinner off after compaction when the session is idle", async () => {
		const { context, controller } = createHarness({ isStreaming: false, withSpinner: false });

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			skipped: true,
			willRetry: false,
		});

		expect(context.ensureLoadingAnimation).not.toHaveBeenCalled();
	});

	it("keeps the central Escape handler installed when auto-compaction starts", async () => {
		const { context, controller } = createHarness({ isStreaming: true, withSpinner: false });
		const centralEscapeHandler = vi.fn();
		context.editor.onEscape = centralEscapeHandler;

		await controller.handleEvent({
			type: "auto_compaction_start",
			reason: "requested",
			action: "context-full",
		});

		expect(context.editor.onEscape).toBe(centralEscapeHandler);
	});

	it("stops the working spinner on retry start and restores it after a successful retry", async () => {
		const { context, controller } = createHarness({ isStreaming: true, withSpinner: true });
		const spinner = context.loadingAnimation;

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "overloaded",
		});
		expect(spinner?.stop).toHaveBeenCalled();
		expect(context.loadingAnimation).toBeUndefined();

		await controller.handleEvent({
			type: "auto_retry_end",
			attempt: 1,
			success: true,
		});
		expect(context.ensureLoadingAnimation).toHaveBeenCalled();
	});

	it("keeps the central Escape handler installed when auto-retry starts", async () => {
		const { context, controller } = createHarness({ isStreaming: true, withSpinner: false });
		const centralEscapeHandler = vi.fn();
		context.editor.onEscape = centralEscapeHandler;

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "overloaded",
		});

		expect(context.editor.onEscape).toBe(centralEscapeHandler);
	});
});
