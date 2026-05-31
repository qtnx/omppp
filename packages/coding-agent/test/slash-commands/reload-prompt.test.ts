import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const refreshBaseSystemPrompt = vi.fn(async () => {});
	const showStatus = vi.fn();
	const setText = vi.fn();
	const invalidate = vi.fn();
	const updateEditorTopBorder = vi.fn();
	const requestRender = vi.fn();
	return {
		refreshBaseSystemPrompt,
		showStatus,
		setText,
		invalidate,
		updateEditorTopBorder,
		requestRender,
		runtime: {
			ctx: {
				session: { refreshBaseSystemPrompt } as unknown as InteractiveModeContext["session"],
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				statusLine: { invalidate } as unknown as InteractiveModeContext["statusLine"],
				updateEditorTopBorder,
				showStatus,
				ui: { requestRender } as unknown as InteractiveModeContext["ui"],
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/reload-prompt slash command", () => {
	it("refreshes the base system prompt and rerenders prompt-dependent UI", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/reload-prompt", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(harness.invalidate).toHaveBeenCalledTimes(1);
		expect(harness.updateEditorTopBorder).toHaveBeenCalledTimes(1);
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith("System prompt reloaded.");
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
