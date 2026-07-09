import { afterEach, describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { disableAnnotateHttp } from "../../src/tools/browser/annotate-http";

function createRuntimeHarness(options?: { host?: string; port?: number }) {
	const output = vi.fn();
	const enqueue = vi.fn();
	const settings = {
		get: vi.fn((path: string) => {
			if (path === "browser.annotateHttpHost") return options?.host ?? "256.256.256.256";
			if (path === "browser.annotateHttpPort") return options?.port ?? 65_535;
			return undefined;
		}),
	};
	const setText = vi.fn();
	const session = {
		sessionName: "Annotate allocation test",
		sessionId: "session-annotate-allocation",
		yieldQueue: { enqueue },
	};
	const runtime = {
		output,
		session,
		settings,
		ctx: {
			session,
			sessionManager: { getCwd: vi.fn(() => "/tmp") },
			settings,
			editor: { setText },
			showStatus: output,
			refreshSlashCommandState: vi.fn(),
			refreshPluginState: vi.fn(async () => {}),
		} as unknown as InteractiveModeContext,
	};

	return { enqueue, output, runtime, session };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/annotate slash command", () => {
	it("consumes allocation failures and reports the failed configured port", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/annotate on", harness.runtime);

		expect(result).toBe(true);
		const message = harness.output.mock.calls.map(call => String(call[0])).join("\n");
		expect(message).toContain("Annotation intake failed");
		expect(message).toContain("65535");
		expect(harness.enqueue).not.toHaveBeenCalled();
	});

	it("uses the session object as the dispose key for the final annotate HTTP registration", async () => {
		const harness = createRuntimeHarness({ host: "127.0.0.1", port: 38_480 });
		const stop = vi.fn(async () => {});
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(((options: { hostname?: string; port?: number }) => {
			return {
				hostname: options.hostname ?? "127.0.0.1",
				port: options.port ?? 0,
				stop,
			} as unknown as Bun.Server<undefined>;
		}) as typeof Bun.serve);

		const result = await executeBuiltinSlashCommand("/annotate on", harness.runtime);
		const disabledBySession = await disableAnnotateHttp(harness.session as object);
		if (!disabledBySession) {
			await executeBuiltinSlashCommand("/annotate off", harness.runtime);
		}
		serveSpy.mockRestore();

		expect(result).toBe(true);
		expect(disabledBySession).toBe(true);
		expect(stop).toHaveBeenCalledWith(true);
	});
});
