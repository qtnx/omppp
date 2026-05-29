import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import type { AgentDefinition, SingleResult, TaskParams } from "../../src/task/types";
import type { DeltaPatchResult, IsolationHandle, WorktreeBaseline } from "../../src/task/worktree";
import * as worktreeModule from "../../src/task/worktree";
import type { ToolSession } from "../../src/tools";
import "../../src/tools/yield";
import { EventBus } from "../../src/utils/event-bus";

// --- Constants ----------------------------------------------------------------

const TASK_PARAMS: TaskParams = {
	agent: "task",
	tasks: [{ id: "FixBug", description: "Fix the bug", assignment: "Implement the fix end-to-end." }],
};

const IMPLEMENTER_AGENT = "task";
const REVIEWER_AGENT = "code-reviewer";
const FIXER_AGENT = "code-fixer";

// --- Role queue ---------------------------------------------------------------

type ReviewerFinding = {
	title: string;
	body: string;
	priority: 0 | 1 | 2 | 3;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
};

type ReviewerVerdict = {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
};

type RoleScript =
	| { role: "implementer" }
	| { role: "fixer" }
	| { role: "reviewer"; verdict?: ReviewerVerdict; yieldData?: unknown; findings?: ReviewerFinding[] };

interface AgentCallTrace {
	agentName: string;
	role: RoleScript["role"];
}

// --- Mock helpers -------------------------------------------------------------

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createScriptedSession(script: RoleScript): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield", "report_finding"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			state.messages.push(createAssistantStopMessage(script.role));

			if (script.role === "reviewer") {
				for (const finding of script.findings ?? []) {
					emit({
						type: "tool_execution_end",
						toolCallId: `report-${finding.title}`,
						toolName: "report_finding",
						result: {
							content: [{ type: "text", text: "Finding recorded" }],
							details: {
								title: finding.title,
								body: finding.body,
								priority: `P${finding.priority}` as const,
								confidence: finding.confidence,
								file_path: finding.file_path,
								line_start: finding.line_start,
								line_end: finding.line_end,
							},
						},
						isError: false,
					});
				}
				const yieldData = script.verdict ?? script.yieldData;
				if (yieldData !== undefined) {
					emit({
						type: "tool_execution_end",
						toolCallId: `yield-reviewer`,
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: yieldData },
						},
						isError: false,
					});
				}
				return;
			}

			emit({
				type: "tool_execution_end",
				toolCallId: `yield-${script.role}`,
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { applied: true, role: script.role } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function mockDiscoveredAgents(agents: AgentDefinition[]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents,
		projectAgentsDir: null,
	});
}

function mockAgents(): void {
	mockDiscoveredAgents([
		{
			name: IMPLEMENTER_AGENT,
			description: "Implementer agent",
			systemPrompt: "Implement the assignment.",
			source: "bundled",
		},
		{
			name: REVIEWER_AGENT,
			description: "Reviewer agent",
			systemPrompt: "Review the patch.",
			source: "bundled",
		},
		{
			name: FIXER_AGENT,
			description: "Fixer agent",
			systemPrompt: "Address reviewer findings.",
			source: "bundled",
		},
	]);
}

/**
 * Maps each subsequent `createAgentSession` call to the next role in `script`.
 * Records every (agentName, role) pair in `trace` for assertions about call order.
 *
 * The mapping from createAgentSession's `agent` option to the script role is
 * derived from the agent's `name`: implementer/reviewer/fixer agent names are
 * fixed above. We rely on positional ordering when names coincide.
 */
function mockSessionQueue(script: RoleScript[]): {
	trace: AgentCallTrace[];
	calls: () => CreateAgentSessionOptions[];
} {
	const trace: AgentCallTrace[] = [];
	const captured: CreateAgentSessionOptions[] = [];
	let cursor = 0;

	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
		captured.push(options);
		const step = script[cursor];
		if (!step) {
			throw new Error(`No scripted session for createAgentSession call #${cursor + 1}`);
		}
		cursor += 1;
		const agentName = options.agentDisplayName ?? "unknown";
		trace.push({ agentName, role: step.role });
		return {
			session: createScriptedSession(step),
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});

	return { trace, calls: () => captured };
}

interface IsolationMocks {
	captureDeltaPatch: ReturnType<typeof vi.spyOn>;
	commitToBranch: ReturnType<typeof vi.spyOn>;
	cleanupIsolation: ReturnType<typeof vi.spyOn>;
}

