import { afterEach, describe, expect, test } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";

const managers: AsyncJobManager[] = [];

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	managers.push(manager);
	return manager;
}

function createTool(manager: AsyncJobManager): WaitTool {
	return new WaitTool({
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "launch.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession);
}

function registerAbortableJob(manager: AsyncJobManager): string {
	return manager.register("bash", "never finishes", async ({ signal }) => {
		const released = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => released.resolve(), { once: true });
		await released.promise;
		return "cancelled by test";
	});
}

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		manager.cancelAll();
		await manager.dispose({ timeoutMs: 500 });
	}
	AsyncJobManager.resetForTests();
});

describe("wait blocking", () => {
	test("wait blocks until a running job settles and returns its result", async () => {
		const manager = createManager();
		const finish = Promise.withResolvers<string>();
		const id = manager.register("bash", "delayed result", async () => finish.promise);
		const wait = createTool(manager).execute("tool-call", {});
		let settled = false;
		void wait.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		finish.resolve("finished after delay");
		const result = await wait;
		expect(result.details?.jobs?.map(job => job.id)).toContain(id);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("finished after delay") });
	});

	test("interrupt abort returns without consuming a running job", async () => {
		const manager = createManager();
		const id = registerAbortableJob(manager);
		const controller = new AbortController();
		const wait = createTool(manager).execute("tool-call", {}, controller.signal);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await wait;
		expect(result.details).toMatchObject({ op: "wait", interrupted: true });
		expect(manager.getJob(id)?.status).toBe("running");
	});
});
