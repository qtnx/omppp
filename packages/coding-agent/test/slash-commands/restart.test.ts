import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const restart = vi.fn(async () => {});
	const setText = vi.fn();
	return {
		restart,
		setText,
		runtime: {
			ctx: {
				restart,
				editor: { setText } as unknown as InteractiveModeContext["editor"],
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/restart slash command", () => {
	it("restarts the process without clearing the draft first", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/restart", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.restart).toHaveBeenCalledTimes(1);
		expect(harness.setText).not.toHaveBeenCalled();
	});
});