function mockIsolation(options: { captureError?: Error; captureResults?: DeltaPatchResult[] } = {}): IsolationMocks {
	const baseline: WorktreeBaseline = {
		root: {
			repoRoot: "/repo",
			headCommit: "HEAD",
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	};
	const isolationHandle: IsolationHandle = {
		mergedDir: "/tmp/isolated-subagent",
		backend: worktreeModule.parseIsolationMode("rcopy")!,
		fellBack: false,
		fallbackReason: null,
	};

	vi.spyOn(worktreeModule, "getRepoRoot").mockResolvedValue("/repo");
	vi.spyOn(worktreeModule, "captureBaseline").mockResolvedValue(baseline);
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue(isolationHandle);
	const captureDeltaPatch = vi.spyOn(worktreeModule, "captureDeltaPatch");
	if (options.captureError) {
		captureDeltaPatch.mockRejectedValue(options.captureError);
	} else if (options.captureResults && options.captureResults.length > 0) {
		let cursor = 0;
		captureDeltaPatch.mockImplementation(async () => {
			const index = Math.min(cursor, options.captureResults!.length - 1);
			cursor += 1;
			return options.captureResults![index]!;
		});
	} else {
		captureDeltaPatch.mockResolvedValue({ rootPatch: "diff --git a/x b/x\n", nestedPatches: [] });
	}
	const commitToBranch = vi
		.spyOn(worktreeModule, "commitToBranch")
		.mockResolvedValue({ branchName: "omp/task/FixBug", nestedPatches: [] });
	const cleanupIsolation = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

	return { captureDeltaPatch, commitToBranch, cleanupIsolation };
}
async function initUnbornStatsRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-gate-unborn-"));
	const proc = Bun.spawn(["git", "init"], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		await fs.rm(repo, { recursive: true, force: true });
		throw new Error(stderr.trim() || stdout.trim() || "git init failed");
	}
	await fs.writeFile(
		path.join(repo, "stats_utils.py"),
		"from collections.abc import Sequence\n\n\ndef median(values: Sequence[float]) -> float:\n\treturn 0.0\n",
	);
	return repo;
}

function createSession(overrides: Partial<Record<string, unknown>> = {}, cwd = "/tmp"): ToolSession {
	const modelRegistry = {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () => [],
		getApiKey: async () => null,
	} as unknown as ModelRegistry;

	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.mode": "auto",
		...overrides,
	} as Parameters<typeof Settings.isolated>[0]);

	return {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		modelRegistry,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function reviewGateSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		"task.reviewGate.enabled": true,
		"task.reviewGate.reviewerAgent": REVIEWER_AGENT,
		"task.reviewGate.fixerAgent": FIXER_AGENT,
		"task.reviewGate.maxFixIterations": 2,
		"task.reviewGate.failOnPriorities": [0, 1],
		"task.reviewGate.requireCorrectVerdict": true,
		...extra,
	};
}

function correctVerdict(): ReviewerVerdict {
	return { overall_correctness: "correct", explanation: "Looks good.", confidence: 0.9 };
}

function incorrectVerdict(): ReviewerVerdict {
	return { overall_correctness: "incorrect", explanation: "Issue found.", confidence: 0.9 };
}

function p1Finding(title = "[P1] Bad branch"): ReviewerFinding {
	return {
		title,
		body: "This branch needs handling.",
		priority: 1,
		confidence: 0.9,
		file_path: "/tmp/example.ts",
		line_start: 10,
		line_end: 12,
	};
}

function p2Finding(title = "[P2] Style nit"): ReviewerFinding {
	return {
		title,
		body: "Naming could be improved.",
		priority: 2,
		confidence: 0.7,
		file_path: "/tmp/example.ts",
		line_start: 8,
		line_end: 8,
	};
}

function delta(rootPatch: string): DeltaPatchResult {
	return { rootPatch, nestedPatches: [] };
}

// --- Tests --------------------------------------------------------------------

function firstResult(result: { details?: { results: SingleResult[] } }): SingleResult {
	const single = result.details?.results[0];
	if (!single) throw new Error("Expected a task result");
	return single;
}

