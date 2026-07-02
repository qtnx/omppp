import { afterEach, describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { JobTool, type JobToolDetails } from "@oh-my-pi/pi-coding-agent/tools/job";

const managers: AsyncJobManager[] = [];

type PollWaitSetting = "5s" | "block";

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	managers.push(manager);
	return manager;
}

function createToolSession(args: {
	manager: AsyncJobManager;
	pollWaitDuration?: PollWaitSetting;
	hasPendingAgentAsides?: () => boolean;
}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: {
			get: (key: string) => (key === "async.pollWaitDuration" ? (args.pollWaitDuration ?? "block") : undefined),
		},
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => null,
		asyncJobManager: args.manager,
		hasPendingAgentAsides: args.hasPendingAgentAsides,
		// JobTool touches only these ToolSession members in this focused test.
	} as unknown as ToolSession;
}

function resultText(result: AgentToolResult<JobToolDetails>): string {
	const first = result.content[0];
	if (first?.type !== "text") throw new Error("Expected text result");
	return first.text;
}

function registerAbortableJob(manager: AsyncJobManager): string {
	return manager.register("bash", "never finishes", async ({ signal }) => {
		const released = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => released.resolve(), { once: true });
		await released.promise;
		return "cancelled by test";
	});
}

async function disposeManagers(): Promise<void> {
	for (const manager of managers.splice(0)) {
		manager.cancelAll();
		await manager.dispose({ timeoutMs: 500 });
	}
	AsyncJobManager.resetForTests();
}

afterEach(async () => {
	await disposeManagers();
});

describe("job poll blocking", () => {
	test("poll blocks until a watched job settles", async () => {
		const manager = createManager();
		const jobId = manager.register("bash", "delayed result", async () => {
			// Real timers are intentional: this regression test verifies JobTool's wall-clock wait contract.
			await Bun.sleep(300);
			return "finished after delay";
		});
		const tool = new JobTool(createToolSession({ manager }));

		const startedAt = Date.now();
		const result = await tool.execute("tool-call", { poll: [jobId] });
		const elapsed = Date.now() - startedAt;
		const text = resultText(result);

		expect(elapsed).toBeGreaterThanOrEqual(250);
		expect(text).toContain("## Completed (1)");
		expect(text).toContain("finished after delay");
		expect(text).not.toContain("Still Running");
	}, 10_000);

	test("poll blocks indefinitely without a window", async () => {
		const manager = createManager();
		const jobId = registerAbortableJob(manager);
		const tool = new JobTool(createToolSession({ manager, hasPendingAgentAsides: () => false }));
		const poll = tool.execute("tool-call", { poll: [jobId] });

		// Real timer race is intentional: it proves block mode has no short timeout window.
		const early = await Promise.race([
			poll.then(() => "resolved" as const),
			Bun.sleep(1_500).then(() => "pending" as const),
		]);
		expect(early).toBe("pending");

		manager.cancel(jobId);
		const result = await poll;
		const text = resultText(result);
		expect(text).toContain("## Completed (1)");
		expect(text).toContain("cancelled");
	}, 10_000);

	test("poll wakes when pending agent asides arrive", async () => {
		const manager = createManager();
		const jobId = registerAbortableJob(manager);
		const readyAt = Date.now() + 600;
		const tool = new JobTool(
			createToolSession({
				manager,
				hasPendingAgentAsides: () => Date.now() >= readyAt,
			}),
		);

		const startedAt = Date.now();
		const result = await tool.execute("tool-call", { poll: [jobId] });
		const elapsed = Date.now() - startedAt;
		const text = resultText(result);

		expect(elapsed).toBeGreaterThanOrEqual(550);
		expect(elapsed).toBeLessThan(5_000);
		expect(text).toContain("## Still Running (1)");
	}, 10_000);

	test("poll returns immediately when asides are already pending", async () => {
		const manager = createManager();
		const jobId = registerAbortableJob(manager);
		// The flag reads true only on the very first call — the upfront check
		// before the wait starts. Later 500ms-interval reads see false, so the
		// poll can only resolve (within the test timeout) via that upfront
		// check. No wall-clock bound: load-independent by construction.
		let asideReads = 0;
		const tool = new JobTool(createToolSession({ manager, hasPendingAgentAsides: () => ++asideReads === 1 }));

		const result = await tool.execute("tool-call", { poll: [jobId] });
		const text = resultText(result);

		expect(text).toContain("## Still Running (1)");
	}, 5_000);

	test("abort signal ends the wait", async () => {
		const manager = createManager();
		const jobId = registerAbortableJob(manager);
		const tool = new JobTool(createToolSession({ manager, hasPendingAgentAsides: () => false }));
		const controller = new AbortController();
		const abortLater = async () => {
			// Real timer is intentional: this verifies prompt return on AbortSignal during a blocking poll.
			await Bun.sleep(200);
			controller.abort();
		};

		void abortLater();
		const startedAt = Date.now();
		const result = await tool.execute("tool-call", { poll: [jobId] }, controller.signal);
		const elapsed = Date.now() - startedAt;
		const text = resultText(result);

		expect(elapsed).toBeGreaterThanOrEqual(150);
		expect(elapsed).toBeLessThan(1_500);
		expect(text).toContain("## Still Running (1)");
	}, 10_000);

	test("fixed wait window still caps the wait", async () => {
		const manager = createManager();
		const jobId = registerAbortableJob(manager);
		const tool = new JobTool(
			createToolSession({ manager, pollWaitDuration: "5s", hasPendingAgentAsides: () => false }),
		);

		const startedAt = Date.now();
		const result = await tool.execute("tool-call", { poll: [jobId] });
		const elapsed = Date.now() - startedAt;
		const text = resultText(result);

		expect(elapsed).toBeGreaterThanOrEqual(4_500);
		expect(elapsed).toBeLessThan(8_000);
		expect(text).toContain("## Still Running (1)");
	}, 15_000);
});
