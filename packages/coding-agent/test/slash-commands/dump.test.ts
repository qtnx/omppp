import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness() {
	const handleDumpCommand = vi.fn(async () => {});
	const setText = vi.fn();

	const ctx = {
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		handleDumpCommand,
	} as unknown as InteractiveModeContext;

	return {
		runtime: {
			ctx,
			handleBackgroundCommand: () => {},
		},
		handleDumpCommand,
		setText,
	};
}

describe("/dump slash command", () => {
	it("accepts copy as an explicit clipboard subcommand", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/dump copy", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.handleDumpCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("accepts colon syntax for the copy subcommand", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/dump:copy", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.handleDumpCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("passes unknown dump arguments through as prompt text", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/dump explain this", harness.runtime);

		expect(result).toBe("/dump explain this");
		expect(harness.handleDumpCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
	});
});
