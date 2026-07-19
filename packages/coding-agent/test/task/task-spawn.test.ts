/**
 * Contracts: task tool spawn routing (rework-contracts.md §3).
 *
 * 1. With an AsyncJobManager wired, `execute` returns immediately (agent id +
 *    job id) while the job body is still gated; job completion delivers a
 *    result carrying the irc follow-up / `history://<id>` hint.
 * 2. The session-scoped spawn semaphore (task.maxConcurrency) serializes job
 *    bodies: with concurrency 1 the second body does not start until the
 *    first releases.
 *
 * Param validation (missing agent / missing task) is covered by
 * test/task/task-schema.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type AgentDefinition,
	type AgentProgress,
	getTaskSchema,
	type SingleResult,
	type TaskParams,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type } from "arktype";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function skill(name: string, description: string, source: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source,
	};
}

function createSession(options: {
	manager?: AsyncJobManager;
	settings?: Record<string, unknown>;
	skills?: Skill[];
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: options.manager,
		skills: options.skills ?? [],
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function makeProgress(id: string, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "task prompt",
		assignment: "Do the thing.",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		durationMs: 5,
		...overrides,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

describe("task spawn routing", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("accepts only nonnegative integer max_runtime_seconds values in the flat schema", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false });

		for (const value of [undefined, 0, 1, 600]) {
			const input = value === undefined ? { task: "Work." } : { task: "Work.", max_runtime_seconds: value };
			const parsed = schema(input);
			expect(parsed instanceof type.errors).toBe(false);
			if (!(parsed instanceof type.errors) && value !== undefined) {
				expect("max_runtime_seconds" in parsed).toBe(true);
				if ("max_runtime_seconds" in parsed) {
					expect(parsed.max_runtime_seconds).toBe(value);
				}
			}
		}

		for (const value of [-1, 0.5, Number.POSITIVE_INFINITY]) {
			expect(schema({ task: "Work.", max_runtime_seconds: value }) instanceof type.errors).toBe(true);
		}
	});

	it("forwards a flat runtime cap in milliseconds and preserves an explicit zero override", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const seen: number[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push(options.maxRuntimeMs ?? -1);
			return makeResult(options.id ?? "?");
		});

		const tool = await TaskTool.create(
			createSession({
				settings: {
					"async.enabled": false,
					"task.batch": false,
					"task.maxRuntimeMs": 90_000,
				},
			}),
		);

		await tool.execute("tc-runtime-positive", {
			agent: "task",
			name: "Positive",
			task: "Work.",
			max_runtime_seconds: 12,
		} as TaskParams);
		await tool.execute("tc-runtime-zero", {
			agent: "task",
			name: "Unlimited",
			task: "Work.",
			max_runtime_seconds: 0,
		} as TaskParams);

		expect(seen).toEqual([12_000, 0]);
	});

	it("returns immediately on spawn and delivers the follow-up hint when the job completes", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const gate = deferred();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const result = await tool.execute("tc-spawn", {
			agent: "task",
			name: "Spawnling",
			task: "Do the thing.",
		} as TaskParams);

		// Tool returned while the job body is still gated on the deferred.
		const text = getFirstText(result);
		expect(text).toContain("Spawned agent `Spawnling`");
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		expect(text).toContain(`job \`${jobId}\``);
		const job = manager.getJob(jobId!);
		expect(job?.status).toBe("running");
		expect(job?.resultText).toBeUndefined();

		gate.resolve();
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(job!.resultText).toContain("Spawnling is now idle");
		expect(job!.resultText).toContain("message it via `hub` to follow up");
		expect(job!.resultText).toContain("history://Spawnling");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces terminal rate limits and blocks subsequent delegation", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const rateLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"account rate limit"}} retry-after-ms=11180000';
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id ?? "?", {
				exitCode: 1,
				output: "",
				stderr: rateLimitError,
				error: rateLimitError,
				retryFailure: {
					attempt: 1,
					errorMessage: rateLimitError,
					rateLimited: true,
					retryAfterMs: 11_180_000,
				},
			}),
		);
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const first = await tool.execute("tc-rate-limit", {
			agent: "task",
			name: "RateLimited",
			task: "Hit the provider.",
		} as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await firstJob.promise;

		expect(firstJob.status).toBe("failed");
		expect(firstJob.errorText).toContain("<system-notification>");
		expect(firstJob.errorText).toContain("Task delegation is paused");
		expect(firstJob.errorText).toContain("NEVER wait on or spawn more subagents");

		const blocked = await tool.execute("tc-rate-limit-follow-up", {
			agent: "task",
			name: "ShouldNotSpawn",
			task: "Do not start.",
		} as TaskParams);
		expect(getFirstText(blocked)).toContain("Task delegation is paused");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("allows subsequent delegation after terminal rate limits without a usable retry delay", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const rateLimitError = "429 Too Many Requests";
		const retryAfterValues: Array<number | undefined> = [undefined, 0];
		let runCount = 0;
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const currentRun = runCount++;
			if (currentRun % 2 === 0) {
				const retryAfterMs = retryAfterValues[currentRun / 2];
				return makeResult(options.id ?? "?", {
					exitCode: 1,
					output: "",
					stderr: rateLimitError,
					error: rateLimitError,
					retryFailure: {
						attempt: 1,
						errorMessage: rateLimitError,
						rateLimited: true,
						...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
					},
				});
			}
			return makeResult(options.id ?? "?");
		});
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		for (const [index, retryAfterMs] of retryAfterValues.entries()) {
			const label = retryAfterMs === undefined ? "absent" : "zero";
			const first = await tool.execute(`tc-rate-limit-${label}`, {
				agent: "task",
				name: `RateLimited-${label}`,
				task: "Hit the provider.",
			} as TaskParams);
			const firstJob = manager.getJob(first.details!.async!.jobId)!;
			await firstJob.promise;

			expect(firstJob.status).toBe("failed");
			expect(firstJob.errorText).toContain(rateLimitError);
			expect(firstJob.errorText).not.toContain("Task delegation is paused");

			const followUp = await tool.execute(`tc-rate-limit-${label}-follow-up`, {
				agent: "task",
				name: `AllowedSpawn-${label}`,
				task: "Start the next task.",
			} as TaskParams);
			expect(getFirstText(followUp)).toContain(`Spawned agent \`AllowedSpawn-${label}\``);
			await manager.getJob(followUp.details!.async!.jobId)!.promise;
			expect(runSpy).toHaveBeenCalledTimes((index + 1) * 2);
		}
	});

	it("blocks new delegation while a child is backing off on a rate limit", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const release = deferred();
		const retryReported = Promise.withResolvers<void>();
		const rateLimitError = "429 Too Many Requests retry-after-ms=60000";
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			options.onProgress?.(
				makeProgress(id, {
					retryState: {
						attempt: 1,
						maxAttempts: 3,
						delayMs: 60_000,
						errorMessage: rateLimitError,
						startedAtMs: Date.now(),
						rateLimited: true,
					},
				}),
			);
			retryReported.resolve();
			await release.promise;
			options.onProgress?.(makeProgress(id));
			return makeResult(id);
		});
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const first = await tool.execute("tc-live-rate-limit", {
			agent: "task",
			name: "BackingOff",
			task: "Wait on the provider.",
		} as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await retryReported.promise;

		try {
			const blocked = await tool.execute("tc-live-rate-limit-follow-up", {
				agent: "task",
				name: "ShouldNotSpawnLive",
				task: "Do not start.",
			} as TaskParams);
			expect(getFirstText(blocked)).toContain("Task delegation is paused");
			expect(runSpy).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve();
			await firstJob.promise;
		}
		const resumed = await tool.execute("tc-live-rate-limit-recovered", {
			agent: "task",
			name: "RecoveredSpawn",
			task: "Start after recovery.",
		} as TaskParams);
		expect(getFirstText(resumed)).toContain("Spawned agent `RecoveredSpawn`");
		await manager.getJob(resumed.details!.async!.jobId)!.promise;
		expect(runSpy).toHaveBeenCalledTimes(2);
	});

	it("autoloads bundled frontend skills plus matching repo skills for design agents", async () => {
		const designAgent: AgentDefinition = {
			name: "designer",
			description: "Design lead",
			systemPrompt: "You are a design agent.",
			source: "bundled",
			model: ["pi/designer"],
			autoloadSkills: ["frontend-design", "frontend-accessibility", "frontend-ui-copy"],
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [designAgent],
			projectAgentsDir: null,
		});
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Design"));
		const skills = [
			skill("frontend-design", "Bundled frontend design", "bundled:native"),
			skill("frontend-accessibility", "Bundled accessibility", "bundled:native"),
			skill("frontend-ui-copy", "Bundled UI copy", "bundled:native"),
			skill("repo-design-system", "Project design tokens and designer workflow", "project"),
			skill("backend-rust", "Database migrations", "project"),
		];

		const tool = await TaskTool.create(
			createSession({ skills, settings: { modelRoles: { designer: "custom/designer" } } }),
		);
		await tool.execute("tc-design", {
			agent: "designer",
			id: "Design",
			assignment: "Design the thing.",
		} as TaskParams);

		const [options] = runSpy.mock.calls[0]!;
		expect(options.modelOverride).toEqual(["custom/designer"]);
		expect(options.autoloadSkills?.map(item => item.name)).toEqual([
			"frontend-design",
			"frontend-accessibility",
			"frontend-ui-copy",
			"repo-design-system",
		]);
	});

	it("bounds concurrent job bodies with the session spawn semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First job body reaches the executor; second stays parked at the
		// semaphore — still flagged queued because markRunning never ran.
		await pollUntil(() => started.length >= 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing the first body lets the second one start.
		gates.get(started[0]!)!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
		expect(firstJob.status).toBe("completed");
		expect(secondJob.status).toBe("completed");
	});

	it("settles a cancelled spawn while it is queued behind the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		await pollUntil(() => started.length === 1);
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		const queuedResult = await Promise.race([
			secondJob.promise.then(() => "settled" as const),
			Bun.sleep(75).then(() => "timeout" as const),
		]);

		gates.get("First")!.resolve();
		await firstJob.promise;
		await secondJob.promise;

		expect(queuedResult).toBe("settled");
		expect(started).toEqual(["First"]);
		expect(secondJob.status).toBe("cancelled");
	});

	it("keeps the concurrency cap intact when a queued spawn is cancelled (no permit leak)", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		// A holds the only permit, gated inside the executor.
		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		await pollUntil(() => started.length === 1);

		// B parks at the semaphore, then is cancelled while queued. Its
		// teardown must NOT release a permit it never acquired.
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;
		expect(secondJob.queued).toBe(true);
		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;
		expect(secondJob.status).toBe("cancelled");

		// C must stay parked while A still holds the cap. A phantom release
		// from B's cancellation would admit C here, running 2 bodies at cap 1.
		const third = await tool.execute("tc-3", { agent: "task", name: "Third", task: "Work C." } as TaskParams);
		const thirdJob = manager.getJob(third.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First"]);
		expect(thirdJob.queued).toBe(true);

		// A finishing admits C — the cap still cycles normally.
		gates.get("First")!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Third"]);

		// D queued behind running C stays serialized: if B's teardown had
		// double-released, two permits would be free and D would start now.
		const fourth = await tool.execute("tc-4", { agent: "task", name: "Fourth", task: "Work D." } as TaskParams);
		const fourthJob = manager.getJob(fourth.details!.async!.jobId)!;
		await Bun.sleep(50);
		expect(started).toEqual(["First", "Third"]);
		expect(fourthJob.queued).toBe(true);

		gates.get("Third")!.resolve();
		await thirdJob.promise;
		await pollUntil(() => started.length === 3);
		gates.get("Fourth")!.resolve();
		await fourthJob.promise;

		expect(started).toEqual(["First", "Third", "Fourth"]);
		expect(firstJob.status).toBe("completed");
		expect(thirdJob.status).toBe("completed");
		expect(fourthJob.status).toBe("completed");
	});

	for (const maxConcurrency of [0, 0.5]) {
		it(`runs spawn job bodies unbounded when task.maxConcurrency is ${maxConcurrency}`, async () => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [taskAgent],
				projectAgentsDir: null,
			});
			const started: string[] = [];
			const gates = new Map<string, Deferred>();
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				const id = options.id ?? "?";
				started.push(id);
				const gate = deferred();
				gates.set(id, gate);
				await gate.promise;
				return makeResult(id);
			});

			const manager = createManager();
			const tool = await TaskTool.create(
				createSession({ manager, settings: { "task.maxConcurrency": maxConcurrency } }),
			);

			const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
			const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
			const third = await tool.execute("tc-3", { agent: "task", name: "Third", task: "Work C." } as TaskParams);

			// All three job bodies clear the spawn semaphore in parallel — none stays queued.
			await pollUntil(() => started.length === 3);
			expect(started.sort()).toEqual(["First", "Second", "Third"]);

			for (const id of ["First", "Second", "Third"]) gates.get(id)!.resolve();
			await Promise.all([
				manager.getJob(first.details!.async!.jobId)!.promise,
				manager.getJob(second.details!.async!.jobId)!.promise,
				manager.getJob(third.details!.async!.jobId)!.promise,
			]);
		});
	}

	it("re-reads task.maxConcurrency on each spawn so a mid-session change applies on the next acquire", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		// Prime the semaphore at the initial high cap.
		const first = await tool.execute("tc-1", { agent: "task", name: "First", task: "Work A." } as TaskParams);
		await pollUntil(() => started.length === 1);

		// Tighten the cap mid-session. The next spawn MUST see the new ceiling.
		settings.override("task.maxConcurrency", 1);
		const second = await tool.execute("tc-2", { agent: "task", name: "Second", task: "Work B." } as TaskParams);
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First is still running (and holding the only slot under the new cap),
		// so Second is parked at the semaphore — queued, not running.
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		// Releasing First admits Second.
		gates.get("First")!.resolve();
		await manager.getJob(first.details!.async!.jobId)!.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
	});

	it("applies a lowered maxConcurrency to work already queued in the semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const settings = Settings.isolated({ "task.maxConcurrency": 4 });
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as unknown as ToolSession);

		const jobs: AsyncJob[] = [];
		for (const id of ["First", "Second", "Third", "Fourth", "Fifth"]) {
			const result = await tool.execute(`tc-${id}`, { agent: "task", name: id, task: `Work ${id}.` } as TaskParams);
			jobs.push(manager.getJob(result.details!.async!.jobId)!);
		}
		const fifthJob = jobs[4]!;

		await pollUntil(() => started.length === 4);
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		settings.override("task.maxConcurrency", 1);
		gates.get("First")!.resolve();
		await jobs[0]!.promise;
		await Promise.resolve();
		expect([...started].sort()).toEqual(["First", "Fourth", "Second", "Third"]);
		expect(fifthJob.queued).toBe(true);

		for (const id of ["Second", "Third", "Fourth"]) gates.get(id)!.resolve();
		await pollUntil(() => started.length === 5);
		expect([...started].sort()).toEqual(["Fifth", "First", "Fourth", "Second", "Third"]);

		gates.get("Fifth")!.resolve();
		await Promise.all(jobs.map(job => job.promise));
	});
});
