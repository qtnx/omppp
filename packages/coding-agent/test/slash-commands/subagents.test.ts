import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(options?: { collabGuest?: boolean }) {
	const setText = vi.fn();
	const showAgentHub = vi.fn();
	const showStatus = vi.fn();
	return {
		setText,
		showAgentHub,
		showStatus,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showAgentHub,
				showStatus,
				collabGuest: options?.collabGuest ? {} : undefined,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/subagents slash command", () => {
	it("opens the live Agent Hub and clears the editor", async () => {
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/subagents", harness.runtime)).toBe(true);

		expect(harness.showAgentHub).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("opens the Agent Hub for a collab guest", async () => {
		// Guests may inspect the host's mirrored agent registry through the local hub.
		const harness = createRuntimeHarness({ collabGuest: true });

		expect(await executeBuiltinSlashCommand("/subagents", harness.runtime)).toBe(true);

		expect(harness.showStatus).not.toHaveBeenCalledWith("/subagents is host-only during a collab session");
		expect(harness.showAgentHub).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
