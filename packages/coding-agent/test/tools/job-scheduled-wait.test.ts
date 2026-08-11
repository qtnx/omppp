import { afterEach, describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import type { Settings } from "../../src/config/settings";
import type { AgentProgress } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { isWaitingPollDetails, JobTool, type JobToolDetails, setJobLiveStatsProvider } from "../../src/tools/job";

type ScheduledSettingsOptions = {
	pollWaitDuration?: string;
	stallThresholdMs?: number;
};

afterEach(() => {
	setJobLiveStatsProvider(undefined);
	vi.restoreAllMocks();
	vi.useRealTimers();
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

function createSettings(options: ScheduledSettingsOptions = {}): Settings {
	return createNoopProxy<Settings>({
		get(key: string) {
			if (key === "advisor.enabled") return false;
			if (key === "async.pollWaitDuration") return options.pollWaitDuration ?? "scheduled";
			if (key === "async.stallThresholdMs") return options.stallThresholdMs;
			if (key === "contextPromotion.enabled") return false;
			return undefined;
		},
		getGroup() {
			return {};
		},
	});
}

function createToolSession(manager: AsyncJobManager, settings: Settings): ToolSession {
	return createNoopProxy({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		asyncJobManager: manager,
	}) as unknown as ToolSession;
}

function registerControlledJob(manager: AsyncJobManager, id: string) {
	const finish = Promise.withResolvers<string>();
	manager.register("task", `scheduled job ${id}`, async () => finish.promise, { id });
	return finish;
}

type PromiseOutcome<T> = { type: "fulfilled"; value: T } | { type: "rejected"; error: unknown };

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

function trackOutcome<T>(promise: Promise<T>): () => PromiseOutcome<T> | undefined {
	let outcome: PromiseOutcome<T> | undefined;
	promise.then(
		value => {
			outcome = { type: "fulfilled", value };
		},
		error => {
			outcome = { type: "rejected", error };
		},
	);
	return () => outcome;
}

function expectFulfilled<T>(outcome: PromiseOutcome<T> | undefined, message: string): T {
	if (!outcome) throw new Error(message);
	if (outcome.type === "rejected") throw outcome.error;
	return outcome.value;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function expectSingleJob(
	result: { details?: JobToolDetails },
	id: string,
	status: JobToolDetails["jobs"][number]["status"],
): JobToolDetails["jobs"][number] {
	const details = result.details;
	expect(details).toBeDefined();
	if (!details) throw new Error("Expected job tool details");
	expect(details.jobs).toHaveLength(1);
	expect(details.jobs[0]?.id).toBe(id);
	expect(details.jobs[0]?.status).toBe(status);
	const job = details.jobs[0];
	if (!job) throw new Error("Expected one job snapshot");
	return job;
}

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "scheduled-stalled-job",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "scheduled stalled job",
		recentTools: [],
		recentOutput: [],
		toolCount: 2,
		requests: 1,
		tokens: 125,
		inputTokens: 100,
		outputTokens: 25,
		cost: 0,
		durationMs: 1_000,
		resolvedModel: "test/model",
		...overrides,
	};
}

describe("JobTool scheduled poll windows", () => {
	test("returns a still-running snapshot after one scheduled window and escalates the next window", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		manager.configurePollSchedule({ ladderMs: [30, 60], resetMs: 5_000 });
		registerControlledJob(manager, "job-scheduled-running");
		const tool = new JobTool(createToolSession(manager, createSettings()));

		const firstPromise = tool.execute("call-scheduled-running-1", { poll: ["job-scheduled-running"] });
		const firstOutcome = trackOutcome(firstPromise);
		await flushMicrotasks();

		vi.advanceTimersByTime(29);
		await flushMicrotasks();
		expect(firstOutcome()).toBeUndefined();

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		const first = expectFulfilled(firstOutcome(), "first scheduled window did not resolve after 30ms");

		expectSingleJob(first, "job-scheduled-running", "running");
		expect(isWaitingPollDetails(first.details)).toBe(true);
		expect(first.useless).toBe(true);
		expect(textOf(first)).toContain("Wait window elapsed");
		expect(textOf(first)).toContain("The next `job poll` waits up to");

		const secondPromise = tool.execute("call-scheduled-running-2", { poll: ["job-scheduled-running"] });
		const secondOutcome = trackOutcome(secondPromise);
		await flushMicrotasks();

		vi.advanceTimersByTime(59);
		await flushMicrotasks();
		expect(secondOutcome()).toBeUndefined();

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		const second = expectFulfilled(secondOutcome(), "second scheduled window did not resolve after 60ms");

		expectSingleJob(second, "job-scheduled-running", "running");
		expect(isWaitingPollDetails(second.details)).toBe(true);
		expect(textOf(second)).toContain("Wait window elapsed");
	});

	test("returns completed output when a job settles inside the scheduled window", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		manager.configurePollSchedule({ ladderMs: [60, 120], resetMs: 5_000 });
		const finish = registerControlledJob(manager, "job-scheduled-completes");
		const tool = new JobTool(createToolSession(manager, createSettings()));

		const resultPromise = tool.execute("call-scheduled-completes", { poll: ["job-scheduled-completes"] });
		const outcome = trackOutcome(resultPromise);
		await flushMicrotasks();
		vi.advanceTimersByTime(10);
		await flushMicrotasks();
		expect(outcome()).toBeUndefined();

		finish.resolve("completed inside window");
		await flushMicrotasks();
		const result = expectFulfilled(outcome(), "completed job did not resolve before the 60ms window elapsed");
		expectSingleJob(result, "job-scheduled-completes", "completed");
		expect(textOf(result)).toContain("## Completed (1)");
		expect(textOf(result)).toContain("completed inside window");
		expect(textOf(result)).not.toContain("Wait window elapsed");
	});

	test("returns immediately when a running task reports a provider rate limit", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		manager.configurePollSchedule({ ladderMs: [30_000, 60_000], resetMs: 5_000 });
		const finish = Promise.withResolvers<string>();
		const progressReporter =
			Promise.withResolvers<(text: string, details?: Record<string, unknown>) => Promise<void>>();
		manager.register(
			"task",
			"rate-limited task",
			async ({ reportProgress }) => {
				progressReporter.resolve(reportProgress);
				return finish.promise;
			},
			{ id: "job-rate-limited", agentId: "job-rate-limited" },
		);
		const tool = new JobTool(createToolSession(manager, createSettings()));
		const resultPromise = tool.execute("call-rate-limited", { poll: ["job-rate-limited"] });
		const outcome = trackOutcome(resultPromise);
		await flushMicrotasks();

		try {
			const reportProgress = await progressReporter.promise;
			await reportProgress("provider backoff", {
				progress: [
					createProgress({
						id: "job-rate-limited",
						retryState: {
							attempt: 1,
							maxAttempts: 3,
							delayMs: 60_000,
							errorMessage: "429 Too Many Requests retry-after-ms=60000",
							startedAtMs: Date.now(),
							rateLimited: true,
						},
					}),
				],
			});
			await flushMicrotasks();

			const result = expectFulfilled(outcome(), "rate-limit progress did not wake the scheduled job poll");
			expectSingleJob(result, "job-rate-limited", "running");
			expect(textOf(result)).toContain("<system-notification>");
			expect(textOf(result)).toContain("NEVER wait on or spawn more subagents");
			expect(textOf(result)).not.toContain("Wait window elapsed");
		} finally {
			finish.resolve("done");
			await manager.getJob("job-rate-limited")!.promise;
		}
	});

	test("returns immediately when rate-limit progress predates the poll", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		manager.configurePollSchedule({ ladderMs: [30_000, 60_000], resetMs: 5_000 });
		const finish = Promise.withResolvers<string>();
		const progressReporter =
			Promise.withResolvers<(text: string, details?: Record<string, unknown>) => Promise<void>>();
		manager.register(
			"task",
			"already rate-limited task",
			async ({ reportProgress }) => {
				progressReporter.resolve(reportProgress);
				return finish.promise;
			},
			{ id: "job-rate-limited-before-poll", agentId: "job-rate-limited-before-poll" },
		);
		const reportProgress = await progressReporter.promise;
		await reportProgress("provider backoff", {
			progress: [
				createProgress({
					id: "job-rate-limited-before-poll",
					retryState: {
						attempt: 1,
						maxAttempts: 3,
						delayMs: 60_000,
						errorMessage: "429 Too Many Requests retry-after-ms=60000",
						startedAtMs: Date.now(),
						rateLimited: true,
					},
				}),
			],
		});
		const tool = new JobTool(createToolSession(manager, createSettings()));

		try {
			const result = await tool.execute("call-rate-limited-before-poll", {
				poll: ["job-rate-limited-before-poll"],
			});
			expectSingleJob(result, "job-rate-limited-before-poll", "running");
			expect(textOf(result)).toContain("Task delegation is paused");
			expect(textOf(result)).not.toContain("Wait window elapsed");
		} finally {
			finish.resolve("done");
			await manager.getJob("job-rate-limited-before-poll")!.promise;
		}
	});

	test("marks stale live stats as stalled in scheduled wait snapshots", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		manager.configurePollSchedule({ ladderMs: [30, 60], resetMs: 5_000 });
		registerControlledJob(manager, "job-scheduled-stalled");
		setJobLiveStatsProvider(jobId =>
			jobId === "job-scheduled-stalled" ? { progress: createProgress(), lastUpdate: Date.now() - 1_000 } : undefined,
		);
		const tool = new JobTool(createToolSession(manager, createSettings({ stallThresholdMs: 10 })));

		const resultPromise = tool.execute("call-scheduled-stalled", { poll: ["job-scheduled-stalled"] });
		const outcome = trackOutcome(resultPromise);
		await flushMicrotasks();
		vi.advanceTimersByTime(30);
		await flushMicrotasks();
		const result = expectFulfilled(outcome(), "stalled scheduled window did not resolve after 30ms");

		const job = expectSingleJob(result, "job-scheduled-stalled", "running");
		expect(job.stalled).toBe(true);
		expect(textOf(result)).toContain("STALLED");
	});

	test("does not mark stale live stats as stalled when stall detection is disabled", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		manager.configurePollSchedule({ ladderMs: [30, 60], resetMs: 5_000 });
		registerControlledJob(manager, "job-scheduled-not-stalled");
		setJobLiveStatsProvider(jobId =>
			jobId === "job-scheduled-not-stalled"
				? { progress: createProgress(), lastUpdate: Date.now() - 1_000 }
				: undefined,
		);
		const tool = new JobTool(createToolSession(manager, createSettings({ stallThresholdMs: 0 })));

		const resultPromise = tool.execute("call-scheduled-not-stalled", { poll: ["job-scheduled-not-stalled"] });
		const outcome = trackOutcome(resultPromise);
		await flushMicrotasks();
		vi.advanceTimersByTime(30);
		await flushMicrotasks();
		const result = expectFulfilled(outcome(), "disabled-stall scheduled window did not resolve after 30ms");

		const job = expectSingleJob(result, "job-scheduled-not-stalled", "running");
		expect(job.stalled).toBeUndefined();
		expect(textOf(result)).not.toContain(" — STALLED:");
	});
});
