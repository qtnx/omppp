import { afterEach, describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

const KEY_ENV = "TYPESAFE_API_KEY";
const MODEL_ENV = "TYPESAFE_MODEL";

const originalKey = Bun.env[KEY_ENV];
const originalModel = Bun.env[MODEL_ENV];

afterEach(() => {
	if (originalKey === undefined) delete Bun.env[KEY_ENV];
	else Bun.env[KEY_ENV] = originalKey;
	if (originalModel === undefined) delete Bun.env[MODEL_ENV];
	else Bun.env[MODEL_ENV] = originalModel;
});

function createRuntimeHarness() {
	const showStatus = vi.fn();
	const showError = vi.fn();
	const setText = vi.fn();
	const ctx = {
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		session: {
			getDuoStatus: () => ({
				phase: "executing",
				planner: "anthropic/claude-fable-5-1",
				executor: "anthropic/claude-opus-5",
				takeoverCount: 0,
				executionScope: "multi",
				advisorPaused: false,
			}),
			getOrchestratorModeState: () => ({ enabled: true }),
		} as unknown as InteractiveModeContext["session"],
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;
	return { runtime: { ctx }, showStatus, showError, setText };
}

describe("/duo status Jev debug line", () => {
	it("reports the effective Jev model without leaking the key", async () => {
		Bun.env[KEY_ENV] = "test-key-not-a-secret";
		Bun.env[MODEL_ENV] = "jev-test-model";
		const harness = createRuntimeHarness();

		await executeBuiltinSlashCommand("/duo status", harness.runtime);

		const text = harness.showStatus.mock.calls.at(-1)?.[0] as string;
		expect(text).toContain("Duo: executing — planner anthropic/claude-fable-5-1");
		expect(text).toContain("Jev: on — model jev-test-model (TYPESAFE_MODEL)");
		expect(text).not.toContain("test-key-not-a-secret");
	});

	it("reports why tab.act is unavailable when the key is unset", async () => {
		delete Bun.env[KEY_ENV];
		const harness = createRuntimeHarness();

		await executeBuiltinSlashCommand("/duo status", harness.runtime);

		const text = harness.showStatus.mock.calls.at(-1)?.[0] as string;
		expect(text).toContain("Jev: off — TYPESAFE_API_KEY unset");
	});
});
