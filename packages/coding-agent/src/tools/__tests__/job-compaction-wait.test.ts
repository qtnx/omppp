import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import type { Agent, AgentMessage, SessionEntry } from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "../../async";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import type { ToolSession } from "../index";
import { JobTool } from "../job";

const model = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8192,
});

const compactionSettings: compaction.CompactionSettings = {
	enabled: true,
	strategy: "context-full",
	thresholdPercent: 80,
	thresholdTokens: 80_000,
	reserveTokens: 15_000,
	keepRecentTokens: 10_000,
	midTurnEnabled: true,
	autoContinue: false,
	remoteEnabled: false,
	remoteEndpoint: undefined,
};

type PromiseOutcome<T> = { type: "fulfilled"; value: T } | { type: "rejected"; error: unknown };

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function resolveAfterMicrotasks<T>(promise: Promise<T>, message: string): Promise<T> {
	let outcome: PromiseOutcome<T> | undefined;
	promise.then(
		value => {
			outcome = { type: "fulfilled", value };
		},
		error => {
			outcome = { type: "rejected", error };
		},
	);
	for (let i = 0; i < 1000 && !outcome; i++) {
		await Promise.resolve();
	}
	if (!outcome) throw new Error(message);
	if (outcome.type === "rejected") throw outcome.error;
	return outcome.value;
}

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

function createSettings(): Settings {
	return createNoopProxy<Settings>({
		get(key: string) {
			if (key === "advisor.enabled") return false;
			if (key === "async.pollWaitDuration") return "block";
			if (key === "contextPromotion.enabled") return false;
			if (key === "async.pollWatchdogMs") return 100;
			return undefined;
		},
		getGroup(key: string) {
			if (key === "compaction") return compactionSettings;
			return {};
		},
	});
}

function createPreparedCompaction(): compaction.CompactionPreparation {
	return {
		firstKeptEntryId: "first-kept",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: compaction.createFileOps(),
		settings: compactionSettings,
	};
}

function createAgentSession(manager: AsyncJobManager): AgentSession {
	const agent = createNoopProxy({
		state: {
			messages: [{ role: "user", content: "hello".repeat(100), timestamp: Date.now() } as AgentMessage],
			systemPrompt: [],
			model,
			tools: [],
		},
		subscribe: () => () => undefined,
		peekSteeringQueue: () => [],
		peekFollowUpQueue: () => [],
	}) as unknown as Agent;
	const sessionManager = createNoopProxy({
		getBranch: () => [] as SessionEntry[],
		getEntries: () => [] as SessionEntry[],
		getSessionFile: () => undefined,
		buildSessionContext: () => ({
			messages: agent.state.messages,
			systemPrompt: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
		}),
	}) as unknown as SessionManager;
	return new AgentSession({
		agent,
		sessionManager,
		settings: createSettings(),
		modelRegistry: createNoopProxy<ModelRegistry>({}),
		asyncJobManager: manager,
		persistInitialMCPToolSelection: false,
	});
}

function createToolSession(session: AgentSession, manager: AsyncJobManager): ToolSession {
	return createNoopProxy({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: session.settings,
		asyncJobManager: manager,
		considerCompactionWhileWaiting: (reason: string) => session.considerCompactionWhileWaiting(reason),
	}) as unknown as ToolSession;
}

async function runPoll(session: AgentSession, manager: AsyncJobManager): Promise<string> {
	const finish = Promise.withResolvers<string>();
	manager.register("task", "waited job", async () => finish.promise, { id: "job-1" });
	const tool = new JobTool(createToolSession(session, manager));
	const resultPromise = tool.execute("call-1", { poll: ["job-1"] });
	finish.resolve("done");
	const result = await resultPromise;
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

async function runPollBeforeCompletion(
	session: AgentSession,
	manager: AsyncJobManager,
): Promise<{ text: string; statuses: string[]; useless: boolean }> {
	const finish = Promise.withResolvers<string>();
	manager.register("task", "waited job", async () => finish.promise, { id: "job-1" });
	const tool = new JobTool(createToolSession(session, manager));
	const resultPromise = tool.execute("call-1", { poll: ["job-1"] });
	try {
		const result = await resolveAfterMicrotasks(
			resultPromise,
			"job poll did not return before the deterministic watchdog advanced",
		);
		const first = result.content[0];
		const details = result.details;
		if (!details) throw new Error("Expected job poll details");
		return {
			text: first?.type === "text" ? first.text : "",
			statuses: details.jobs.map(job => job.status),
			useless: result.useless === true,
		};
	} finally {
		finish.resolve("done");
		await resultPromise.catch(() => undefined);
	}
}

describe("JobTool wait compaction scheduling", () => {
	test("schedules exactly once when waiting compaction threshold is met", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		const session = createAgentSession(manager);
		spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction());
		spyOn(compaction, "shouldCompact").mockReturnValue(true);
		const requestSpy = spyOn(session, "requestCompactionFromAgent");

		await runPoll(session, manager);

		expect(requestSpy).toHaveBeenCalledTimes(1);
	});

	test("does not schedule when waiting compaction threshold is not met", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		const session = createAgentSession(manager);
		spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction());
		spyOn(compaction, "shouldCompact").mockReturnValue(false);
		const requestSpy = spyOn(session, "requestCompactionFromAgent");

		await runPoll(session, manager);

		expect(requestSpy).toHaveBeenCalledTimes(0);
	});

	test("returns promptly with a running snapshot when waiting compaction is scheduled", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		const session = createAgentSession(manager);
		spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction());
		spyOn(compaction, "shouldCompact").mockReturnValue(true);
		vi.useFakeTimers();

		const result = await runPollBeforeCompletion(session, manager);

		expect(result.statuses).toEqual(["running"]);
		expect(result.useless).toBe(true);
		expect(result.text).toContain("[compaction scheduled while waiting — running at next boundary]");
		expect(result.text).toContain("## Still Running (1)");
	});

	test("adds a visible note when waiting compaction is scheduled", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		const session = createAgentSession(manager);
		spyOn(compaction, "prepareCompaction").mockReturnValue(createPreparedCompaction());
		spyOn(compaction, "shouldCompact").mockReturnValue(true);

		const text = await runPoll(session, manager);

		expect(text).toContain("[compaction scheduled while waiting — running at next boundary]");
	});
});
