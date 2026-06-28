import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

async function flushMicrotasks(turns = 12): Promise<void> {
	for (let i = 0; i < turns; i += 1) {
		await Promise.resolve();
	}
}

function resolveLocalPromptFile(mode: InteractiveMode, filePath = "local://LOOP_PROMPT.md"): string {
	return resolveLocalUrlToPath(filePath, {
		getArtifactsDir: () => mode.sessionManager.getArtifactsDir(),
		getSessionId: () => mode.sessionManager.getSessionId(),
	});
}

describe("InteractiveMode loop auto-submit", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-auto-submit-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.disableLoopMode("Loop mode disabled.");
		mode?.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("waits the configured interval before auto-submitting the next loop prompt", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });

		await mode.handleLoopCommand("2s 3");
		mode.loopPrompt = "repeat slowly";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		vi.advanceTimersByTime(1_999);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat slowly");

		void mode.getUserInput().then(input => resolved.push(input));
		vi.advanceTimersByTime(1_999);
		await flushMicrotasks();
		expect(resolved).toHaveLength(1);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(resolved).toHaveLength(2);
		expect(resolved[1].text).toBe("repeat slowly");
	});

	it("does not resolve the next loop prompt while compaction is running", async () => {
		vi.useFakeTimers();
		let compacting = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		await mode.handleLoopCommand("2s");
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		compacting = false;
		vi.advanceTimersByTime(99);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat this");
	});

	it("does not recompact when a compact loop turn starts another prompt before resubmitting", async () => {
		vi.useFakeTimers();
		settings.set("loop.mode", "compact");
		let streaming = false;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const compact = vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			streaming = true;
			return "ok";
		});

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat after compact";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(0);

		streaming = false;
		vi.advanceTimersByTime(100);
		await flushMicrotasks();

		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat after compact");
	});

	it("does not resolve the next loop prompt while post-prompt background work is pending", async () => {
		vi.useFakeTimers();
		let hasPendingWork = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => hasPendingWork });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "deliver this";
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		// Loop timer fires while an idle-flush / delivery turn is still pending.
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		// Background delivery completes; loop may now fire.
		hasPendingWork = false;
		vi.advanceTimersByTime(100);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("deliver this");
	});

	it("locks only the first loop prompt into a session-local prompt file", async () => {
		await mode.handleLoopCommand("2s");

		await mode.captureLoopPrompt("first repeat prompt");
		await mode.captureLoopPrompt("later chat should not replace it");

		expect(mode.loopPromptFilePath).toBe("local://LOOP_PROMPT.md");
		expect(await Bun.file(resolveLocalPromptFile(mode)).text()).toBe("first repeat prompt");
	});

	it("overwrites an untracked default prompt file on first capture", async () => {
		await Bun.write(resolveLocalPromptFile(mode), "stale scratch content");
		await mode.handleLoopCommand("2s");

		await mode.captureLoopPrompt("fresh first prompt");

		expect(await Bun.file(resolveLocalPromptFile(mode)).text()).toBe("fresh first prompt");
	});
	it("uses the prompt file contents for later loop iterations", async () => {
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });

		await mode.handleLoopCommand("1ms");
		await mode.captureLoopPrompt("first repeat prompt");
		await Bun.write(resolveLocalPromptFile(mode), "model-approved prompt update");

		const input = await mode.getUserInput();

		expect(input.text).toBe("model-approved prompt update");
	});

	it("lets pause recapture the next prompt into the same prompt file", async () => {
		await mode.handleLoopCommand("2s");
		await mode.captureLoopPrompt("first prompt");
		mode.pauseLoop();

		await mode.captureLoopPrompt("replacement prompt");

		expect(mode.loopPromptFilePath).toBe("local://LOOP_PROMPT.md");
		expect(await Bun.file(resolveLocalPromptFile(mode)).text()).toBe("replacement prompt");
	});

	it("persists pause as inactive until a replacement prompt is captured", async () => {
		await mode.handleLoopCommand("2s");
		await mode.captureLoopPrompt("first prompt");

		mode.pauseLoop();

		expect(mode.sessionManager.buildSessionContext().mode).toBe("none");
	});
	it("reactivates the previous loop prompt file instead of creating a new prompt", async () => {
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });

		await mode.handleLoopCommand("1ms");
		await mode.captureLoopPrompt("persistent repeat prompt");
		mode.disableLoopMode();
		await mode.handleLoopCommand("1ms");
		await mode.captureLoopPrompt("new chat should not become the repeat prompt");

		const input = await mode.getUserInput();

		expect(mode.loopPromptFilePath).toBe("local://LOOP_PROMPT.md");
		expect(input.text).toBe("persistent repeat prompt");
	});

	it("auto-submits a reused prompt file when loop is re-enabled while input is idle", async () => {
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });

		await mode.handleLoopCommand("1ms");
		await mode.captureLoopPrompt("idle reuse prompt");
		mode.disableLoopMode();
		const inputPromise = mode.getUserInput();

		await mode.handleLoopCommand("1ms");

		const input = await inputPromise;
		expect(input.text).toBe("idle reuse prompt");
	});

	it("preserves the prompt file across reset-mode loop iterations", async () => {
		settings.set("loop.mode", "reset");
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });

		await mode.handleLoopCommand("1ms");
		await mode.captureLoopPrompt("reset survives");
		const originalSessionId = mode.sessionManager.getSessionId();

		const input = await mode.getUserInput();

		expect(mode.sessionManager.getSessionId()).not.toBe(originalSessionId);
		expect(input.text).toBe("reset survives");
		expect(await Bun.file(resolveLocalPromptFile(mode)).text()).toBe("reset survives");
	});
});
