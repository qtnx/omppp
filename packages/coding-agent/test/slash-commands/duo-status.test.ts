import { afterEach, describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

const KEY_ENV = "TYPESAFE_API_KEY";
const MODEL_ENV = "TYPESAFE_MODEL";
const ENDPOINT_ENV = "TYPESAFE_SYSTEMONE_URL";

const original: Record<string, string | undefined> = {
	[KEY_ENV]: Bun.env[KEY_ENV],
	[MODEL_ENV]: Bun.env[MODEL_ENV],
	[ENDPOINT_ENV]: Bun.env[ENDPOINT_ENV],
};

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete Bun.env[name];
	else Bun.env[name] = value;
}

afterEach(() => {
	for (const [name, value] of Object.entries(original)) setEnv(name, value);
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

async function duoStatusText(): Promise<string> {
	const harness = createRuntimeHarness();
	await executeBuiltinSlashCommand("/duo status", harness.runtime);
	return harness.showStatus.mock.calls.at(-1)?.[0] as string;
}

describe("/duo status Jev debug line", () => {
	it("reports the overridden model and the local key without echoing it", async () => {
		setEnv(KEY_ENV, "test-key-not-a-secret");
		setEnv(MODEL_ENV, "jev-test-model");
		setEnv(ENDPOINT_ENV, undefined);

		const text = await duoStatusText();

		expect(text).toContain("Duo: executing — planner anthropic/claude-fable-5-1");
		expect(text).toContain("Jev: model jev-test-model (TYPESAFE_MODEL)");
		expect(text).toContain("endpoint http://codemc:8791/v1/systemone (proxy default)");
		expect(text).toContain("key TYPESAFE_API_KEY");
		expect(text).not.toContain("test-key-not-a-secret");
		expect(text).not.toContain("hidden from browser docs");
	});

	it("reports the proxy-held key and the docs gate when no local key is set", async () => {
		setEnv(KEY_ENV, undefined);
		setEnv(MODEL_ENV, undefined);
		setEnv(ENDPOINT_ENV, undefined);

		const text = await duoStatusText();

		expect(text).toContain("Jev: model jev-latest (default)");
		expect(text).toContain("key held by the proxy");
		expect(text).toContain("tab.act hidden from browser docs (TYPESAFE_API_KEY unset)");
	});

	it("flags a direct endpoint that has no key to send", async () => {
		setEnv(KEY_ENV, undefined);
		setEnv(ENDPOINT_ENV, "https://api.typesafe.ai/v1/systemone");

		const text = await duoStatusText();

		expect(text).toContain("endpoint https://api.typesafe.ai/v1/systemone (TYPESAFE_SYSTEMONE_URL)");
		expect(text).toContain("no key — TYPESAFE_API_KEY unset and the endpoint is not the proxy");
	});
});
