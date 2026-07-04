import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../../async";
import type { Settings } from "../../config/settings";
import type { ToolSession } from "../index";
import { JobTool, type JobToolDetails } from "../job";

type MockHandle = { mockRestore(): void };
const handles: MockHandle[] = [];

afterEach(() => {
	for (const handle of handles.splice(0)) handle.mockRestore();
});

function createNoopProxy<T extends object>(overrides: Record<string, unknown>): T {
	return new Proxy(overrides, {
		get(target, prop) {
			if (typeof prop === "string" && prop in target) return target[prop];
			return () => undefined;
		},
		set(target, prop, value) {
			if (typeof prop === "string") target[prop] = value;
			return true;
		},
	}) as T;
}

function createSettings(pollWaitDuration: string, pollWatchdogMs: number): Settings {
	return createNoopProxy<Settings>({
		get(key: string) {
			if (key === "advisor.enabled") return false;
			if (key === "async.pollWaitDuration") return pollWaitDuration;
			if (key === "async.pollWatchdogMs") return pollWatchdogMs;
			if (key === "contextPromotion.enabled") return false;
			return undefined;
		},
		getGroup() {
			return {};
		},
	});
}

function createToolSession(
	manager: AsyncJobManager,
	settings: Settings,
	hasPendingAgentAsides?: () => boolean,
): ToolSession {
	return createNoopProxy({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		asyncJobManager: manager,
		...(hasPendingAgentAsides ? { hasPendingAgentAsides } : {}),
	}) as unknown as ToolSession;
}

function registerControlledJob(manager: AsyncJobManager, id: string) {
	const finish = Promise.withResolvers<string>();
	manager.register("task", `waited job ${id}`, async () => finish.promise, { id });
	return finish;
}

async function expectStillPending<T>(promise: Promise<T>, sleepMs: number): Promise<void> {
	let settled = false;
	promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await Bun.sleep(sleepMs);
	expect(settled).toBe(false);
}

async function expectResolvesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	const timeout = Bun.sleep(timeoutMs).then(() => {
		throw new Error(`Timed out after ${timeoutMs}ms`);
	});
	return Promise.race([promise, timeout]);
}

function expectSingleJob(
	result: { details?: JobToolDetails },
	id: string,
	status: JobToolDetails["jobs"][number]["status"],
): void {
	const details = result.details;
	expect(details).toBeDefined();
	if (!details) throw new Error("Expected job tool details");
	expect(details.jobs).toHaveLength(1);
	expect(details.jobs[0]?.id).toBe(id);
	expect(details.jobs[0]?.status).toBe(status);
}

describe("JobTool block-mode watchdog wait", () => {
	test("watchdog re-enters while the watched job is still running", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		const finish = registerControlledJob(manager, "job-watchdog-running");
		const tool = new JobTool(createToolSession(manager, createSettings("block", 20)));

		const resultPromise = tool.execute("call-watchdog-running", { poll: ["job-watchdog-running"] });

		await expectStillPending(resultPromise, 120);
		finish.resolve("done");
		const result = await expectResolvesWithin(resultPromise, 500);

		expectSingleJob(result, "job-watchdog-running", "completed");
		const first = result.content[0];
		expect(first?.type === "text" ? first.text : "").toContain("## Completed (1)");
	});

	test("dead watched job does not hang when its promise stays unresolved", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		registerControlledJob(manager, "job-watchdog-dead");
		const tool = new JobTool(createToolSession(manager, createSettings("block", 20)));

		const resultPromise = tool.execute("call-watchdog-dead", { poll: ["job-watchdog-dead"] });
		await Bun.sleep(10);
		expect(manager.cancel("job-watchdog-dead")).toBe(true);
		const result = await expectResolvesWithin(resultPromise, 500);

		expectSingleJob(result, "job-watchdog-dead", "cancelled");
	});

	test("watchdog disabled preserves infinite block until the job resolves", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		const finish = registerControlledJob(manager, "job-watchdog-disabled");
		const tool = new JobTool(createToolSession(manager, createSettings("block", 0)));

		const resultPromise = tool.execute("call-watchdog-disabled", { poll: ["job-watchdog-disabled"] });

		await expectStillPending(resultPromise, 120);
		finish.resolve("done");
		const result = await expectResolvesWithin(resultPromise, 500);

		expectSingleJob(result, "job-watchdog-disabled", "completed");
	});

	test("transient aside wake returns control without waiting for watchdog", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		registerControlledJob(manager, "job-watchdog-aside");
		let checks = 0;
		const tool = new JobTool(
			createToolSession(manager, createSettings("block", 60_000), () => {
				checks++;
				return checks === 1;
			}),
		);

		const result = await expectResolvesWithin(
			tool.execute("call-watchdog-aside", { poll: ["job-watchdog-aside"] }),
			1_000,
		);

		expectSingleJob(result, "job-watchdog-aside", "running");
	});

	test("fixed-duration poll is single-shot", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		registerControlledJob(manager, "job-watchdog-fixed");
		const tool = new JobTool(createToolSession(manager, createSettings("5s", 20)));

		const result = await expectResolvesWithin(
			tool.execute("call-watchdog-fixed", { poll: ["job-watchdog-fixed"] }),
			7_000,
		);

		expectSingleJob(result, "job-watchdog-fixed", "running");
	}, 10_000);
});
