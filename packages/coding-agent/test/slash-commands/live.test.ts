import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleLiveCommand = vi.fn(async () => {});
	const setText = vi.fn();
	return {
		handleLiveCommand,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleLiveCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/live slash command", () => {
	it("routes --remote to the bridged live handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/live --remote", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleLiveCommand).toHaveBeenCalledWith({ remote: true, forwardCredentials: false });
	});
});