describe("task review gate", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("captures the isolated patch when the reviewer returns a correct verdict on the first pass", async () => {
		mockAgents();
		const isolation = mockIsolation();
		const { trace } = mockSessionQueue([{ role: "implementer" }, { role: "reviewer", verdict: correctVerdict() }]);

		const tool = await TaskTool.create(createSession(reviewGateSettings()));
		const result = await tool.execute("call-correct", { ...TASK_PARAMS, isolated: true });

		expect(trace.map(t => t.role)).toEqual(["implementer", "reviewer"]);
		expect(trace[1]?.agentName).toBe(REVIEWER_AGENT);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(1);
		expect(isolation.cleanupIsolation).toHaveBeenCalledTimes(1);
		expect(firstResult(result).exitCode).toBe(0);
	});

	it("runs exactly one fixer cycle when a P1 finding is reported, then a second reviewer pass", async () => {
		mockAgents();
		const isolation = mockIsolation();
		const { trace } = mockSessionQueue([
			{ role: "implementer" },
			{ role: "reviewer", verdict: incorrectVerdict(), findings: [p1Finding()] },
			{ role: "fixer" },
			{ role: "reviewer", verdict: correctVerdict() },
		]);

		const tool = await TaskTool.create(createSession(reviewGateSettings({ "task.reviewGate.maxFixIterations": 3 })));
		const result = await tool.execute("call-one-fix", { ...TASK_PARAMS, isolated: true });

		expect(trace.map(t => t.role)).toEqual(["implementer", "reviewer", "fixer", "reviewer"]);
		expect(trace[2]?.agentName).toBe(FIXER_AGENT);
		expect(trace[3]?.agentName).toBe(REVIEWER_AGENT);
		// Each reviewer pass captures the current isolated delta; the accepted
		// second pass is reused for final patch output.
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(2);
		expect(isolation.commitToBranch).not.toHaveBeenCalled();
		expect(firstResult(result).exitCode).toBe(0);
	});

	it("fails the task without applying patches or branch merge when blocking findings persist past maxFixIterations", async () => {
		mockAgents();
		const isolation = mockIsolation();
		const { trace } = mockSessionQueue([
			{ role: "implementer" },
			{ role: "reviewer", verdict: incorrectVerdict(), findings: [p1Finding("[P1] First")] },
			{ role: "fixer" },
			{ role: "reviewer", verdict: incorrectVerdict(), findings: [p1Finding("[P1] Second")] },
			{ role: "fixer" },
			{ role: "reviewer", verdict: incorrectVerdict(), findings: [p1Finding("[P1] Third")] },
		]);

		const tool = await TaskTool.create(createSession(reviewGateSettings({ "task.reviewGate.maxFixIterations": 2 })));
		const result = await tool.execute("call-exhausted", { ...TASK_PARAMS, isolated: true });

		// Allowed at most: implementer + (reviewer + fixer) * 2 + final reviewer = 6 sessions.
		// Crucially, no more than 2 fixer runs are scheduled.
		const fixerCount = trace.filter(t => t.role === "fixer").length;
		const reviewerCount = trace.filter(t => t.role === "reviewer").length;
		expect(fixerCount).toBe(2);
		expect(reviewerCount).toBe(3);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(3);
		expect(isolation.commitToBranch).not.toHaveBeenCalled();
		expect(isolation.cleanupIsolation).toHaveBeenCalledTimes(1);
		const single = firstResult(result);
		expect(single?.exitCode).not.toBe(0);
		expect(single?.error ?? single?.stderr ?? "").toMatch(/review|finding/i);
	});

	it("captures the patch when only a P2 finding is reported and failOnPriorities=[0,1]", async () => {
		mockAgents();
		const isolation = mockIsolation();
		const { trace } = mockSessionQueue([
			{ role: "implementer" },
			// Reviewer marks "incorrect" but the only finding is P2, which is not in failOnPriorities.
			{ role: "reviewer", verdict: incorrectVerdict(), findings: [p2Finding()] },
		]);

		const tool = await TaskTool.create(
			createSession(
				reviewGateSettings({
					"task.reviewGate.failOnPriorities": [0, 1],
					// requireCorrectVerdict=false so a non-blocking P2 doesn't trip the gate via verdict alone.
					"task.reviewGate.requireCorrectVerdict": false,
				}),
			),
		);
		const result = await tool.execute("call-p2-only", { ...TASK_PARAMS, isolated: true });

		expect(trace.map(t => t.role)).toEqual(["implementer", "reviewer"]);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(1);
		expect(firstResult(result).exitCode).toBe(0);
	});

	it("fails closed when review diff capture fails", async () => {
		mockAgents();
		const isolation = mockIsolation({ captureError: new Error("delta exploded") });
		const { trace } = mockSessionQueue([{ role: "implementer" }]);

		const tool = await TaskTool.create(createSession(reviewGateSettings()));
		const result = await tool.execute("call-diff-fails", { ...TASK_PARAMS, isolated: true });

		expect(trace.map(t => t.role)).toEqual(["implementer"]);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(1);
		expect(isolation.commitToBranch).not.toHaveBeenCalled();
		expect(isolation.cleanupIsolation).toHaveBeenCalledTimes(1);
		const single = firstResult(result);
		expect(single.exitCode).not.toBe(0);
		expect(single.error ?? single.stderr).toMatch(/review gate.*diff|delta exploded/i);
	});

	it("fails before isolation work when blocking priority config is malformed", async () => {
		mockAgents();
		const isolation = mockIsolation();
		const { trace } = mockSessionQueue([{ role: "implementer" }]);

		const tool = await TaskTool.create(
			createSession(
				reviewGateSettings({
					"task.reviewGate.failOnPriorities": [],
				}),
			),
		);
		const result = await tool.execute("call-bad-priorities", { ...TASK_PARAMS, isolated: true });

		expect(trace).toEqual([]);
		expect(isolation.captureDeltaPatch).not.toHaveBeenCalled();
		expect(isolation.commitToBranch).not.toHaveBeenCalled();
		expect(isolation.cleanupIsolation).not.toHaveBeenCalled();
		const single = firstResult(result);
		expect(single.exitCode).not.toBe(0);
		expect(single.error ?? single.stderr).toMatch(/review gate.*priorit/i);
	});

	it("fails closed when reviewer submits no verdict", async () => {
		mockAgents();
		const isolation = mockIsolation();
		const { trace } = mockSessionQueue([{ role: "implementer" }, { role: "reviewer" }]);

		const tool = await TaskTool.create(
			createSession(
				reviewGateSettings({
					"task.reviewGate.requireCorrectVerdict": false,
				}),
			),
		);
		const result = await tool.execute("call-missing-verdict", { ...TASK_PARAMS, isolated: true });

		expect(trace.map(t => t.role)).toEqual(["implementer", "reviewer"]);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(1);
		expect(isolation.commitToBranch).not.toHaveBeenCalled();
		const single = firstResult(result);
		expect(single.exitCode).not.toBe(0);
		expect(single.error ?? single.stderr).toMatch(/verdict|yield|reviewer agent exited/i);
	});

	it("fails closed when reviewer verdict is incomplete", async () => {
		mockAgents();
		const isolation = mockIsolation();
		const { trace } = mockSessionQueue([
			{ role: "implementer" },
			{ role: "reviewer", yieldData: { overall_correctness: "correct" } },
		]);

		const tool = await TaskTool.create(createSession(reviewGateSettings()));
		const result = await tool.execute("call-incomplete-verdict", { ...TASK_PARAMS, isolated: true });

		expect(trace.map(t => t.role)).toEqual(["implementer", "reviewer"]);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(1);
		expect(isolation.commitToBranch).not.toHaveBeenCalled();
		const single = firstResult(result);
		expect(single.exitCode).not.toBe(0);
		expect(single.error ?? single.stderr).toMatch(/verdict|yield/i);
	});

	it("commits the approved delta in branch mode without recapturing live drift", async () => {
		mockAgents();
		const isolation = mockIsolation({
			captureResults: [delta("diff --git a/x b/x\n+reviewed\n"), delta("diff --git a/x b/x\n+mutated\n")],
		});
		const { trace } = mockSessionQueue([{ role: "implementer" }, { role: "reviewer", verdict: correctVerdict() }]);

		const tool = await TaskTool.create(
			createSession({
				...reviewGateSettings(),
				"task.isolation.merge": "branch",
			}),
		);
		const result = await tool.execute("call-branch-drift", { ...TASK_PARAMS, isolated: true });

		expect(trace.map(t => t.role)).toEqual(["implementer", "reviewer"]);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(1);
		expect(isolation.commitToBranch).toHaveBeenCalledTimes(1);
		expect(isolation.commitToBranch.mock.calls[0]?.[5]).toEqual(delta("diff --git a/x b/x\n+reviewed\n"));
		const single = firstResult(result);
		expect(single.exitCode).toBe(0);
	});

	it("uses the heavy_task native policy to enable a strict review gate even when global reviewGate is off", async () => {
		mockDiscoveredAgents([
			{
				name: "heavy_task",
				description: "Heavy high-accuracy implementer",
				systemPrompt: "Implement heavy delegated work.",
				source: "bundled",
				model: ["pi/task", "pi/slow"],
				reviewGate: {
					enabled: true,
					reviewerAgent: REVIEWER_AGENT,
					reviewerModel: ["openai-codex/gpt-5.5:xhigh"],
					fixerAgent: FIXER_AGENT,
					maxFixIterations: 2,
					failOnPriorities: [0, 1],
					requireCorrectVerdict: true,
				},
			} as unknown as AgentDefinition,
			{
				name: REVIEWER_AGENT,
				description: "Reviewer agent",
				systemPrompt: "Review the patch.",
				source: "bundled",
			},
			{
				name: FIXER_AGENT,
				description: "Fixer agent",
				systemPrompt: "Address reviewer findings.",
				source: "bundled",
			},
		]);
		const isolation = mockIsolation();
		const { trace } = mockSessionQueue([{ role: "implementer" }, { role: "reviewer", verdict: correctVerdict() }]);

		const tool = await TaskTool.create(
			createSession({
				"task.reviewGate.enabled": false,
				"task.reviewGate.reviewerAgent": REVIEWER_AGENT,
				"task.reviewGate.fixerAgent": FIXER_AGENT,
			}),
		);
		const result = await tool.execute("call-heavy-policy", {
			...TASK_PARAMS,
			agent: "heavy_task",
			isolated: true,
		});

		expect(trace.map(t => t.role)).toEqual(["implementer", "reviewer"]);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(1);
		expect(firstResult(result).exitCode).toBe(0);
	});

	it("uses the quick_task native policy to skip review even when global reviewGate is on", async () => {
		mockDiscoveredAgents([
			{
				name: "quick_task",
				description: "Fast worker with no review gate",
				systemPrompt: "Handle fast delegated work.",
				source: "bundled",
				model: ["pi/smol"],
				reviewGate: {
					enabled: false,
				},
			} as unknown as AgentDefinition,
			{
				name: REVIEWER_AGENT,
				description: "Reviewer agent",
				systemPrompt: "Review the patch.",
				source: "bundled",
			},
			{
				name: FIXER_AGENT,
				description: "Fixer agent",
				systemPrompt: "Address reviewer findings.",
				source: "bundled",
			},
		]);
		const isolation = mockIsolation();
		const { trace } = mockSessionQueue([{ role: "implementer" }, { role: "reviewer", verdict: correctVerdict() }]);

		const tool = await TaskTool.create(
			createSession({
				...reviewGateSettings(),
			}),
		);
		const result = await tool.execute("call-quick-policy", {
			...TASK_PARAMS,
			agent: "quick_task",
			isolated: true,
		});

		expect(trace.map(t => t.role)).toEqual(["implementer"]);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(1);
		expect(firstResult(result).exitCode).toBe(0);
	});

	it("runs the gate in the original task context when isolation is disabled", async () => {
		mockAgents();
		const isolation = mockIsolation();
		const { trace, calls } = mockSessionQueue([
			{ role: "implementer" },
			{ role: "reviewer", verdict: correctVerdict() },
		]);

		const tool = await TaskTool.create(
			createSession({
				...reviewGateSettings(),
				"task.isolation.mode": "none",
			}),
		);
		const result = await tool.execute("call-non-isolated-gate", TASK_PARAMS);

		expect(trace.map(t => t.role)).toEqual(["implementer", "reviewer"]);
		expect(calls().map(call => call.cwd)).toEqual(["/tmp", "/tmp"]);
		expect(isolation.captureDeltaPatch).toHaveBeenCalledTimes(1);
		expect(isolation.commitToBranch).not.toHaveBeenCalled();
		expect(isolation.cleanupIsolation).not.toHaveBeenCalled();
		const single = firstResult(result);
		expect(single.exitCode).toBe(0);
		expect(single.reviewGate?.outcome).toBe("passed");
	});
	it("reports missing git repository without labeling non-isolated review gate as isolated execution", async () => {
		mockAgents();
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-gate-no-git-"));
		try {
			const tool = await TaskTool.create(
				createSession(
					{
						...reviewGateSettings(),
						"task.isolation.mode": "none",
					},
					cwd,
				),
			);

			const result = await tool.execute("call-no-git-review-gate", TASK_PARAMS);
			const message = result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(message).toBe("Task review gate requires a git repository. Git repository not found.");
			expect(message).not.toContain("isolated task execution");
			expect(result.details?.results).toEqual([]);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("reviews non-isolated task diffs in an unborn repository", async () => {
		mockAgents();
		const repo = await initUnbornStatsRepo();
		const trace: RoleScript["role"][] = [];
		let reviewerPrompt = "";
		try {
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
				const agentName = options.agentDisplayName ?? "unknown";
				const role: RoleScript["role"] = agentName === REVIEWER_AGENT ? "reviewer" : "implementer";
				const session = createScriptedSession(role === "reviewer" ? { role, verdict: correctVerdict() } : { role });
				const originalPrompt = session.prompt.bind(session);
				session.prompt = async (text: string, promptOptions?: PromptOptions) => {
					trace.push(role);
					if (role === "implementer") {
						await fs.writeFile(
							path.join(repo, "stats_utils.py"),
							"from collections.abc import Sequence\n\n\ndef median(values: Sequence[float]) -> float:\n\treturn 0.0\n\n\ndef mean(values: Sequence[float]) -> float:\n\treturn 0.0\n",
						);
					} else {
						reviewerPrompt = text;
					}
					return originalPrompt(text, promptOptions);
				};
				return {
					session,
					extensionsResult: {} as unknown as LoadExtensionsResult,
					setToolUIContext: () => {},
					eventBus: new EventBus(),
				} satisfies CreateAgentSessionResult;
			});

			const tool = await TaskTool.create(
				createSession(
					{
						...reviewGateSettings(),
						"task.isolation.mode": "none",
					},
					repo,
				),
			);
			const result = await tool.execute("call-unborn-review-gate", TASK_PARAMS);
			const single = firstResult(result);

			expect(trace).toEqual(["implementer", "reviewer"]);
			expect(single.exitCode).toBe(0);
			expect(single.reviewGate?.outcome).toBe("passed");
			expect(reviewerPrompt).toContain("+def mean(values: Sequence[float]) -> float:");
			expect(reviewerPrompt).not.toContain("fatal: Not a valid object name");
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});

	it("honors task max concurrency when non-isolated review gates are enabled", async () => {
		mockAgents();
		mockIsolation();
		const trace: RoleScript["role"][] = [];
		const bothImplementersStarted = Promise.withResolvers<void>();
		let implementerStarts = 0;

		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			const agentName = options.agentDisplayName ?? "unknown";
			const role: RoleScript["role"] = agentName === REVIEWER_AGENT ? "reviewer" : "implementer";
			const session = createScriptedSession(role === "reviewer" ? { role, verdict: correctVerdict() } : { role });
			const originalPrompt = session.prompt.bind(session);
			session.prompt = async (text: string, promptOptions?: PromptOptions) => {
				trace.push(role);
				if (role === "implementer") {
					implementerStarts += 1;
					if (implementerStarts === 2) {
						bothImplementersStarted.resolve();
					}
					await Promise.race([
						bothImplementersStarted.promise,
						Bun.sleep(100).then(() => {
							throw new Error("Second implementer did not start before the first review gate ran.");
						}),
					]);
				}
				return originalPrompt(text, promptOptions);
			};
			return {
				session,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});

		const tool = await TaskTool.create(
			createSession({
				...reviewGateSettings(),
				"task.isolation.mode": "none",
				"task.maxConcurrency": 2,
			}),
		);
		const result = await tool.execute("call-non-isolated-concurrent-gate", {
			...TASK_PARAMS,
			tasks: [
				{ id: "FixBugOne", description: "Fix first bug", assignment: "Implement the first fix." },
				{ id: "FixBugTwo", description: "Fix second bug", assignment: "Implement the second fix." },
			],
		});

		expect(trace.slice(0, 2)).toEqual(["implementer", "implementer"]);
		expect(result.details?.results.map(single => single.exitCode)).toEqual([0, 0]);
	});
});
