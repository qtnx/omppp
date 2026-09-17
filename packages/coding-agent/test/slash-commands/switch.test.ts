import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const MODELS = [
	{ provider: "anthropic", id: "claude-opus-4-5", contextWindow: 200_000 },
	{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
	{ provider: "openai", id: "gpt-5.2", contextWindow: 400_000 },
];

function createRuntime(options?: { reasoning?: boolean; thinkingLevel?: string }) {
	const showModelSelector = vi.fn();
	const switchSessionModel = vi.fn(async () => {});
	const setModel = vi.fn(async () => {});
	const setThinkingLevel = vi.fn();
	const showError = vi.fn();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const settings = Settings.isolated();
	const reasoning = options?.reasoning ?? true;
	return {
		showModelSelector,
		switchSessionModel,
		setModel,
		setThinkingLevel,
		showError,
		showStatus,
		setText,
		settings,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				settings,
				session: {
					scopedModels: [],
					modelRegistry: { getAll: () => MODELS, getAvailable: () => MODELS },
					model: { provider: "anthropic", id: "claude-sonnet-4-5", reasoning },
					setModel,
					setThinkingLevel,
					configuredThinkingLevel: () => options?.thinkingLevel ?? "medium",
				},
				showModelSelector,
				switchSessionModel,
				showError,
				showStatus,
				statusLine: { invalidate: vi.fn() },
				ui: { requestRender: vi.fn() },
			} as unknown as InteractiveModeContext,
		},
	};
}

function createAcpRuntime(options?: { reasoning?: boolean; thinkingLevel?: string }) {
	const output = vi.fn(async () => {});
	const setModel = vi.fn(async () => {});
	const setThinkingLevel = vi.fn();
	const settings = Settings.isolated();
	const reasoning = options?.reasoning ?? true;
	return {
		output,
		setModel,
		setThinkingLevel,
		runtime: {
			output,
			settings,
			session: {
				scopedModels: [],
				modelRegistry: { getAll: () => MODELS, getAvailable: () => MODELS },
				model: { provider: "anthropic", id: "claude-sonnet-4-5", reasoning },
				setModel,
				setThinkingLevel,
				configuredThinkingLevel: () => options?.thinkingLevel ?? "medium",
			},
		} as unknown as SlashCommandRuntime,
	};
}

describe("/model slash command", () => {
	it("opens the model setup picker for role and thinking assignment", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector.mock.calls).toEqual([[]]);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/model sonnet:high fuzzy-resolves and sets the session model with the thinking suffix", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model sonnet:high", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setModel).toHaveBeenCalledWith(MODELS[1]);
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(harness.showModelSelector).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("Model set to anthropic/claude-sonnet-4-5.");
	});

	it("/model unknown surfaces an error without opening the picker or switching", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/model nope-9000", harness.runtime);

		expect(harness.showError).toHaveBeenCalledWith("Unknown model: nope-9000");
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});
});

describe("/switch slash command", () => {
	it("opens the temporary model selector (mirrors alt+p)", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/switch sonnet:high fuzzy-resolves and switches session-only with the thinking suffix", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch sonnet:high", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.switchSessionModel).toHaveBeenCalledWith(MODELS[1], "high");
		expect(harness.showModelSelector).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/switch @smol resolves the configured role alias", async () => {
		const harness = createRuntime();
		harness.settings.setModelRole("smol", "openai/gpt-5.2");

		await executeBuiltinSlashCommand("/switch @smol", harness.runtime);

		expect(harness.switchSessionModel).toHaveBeenCalledWith(MODELS[2], undefined);
	});

	it("/switch unknown surfaces an error without opening the picker or switching", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/switch nope-9000", harness.runtime);

		expect(harness.showError).toHaveBeenCalledWith("Unknown model: nope-9000");
		expect(harness.switchSessionModel).not.toHaveBeenCalled();
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});
});

describe("/effort slash command", () => {
	it("reports the current thinking level when invoked without args", async () => {
		const harness = createRuntime({ thinkingLevel: "medium" });

		const handled = await executeBuiltinSlashCommand("/effort", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("Thinking level is medium.");
	});

	it("/effort high sets the session thinking level", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/effort high", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(harness.showStatus).toHaveBeenCalledWith("Thinking level set to high.");
	});

	it("/effort min expands the unambiguous abbreviation", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/effort min", harness.runtime);

		expect(harness.setThinkingLevel).toHaveBeenCalledWith("minimal");
	});

	it("/effort bogus surfaces usage without changing the level", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/effort bogus", harness.runtime);

		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("Usage: /effort [off|minimal|low|medium|high|xhigh|max|auto]");
	});

	it("refuses to set thinking when the current model has no reasoning", async () => {
		const harness = createRuntime({ reasoning: false });

		await executeBuiltinSlashCommand("/effort high", harness.runtime);

		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("Current model does not support thinking");
	});

	it("ACP /effort high sets the session thinking level", async () => {
		const harness = createAcpRuntime();

		const result = await executeAcpBuiltinSlashCommand("/effort high", harness.runtime);

		expect(result).toEqual({ consumed: true });
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(harness.output).toHaveBeenCalledWith("Thinking level set to high.");
	});
});
