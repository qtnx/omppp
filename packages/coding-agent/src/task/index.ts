/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent execution
 *   - Parallel execution with concurrency limits
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import { AsyncJobManager } from "../async";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { Theme } from "../modes/theme/theme";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import { truncateForPrompt } from "../tools/approval";
import { formatBytes, formatDuration } from "../tools/render-utils";
import {
	type AgentDefinition,
	type AgentProgress,
	type AgentSource,
	getTaskSchema,
	type ReviewGateProgress,
	type SingleResult,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import type { LocalProtocolOptions } from "../internal-urls";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import { discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimit, Semaphore } from "./parallel";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { repairTaskParams } from "./repair-args";
import { type ReviewGateConfig, runReviewGate } from "./review-gate";
import { getTaskSimpleModeCapabilities, type TaskSimpleMode } from "./simple-mode";
import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	cleanupTaskBranches,
	commitToBranch,
	type DeltaPatchResult,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	mergeTaskBranches,
	parseIsolationMode,
	type WorktreeBaseline,
} from "./worktree";

function renderSubagentUserPrompt(assignment: string, simpleMode: TaskSimpleMode): string {
	return prompt.render(subagentUserPromptTemplate, {
		assignment: assignment.trim(),
		independentMode: simpleMode === "independent",
	});
}

function isReviewGateBlockedResult(result: SingleResult): boolean {
	return result.reviewGate?.outcome === "blocked";
}

function isTaskResultAccepted(result: SingleResult): boolean {
	return result.exitCode === 0 && !result.error && !result.aborted && !isReviewGateBlockedResult(result);
}

function formatSummaryStatus(result: SingleResult): string {
	if (result.aborted) {
		return "cancelled";
	}
	if (isReviewGateBlockedResult(result)) {
		return "review blocked";
	}
	if (result.exitCode === 0 && result.error) {
		return "merge failed";
	}
	if (result.exitCode === 0) {
		return "completed";
	}
	return `failed (exit ${result.exitCode})`;
}

function formatReviewBlockedPreview(result: SingleResult): string {
	const base = result.output.trim() || result.stderr.trim();
	const reason = result.reviewGate?.failureReason?.trim();
	const feedback = reason ? `Review gate blocked: ${reason}` : "Review gate blocked.";
	return base ? `${base}\n\n${feedback}` : feedback;
}

function usesRestrictedResourceProfile(agent: AgentDefinition): boolean {
	return agent.resourceProfile === "minimal" && agent.tools !== undefined;
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"search",
	"find",
	"web_search",
	"ast_grep",
	"yield",
	"irc",
	"ask",
	"job",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"render_mermaid",
	"inspect_image",
	"checkpoint",
	"rewind",
	"resolve",
	"report_finding",
	"search_tool_bm25",
]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

/**
 * Render the tool description from a cached agent list and current settings.
 */
function renderDescription(
	agents: AgentDefinition[],
	maxConcurrency: number,
	isolationEnabled: boolean,
	asyncEnabled: boolean,
	disabledAgents: string[],
	simpleMode: TaskSimpleMode,
	ircEnabled: boolean,
	parentSpawns: string,
): string {
	const spawningDisabled = parentSpawns === "";
	let filteredAgents = disabledAgents.length > 0 ? agents.filter(a => !disabledAgents.includes(a.name)) : agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (parentSpawns !== "*") {
		const allowed = new Set(
			parentSpawns
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		);
		filteredAgents = filteredAgents.filter(a => allowed.has(a.name));
	}
	const renderedAgents = filteredAgents.map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
	}));
	const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	return prompt.render(taskDescriptionTemplate, {
		agents: renderedAgents,
		spawningDisabled,
		MAX_CONCURRENCY: maxConcurrency,
		isolationEnabled,
		asyncEnabled,
		contextEnabled,
		customSchemaEnabled,
		ircEnabled,
		defaultMode: simpleMode === "default",
		schemaFreeMode: simpleMode === "schema-free",
		independentMode: simpleMode === "independent",
	});
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

function validateTaskModeParams(simpleMode: TaskSimpleMode, params: TaskParams): string | undefined {
	const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	const disallowedFields: string[] = [];
	if (!contextEnabled && params.context !== undefined) {
		disallowedFields.push("context");
	}
	if (!customSchemaEnabled && params.schema !== undefined) {
		disallowedFields.push("schema");
	}
	if (disallowedFields.length === 0) {
		return undefined;
	}

	if (simpleMode === "schema-free") {
		return "task.simple is set to schema-free, so the task tool does not accept `schema`. Remove it and rely on the selected agent definition or inherited session schema.";
	}

	if (disallowedFields.length === 1) {
		return `task.simple is set to independent, so the task tool does not accept \`${disallowedFields[0]}\`. Put everything the subagent needs inside each task assignment.`;
	}

	return "task.simple is set to independent, so the task tool does not accept `context` or `schema`. Put all required background and output expectations inside each task assignment or the selected agent definition.";
}

/**
 * Build a per-task failed-result envelope used to short-circuit task execution
 * when the review gate is misconfigured. No subagent spawns, no isolation work,
 * no patches.
 */
function buildReviewGateConfigError(
	params: TaskParams,
	projectAgentsDir: string | null,
	agentName: string,
	agentSource: AgentSource,
	simpleMode: TaskSimpleMode,
	text: string,
): AgentToolResult<TaskToolDetails> {
	const tasks = params.tasks ?? [];
	const results: SingleResult[] = tasks.map((taskItem, index) => {
		const assignment = (taskItem.assignment ?? "").trim();
		return {
			index,
			id: taskItem.id,
			agent: agentName,
			agentSource,
			task: renderSubagentUserPrompt(assignment, simpleMode),
			assignment,
			description: taskItem.description,
			exitCode: 1,
			output: "",
			stderr: text,
			truncated: false,
			durationMs: 0,
			tokens: 0,
			error: text,
		};
	});
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir, results, totalDurationMs: 0 },
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Requires async initialization to discover available agents.
 * Use `TaskTool.create(session)` to instantiate.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		if (typeof params.agent === "string") {
			lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
		}
		const tasks = Array.isArray(params.tasks) ? params.tasks : [];
		const firstTask = tasks[0];
		if (firstTask) {
			lines.push(`Task: ${truncateForPrompt(firstTask.id)}`);
			lines.push(`Assignment:\n${truncateForPrompt(firstTask.assignment)}`);
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn a subagent to complete a parallel task";
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly renderResult = renderResult;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;

	get parameters(): TaskToolSchemaInstance {
		const isolationEnabled = this.session.settings.get("task.isolation.mode") !== "none";
		return getTaskSchema({ isolationEnabled, simpleMode: this.#getTaskSimpleMode() });
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Dynamic description that reflects current disabled-agent settings */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const isolationMode = this.session.settings.get("task.isolation.mode");
		return renderDescription(
			this.#discoveredAgents,
			maxConcurrency,
			isolationMode !== "none",
			this.session.settings.get("async.enabled"),
			disabledAgents,
			this.#getTaskSimpleMode(),
			this.session.settings.get("irc.enabled") === true,
			this.session.getSessionSpawns() ?? "*",
		);
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	#getTaskSimpleMode(): TaskSimpleMode {
		return this.session.settings.get("task.simple");
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = await discoverAgents(session.cwd);
		return new TaskTool(session, agents);
	}

	async execute(
		_toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const params = repairTaskParams(rawParams as TaskParams);
		const simpleMode = this.#getTaskSimpleMode();
		const validationError = validateTaskModeParams(simpleMode, params);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const asyncEnabled = this.session.settings.get("async.enabled");
		const selectedAgent = this.#discoveredAgents.find(agent => agent.name === params.agent);
		if (!asyncEnabled || selectedAgent?.blocking === true) {
			return this.#executeSync(_toolCallId, params, signal, onUpdate);
		}

		const manager = AsyncJobManager.instance();
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is enabled but no async job manager is available." }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const taskItems = params.tasks ?? [];
		if (taskItems.length === 0) {
			return this.#executeSync(_toolCallId, params, signal, onUpdate);
		}

		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const uniqueIds = await outputManager.allocateBatch(taskItems.map(t => t.id));
		const fallbackAgentSource =
			this.#discoveredAgents.find(agent => agent.name === params.agent)?.source ?? "bundled";
		const progressByTaskId = new Map<string, AgentProgress>();
		for (let index = 0; index < taskItems.length; index++) {
			const taskItem = taskItems[index];
			const assignment = taskItem.assignment.trim();
			progressByTaskId.set(taskItem.id, {
				index,
				id: taskItem.id,
				agent: params.agent,
				agentSource: fallbackAgentSource,
				status: "pending",
				task: renderSubagentUserPrompt(assignment, simpleMode),
				assignment,
				description: taskItem.description,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			});
		}

		const startedJobs: Array<{ jobId: string; taskId: string }> = [];
		const failedSchedules: string[] = [];
		let completedJobs = 0;
		let failedJobs = 0;

		const getProgressSnapshot = (): AgentProgress[] => {
			return Array.from(progressByTaskId.values())
				.sort((a, b) => a.index - b.index)
				.map(progress => structuredClone(progress));
		};

		const buildAsyncDetails = (state: "running" | "completed" | "failed", jobId: string): TaskToolDetails => ({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: getProgressSnapshot(),
			async: { state, jobId, type: "task" },
		});

		const emitAsyncUpdate = (state: "running" | "completed" | "failed", text: string): void => {
			const primaryJobId = startedJobs[0]?.jobId ?? "task";
			onUpdate?.({
				content: [{ type: "text", text }],
				details: buildAsyncDetails(state, primaryJobId),
			});
		};

		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const semaphore = new Semaphore(maxConcurrency);

		for (let i = 0; i < taskItems.length; i++) {
			const taskItem = taskItems[i];
			if (signal?.aborted) {
				failedSchedules.push(`${taskItem.id}: cancelled before scheduling`);
				const progress = progressByTaskId.get(taskItem.id);
				if (progress) {
					progress.status = "aborted";
				}
				continue;
			}

			const uniqueId = uniqueIds[i];
			const singleParams: TaskParams = { ...params, tasks: [taskItem] };
			const label = uniqueId;
			try {
				const jobId = manager.register(
					"task",
					label,
					async ({ signal: runSignal, reportProgress }) => {
						const startedAt = Date.now();
						const progress = progressByTaskId.get(taskItem.id);
						await semaphore.acquire();
						if (runSignal.aborted) {
							semaphore.release();
							if (progress) {
								progress.status = "aborted";
							}
							throw new Error("Aborted before execution");
						}
						if (progress) {
							progress.status = "running";
						}
						await reportProgress(
							`Running background task ${taskItem.id}...`,
							buildAsyncDetails("running", startedJobs[0]?.jobId ?? label) as unknown as Record<string, unknown>,
						);
						try {
							const result = await this.#executeSync(_toolCallId, singleParams, runSignal, undefined, [
								uniqueId,
							]);
							const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
							const singleResult = result.details?.results[0];
							if (progress) {
								progress.status = singleResult?.aborted
									? "aborted"
									: (singleResult?.exitCode ?? 0) === 0
										? "completed"
										: "failed";
								progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
								progress.tokens = singleResult?.tokens ?? 0;
								progress.contextTokens = singleResult?.contextTokens;
								progress.contextWindow = singleResult?.contextWindow;
								progress.cost = singleResult?.usage?.cost.total ?? 0;
								progress.extractedToolData = singleResult?.extractedToolData;
								progress.retryFailure = singleResult?.retryFailure;
								progress.retryState = undefined;
							}
							completedJobs += 1;
							if (singleResult && ((singleResult.aborted ?? false) || singleResult.exitCode !== 0)) {
								failedJobs += 1;
							}
							const remaining = taskItems.length - completedJobs;
							const isDone = remaining === 0;
							await reportProgress(
								isDone
									? `Background task batch complete: ${completedJobs}/${taskItems.length} finished.`
									: `Background task batch progress: ${completedJobs}/${taskItems.length} finished (${remaining} running).`,
								buildAsyncDetails(
									isDone ? (failedJobs > 0 || failedSchedules.length > 0 ? "failed" : "completed") : "running",
									startedJobs[0]?.jobId ?? label,
								) as unknown as Record<string, unknown>,
							);
							if (isDone) {
								emitAsyncUpdate(
									failedJobs > 0 || failedSchedules.length > 0 ? "failed" : "completed",
									`Background task batch complete: ${completedJobs}/${taskItems.length} finished.`,
								);
							}
							return finalText;
						} catch (error) {
							if (progress) {
								progress.status = "failed";
								progress.durationMs = Math.max(0, Date.now() - startedAt);
							}
							completedJobs += 1;
							failedJobs += 1;
							const remaining = taskItems.length - completedJobs;
							const isDone = remaining === 0;
							await reportProgress(
								isDone
									? `Background task batch complete with failures: ${failedJobs} failed.`
									: `Background task batch progress: ${completedJobs}/${taskItems.length} finished (${remaining} running).`,
								buildAsyncDetails(
									isDone ? "failed" : "running",
									startedJobs[0]?.jobId ?? label,
								) as unknown as Record<string, unknown>,
							);
							if (isDone) {
								emitAsyncUpdate(
									"failed",
									`Background task batch complete with failures: ${failedJobs} failed.`,
								);
							}
							throw error;
						} finally {
							semaphore.release();
						}
					},
					{
						id: label,
						ownerId: this.session.getAgentId?.() ?? undefined,
						onProgress: (text, details) => {
							const progressDetails =
								(details as TaskToolDetails | undefined) ??
								buildAsyncDetails("running", startedJobs[0]?.jobId ?? label);
							onUpdate?.({ content: [{ type: "text", text }], details: progressDetails });
						},
					},
				);
				startedJobs.push({ jobId, taskId: taskItem.id });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failedSchedules.push(`${taskItem.id}: ${message}`);
				const progress = progressByTaskId.get(taskItem.id);
				if (progress) {
					progress.status = "failed";
				}
			}
		}

		if (startedJobs.length === 0) {
			const failureText = `Failed to start background task jobs: ${failedSchedules.join("; ")}`;
			return {
				content: [{ type: "text", text: failureText }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		emitAsyncUpdate(
			"running",
			`Launching ${startedJobs.length} background ${startedJobs.length === 1 ? "task" : "tasks"}...`,
		);

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} task${failedSchedules.length === 1 ? "" : "s"}.`
				: "";

		const ircEnabled = this.session.settings.get("irc.enabled") === true;
		const taskIdByItemId = new Map<string, string>();
		for (let i = 0; i < taskItems.length; i++) {
			taskIdByItemId.set(taskItems[i].id, uniqueIds[i]);
		}
		const startedListing = startedJobs
			.map(({ taskId, jobId }) => {
				const id = taskIdByItemId.get(taskId) ?? taskId;
				const desc = progressByTaskId.get(taskId)?.description;
				const prefix = `- \`${id}\` (job \`${jobId}\`)`;
				return desc ? `${prefix} — ${desc}` : prefix;
			})
			.join("\n");
		const coordinationHint = ircEnabled
			? ` DM these ids via \`irc\` to coordinate while they run; reach for \`job\` only to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`
			: ` Use \`job\` to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task by id.`;

		return {
			content: [
				{
					type: "text",
					text: `Started ${startedJobs.length} background task job${startedJobs.length === 1 ? "" : "s"} using ${params.agent}.${scheduleFailureSummary} Results will be delivered when complete.\n${startedListing}\n${coordinationHint}`,
				},
			],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: getProgressSnapshot(),
				async: { state: "running", jobId: startedJobs[0].jobId, type: "task" },
			},
		};
	}

	async #executeSync(
		_toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedIds?: string[],
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const { agents, projectAgentsDir } = await discoverAgents(this.session.cwd);
		const { agent: agentName, context, schema: outputSchema } = params;
		const simpleMode = this.#getTaskSimpleMode();
		const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
		const sharedContext = contextEnabled ? context?.trim() : undefined;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const isolationRequested = "isolated" in params ? params.isolated === true : false;
		const isIsolated = isolationMode !== "none" && isolationRequested;
		const mergeMode = this.session.settings.get("task.isolation.merge");
		const commitStyle = this.session.settings.get("task.isolation.commits");
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const taskDepth = this.session.taskDepth ?? 0;
		const subagentLspEnabled = (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp");

		if (isolationMode === "none" && isolationRequested) {
			return {
				content: [
					{
						type: "text",
						text: "Task isolation is disabled.",
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		// Validate agent exists
		const agent = getAgent(agents, agentName);
		if (!agent) {
			const available = agents.map(a => a.name).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Unknown agent "${agentName}". Available: ${available}`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		// Check if agent is disabled in settings
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		if (disabledAgents.length > 0 && disabledAgents.includes(agentName)) {
			const enabled = agents.filter(a => !disabledAgents.includes(a.name)).map(a => a.name);
			return {
				content: [
					{
						type: "text",
						text: `Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const planModeState = this.session.getPlanModeState?.();
		const planModeTools = ["read", "search", "find", "lsp", "web_search"];
		const effectiveAgent: typeof agent = planModeState?.enabled
			? {
					...agent,
					systemPrompt: `${planModeSubagentPrompt}\n\n${agent.systemPrompt}`,
					tools: planModeTools,
					spawns: undefined,
				}
			: agent;
		const agentReviewGate = effectiveAgent.reviewGate;
		const reviewGateEnabled =
			agentReviewGate?.enabled ?? this.session.settings.get("task.reviewGate.enabled") === true;

		// Apply per-agent model override from settings (highest priority)
		const agentModelOverrides = this.session.settings.get("task.agentModelOverrides");
		const settingsModelOverride = agentModelOverrides[agentName];
		const parentActiveModelPattern = this.session.getActiveModelString?.();
		const modelOverride = resolveAgentModelPatterns({
			settingsOverride: settingsModelOverride,
			agentModel: effectiveAgent.model,
			settings: this.session.settings,
			activeModelPattern: parentActiveModelPattern,
			fallbackModelPattern: this.session.getModelString?.(),
		});
		const thinkingLevelOverride = effectiveAgent.thinkingLevel;

		// Resolve reviewer/fixer agents up front when the review gate is active so
		// we can fail fast on a missing agent before any subagent or isolation work.
		let reviewGateConfig: ReviewGateConfig | undefined;
		if (reviewGateEnabled) {
			const reviewerName =
				agentReviewGate?.reviewerAgent ?? this.session.settings.get("task.reviewGate.reviewerAgent") ?? "";
			const fixerName = agentReviewGate?.fixerAgent ?? this.session.settings.get("task.reviewGate.fixerAgent") ?? "";
			const reviewerAgent = reviewerName ? getAgent(agents, reviewerName) : undefined;
			const fixerAgent = fixerName ? getAgent(agents, fixerName) : undefined;
			if (!reviewerAgent || !fixerAgent) {
				const missing = !reviewerAgent ? reviewerName : fixerName;
				const text = `Review gate is enabled but cannot resolve agent "${missing}". Update the selected agent's reviewGate policy or task.reviewGate.reviewerAgent / task.reviewGate.fixerAgent to a known agent name.`;
				return buildReviewGateConfigError(params, projectAgentsDir, agentName, agent.source, simpleMode, text);
			}
			const failOnRaw =
				(agentReviewGate?.failOnPriorities as unknown) ??
				(this.session.settings.get("task.reviewGate.failOnPriorities") as unknown);
			if (
				!Array.isArray(failOnRaw) ||
				failOnRaw.length === 0 ||
				!failOnRaw.every((p): p is number => typeof p === "number" && Number.isInteger(p) && p >= 0 && p <= 3)
			) {
				const text =
					"Review gate failOnPriorities must be a non-empty array of integer priorities in 0..3. Update the selected agent's reviewGate policy or task.reviewGate.failOnPriorities.";
				return buildReviewGateConfigError(params, projectAgentsDir, agentName, agent.source, simpleMode, text);
			}
			const failOnPriorities = [...new Set<number>(failOnRaw)].sort((a, b) => a - b);
			const rawMaxFix =
				agentReviewGate?.maxFixIterations ?? Number(this.session.settings.get("task.reviewGate.maxFixIterations"));
			reviewGateConfig = {
				reviewerAgent,
				reviewerModel: agentReviewGate?.reviewerModel,
				fixerAgent,
				maxFixIterations: Number.isFinite(rawMaxFix) && rawMaxFix >= 0 ? Math.trunc(rawMaxFix) : 0,
				failOnPriorities,
				requireCorrectVerdict:
					agentReviewGate?.requireCorrectVerdict ??
					this.session.settings.get("task.reviewGate.requireCorrectVerdict") === true,
			};
		}

		// Output schema priority: task call > agent frontmatter > inherited parent session.
		// task.simple can disable the task-call override while leaving agent/session schemas intact.
		const effectiveOutputSchema = customSchemaEnabled
			? (outputSchema ?? effectiveAgent.output ?? this.session.outputSchema)
			: (effectiveAgent.output ?? this.session.outputSchema);

		// Handle empty or missing tasks
		if (!params.tasks || params.tasks.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: contextEnabled
							? "No tasks provided. Use: { agent, context?, tasks: [{ id, description, assignment }, ...] }"
							: "No tasks provided. Use: { agent, tasks: [{ id, description, assignment }, ...] }",
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const tasks = params.tasks;
		const missingTaskIndexes: number[] = [];
		const idIndexes = new Map<string, number[]>();

		for (let i = 0; i < tasks.length; i++) {
			const id = tasks[i]?.id;
			if (typeof id !== "string" || id.trim() === "") {
				missingTaskIndexes.push(i);
				continue;
			}
			const normalizedId = id.toLowerCase();
			const indexes = idIndexes.get(normalizedId);
			if (indexes) {
				indexes.push(i);
			} else {
				idIndexes.set(normalizedId, [i]);
			}
		}

		const duplicateIds: Array<{ id: string; indexes: number[] }> = [];
		for (const [normalizedId, indexes] of idIndexes.entries()) {
			if (indexes.length > 1) {
				duplicateIds.push({
					id: tasks[indexes[0]]?.id ?? normalizedId,
					indexes,
				});
			}
		}

		if (missingTaskIndexes.length > 0 || duplicateIds.length > 0) {
			const problems: string[] = [];
			if (missingTaskIndexes.length > 0) {
				problems.push(`Missing task ids at indexes: ${missingTaskIndexes.join(", ")}`);
			}
			if (duplicateIds.length > 0) {
				const details = duplicateIds.map(entry => `${entry.id} (indexes ${entry.indexes.join(", ")})`).join("; ");
				problems.push(`Duplicate task ids detected (case-insensitive): ${details}`);
			}
			return {
				content: [{ type: "text", text: `Invalid tasks: ${problems.join(". ")}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		let repoRoot: string | null = null;
		let baseline: WorktreeBaseline | null = null;
		if (isIsolated || reviewGateConfig) {
			try {
				repoRoot = await getRepoRoot(this.session.cwd);
				if (isIsolated) {
					baseline = await captureBaseline(repoRoot);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const prefix = isIsolated
					? "Isolated task execution requires a git repository."
					: "Task review gate requires a git repository.";
				return {
					content: [
						{
							type: "text",
							text: `${prefix} ${message}`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}
		}

		const preferredIsolationBackend = parseIsolationMode(isolationMode);

		// Derive artifacts directory
		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `omp-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		const localProtocolOptions: LocalProtocolOptions = this.session.localProtocolOptions ?? {
			getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
			getSessionId: this.session.getSessionId ?? (() => null),
		};

		// Subagents adopt the parent's ArtifactManager so artifact IDs are unique
		// across the whole tree and outputs land flat in the parent's dir.
		const parentArtifactManager = this.session.getArtifactManager?.() ?? undefined;

		// When the session is executing an approved plan, hand the overall plan to
		// every subagent so they share the main agent's plan context. Skipped in
		// plan mode (read-only exploration uses planModeSubagentPrompt instead) and
		// when no plan file exists at the session's reference path.
		const planReference = planModeState?.enabled
			? undefined
			: await loadOverallPlanReference(
					this.session.getPlanReferencePath?.() ?? "local://PLAN.md",
					localProtocolOptions,
				);

		// Initialize progress tracking
		const progressMap = new Map<number, AgentProgress>();

		// Update callback
		const emitProgress = () => {
			const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
			onUpdate?.({
				content: [{ type: "text", text: `Running ${params.tasks.length} agents...` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress,
				},
			});
		};

		try {
			// Check self-recursion prevention
			if (this.#blockedAgent && agentName === this.#blockedAgent) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot spawn ${this.#blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Check spawn restrictions from parent
			const parentSpawns = this.session.getSessionSpawns() ?? "*";
			const allowedSpawns = parentSpawns.split(",").map(s => s.trim());
			const isSpawnAllowed = (): boolean => {
				if (parentSpawns === "") return false; // Empty = deny all
				if (parentSpawns === "*") return true; // Wildcard = allow all
				return allowedSpawns.includes(agentName);
			};

			if (!isSpawnAllowed()) {
				const allowed = parentSpawns === "" ? "none (spawns disabled for this agent)" : parentSpawns;
				return {
					content: [{ type: "text", text: `Cannot spawn '${agentName}'. Allowed: ${allowed}` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			const ircEnabled = this.session.settings.get("irc.enabled") === true;
			const agentCanUseIrc = (candidate: AgentDefinition): boolean =>
				ircEnabled && (candidate.tools === undefined || candidate.tools.includes("irc"));
			const shouldWriteConversationContext =
				!agentCanUseIrc(effectiveAgent) ||
				(reviewGateConfig !== undefined &&
					(!agentCanUseIrc(reviewGateConfig.reviewerAgent) || !agentCanUseIrc(reviewGateConfig.fixerAgent)));

			// Write parent conversation context when a subagent cannot use IRC.
			// Restricted read-only agents such as `explore` should not have to IPC
			// back to Main just to recover basic conversation context.
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });
			const compactContext = shouldWriteConversationContext ? this.session.getCompactContext?.() : undefined;
			const writeContextSnapshot = async (): Promise<string | undefined> => {
				if (!compactContext) return undefined;
				const contextFilePath = path.join(effectiveArtifactsDir, `context-${Snowflake.next()}.md`);
				await Bun.write(contextFilePath, compactContext);
				return contextFilePath;
			};

			// Build full prompts with context prepended
			// Allocate unique IDs across the session to prevent artifact collisions
			let uniqueIds: string[];
			if (preAllocatedIds && preAllocatedIds.length === tasks.length) {
				uniqueIds = preAllocatedIds;
			} else {
				const outputManager =
					this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				uniqueIds = await outputManager.allocateBatch(tasks.map(t => t.id));
			}
			const tasksWithUniqueIds = tasks.map((t, i) => ({ ...t, id: uniqueIds[i] }));

			const availableSkills = this.session.skills ?? [];
			const resolveAutoloadSkills = (agentDefinition: AgentDefinition) =>
				agentDefinition.autoloadSkills?.length && availableSkills.length > 0
					? agentDefinition.autoloadSkills
							.map(name => availableSkills.find(skill => skill.name === name))
							.filter((skill): skill is NonNullable<typeof skill> => skill !== undefined)
					: [];
			const resolveSessionSkills = (agentDefinition: AgentDefinition) =>
				usesRestrictedResourceProfile(agentDefinition) ? resolveAutoloadSkills(agentDefinition) : availableSkills;
			const resolvedAutoloadSkills = resolveAutoloadSkills(effectiveAgent);
			const resolvedSessionSkills = resolveSessionSkills(effectiveAgent);
			const contextFiles = this.session.contextFiles?.filter(
				file => path.basename(file.path).toLowerCase() !== "agents.md",
			);
			const promptTemplates = this.session.promptTemplates;
			const parentEvalSessionId = this.session.getEvalSessionId?.() ?? undefined;
			const mcpManager = this.session.mcpManager;

			// Initialize progress for all tasks
			for (let i = 0; i < tasksWithUniqueIds.length; i++) {
				const taskItem = tasksWithUniqueIds[i];
				const assignment = taskItem.assignment.trim();
				progressMap.set(i, {
					index: i,
					id: taskItem.id,
					agent: agentName,
					agentSource: agent.source,
					status: "pending",
					task: renderSubagentUserPrompt(assignment, simpleMode),
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
					modelOverride,
					description: taskItem.description,
				});
			}
			emitProgress();
			const runReviewGateForTask = async (
				task: (typeof tasksWithUniqueIds)[number],
				index: number,
				result: SingleResult,
				captureDelta: () => Promise<DeltaPatchResult>,
				worktree?: string,
			): Promise<{ result: SingleResult; acceptedDelta?: DeltaPatchResult }> => {
				if (!reviewGateConfig || result.exitCode !== 0 || result.aborted) {
					return { result };
				}

				const gateConfig = reviewGateConfig;
				const buildParentProgress = (): AgentProgress => {
					const existing = progressMap.get(index);
					return {
						index,
						id: result.id,
						agent: result.agent,
						agentSource: result.agentSource,
						status: "running",
						task: result.task,
						assignment: result.assignment,
						description: result.description,
						lastIntent: result.lastIntent,
						recentTools: existing?.recentTools ?? [],
						recentOutput: existing?.recentOutput ?? [],
						toolCount: existing?.toolCount ?? 0,
						tokens: result.tokens,
						contextTokens: result.contextTokens,
						contextWindow: result.contextWindow,
						cost: result.usage?.cost.total ?? existing?.cost ?? 0,
						durationMs: result.durationMs,
						modelOverride: result.modelOverride,
						resolvedModel: result.resolvedModel,
						extractedToolData: result.extractedToolData,
						retryFailure: result.retryFailure,
					};
				};

				const publishReviewGateProgress = (
					stage: ReviewGateProgress["stage"],
					iteration: number,
					current?: AgentProgress,
				): void => {
					const base = progressMap.get(index) ?? buildParentProgress();
					const reviewGate: ReviewGateProgress = {
						stage,
						iteration,
						maxIterations: gateConfig.maxFixIterations + 1,
						reviewerAgent: gateConfig.reviewerAgent.name,
						fixerAgent: gateConfig.fixerAgent.name,
						...(current ? { current: structuredClone(current) } : {}),
					};
					progressMap.set(index, {
						...structuredClone(base),
						status: "running",
						reviewGate,
					});
					emitProgress();
				};

				const runGateSubagent = async (
					gateAgent: AgentDefinition,
					role: "review" | "fix",
					request: { promptText: string; iteration: number },
				): Promise<SingleResult> => {
					const explicitGateModel = role === "review" ? gateConfig.reviewerModel : undefined;
					const gateModelOverride = resolveAgentModelPatterns({
						settingsOverride: explicitGateModel ?? agentModelOverrides[gateAgent.name],
						agentModel: explicitGateModel ?? gateAgent.model,
						settings: this.session.settings,
						activeModelPattern: parentActiveModelPattern,
						fallbackModelPattern: this.session.getModelString?.(),
					});
					const stage: ReviewGateProgress["stage"] = role === "review" ? "reviewing" : "fixing";
					publishReviewGateProgress(stage, request.iteration);
					const gateId = `${task.id}-${role}-${request.iteration}`;
					const resolvedGateAutoloadSkills = resolveAutoloadSkills(gateAgent);
					const resolvedGateSessionSkills = resolveSessionSkills(gateAgent);
					return runSubprocess({
						cwd: this.session.cwd,
						...(worktree ? { worktree } : {}),
						agent: gateAgent,
						task: request.promptText,
						assignment: task.assignment.trim(),
						context: sharedContext,
						planReference,
						description: `Review gate ${role === "review" ? "reviewer" : "fixer"} pass ${request.iteration}`,
						index,
						id: gateId,
						taskDepth,
						modelOverride: gateModelOverride,
						parentActiveModelPattern,
						thinkingLevel: gateAgent.thinkingLevel,
						outputSchema: gateAgent.output,
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						contextFile: await writeContextSnapshot(),
						enableLsp: subagentLspEnabled,
						signal,
						eventBus: this.session.eventBus,
						onProgress: progress => publishReviewGateProgress(stage, request.iteration, progress),
						authStorage: this.session.authStorage,
						modelRegistry: this.session.modelRegistry,
						settings: this.session.settings,
						mcpManager,
						contextFiles,
						skills: resolvedGateSessionSkills,
						autoloadSkills: resolvedGateAutoloadSkills,
						workspaceTree: this.session.workspaceTree,
						workspaceRoots: this.session.workspaceRoots,
						promptTemplates,
						localProtocolOptions,
						parentArtifactManager,
						parentHindsightSessionState: this.session.getHindsightSessionState?.(),
						parentMnemopiSessionState: this.session.getMnemopiSessionState?.(),
						parentTelemetry: this.session.getTelemetry?.(),
						parentEvalSessionId,
					});
				};

				const gateOutcome = await runReviewGate({
					config: gateConfig,
					assignment: task.assignment.trim(),
					description: task.description,
					captureDelta,
					runReviewer: request => runGateSubagent(gateConfig.reviewerAgent, "review", request),
					runFixer: request => runGateSubagent(gateConfig.fixerAgent, "fix", request),
					signal,
				});

				if (!gateOutcome.passed) {
					if (gateOutcome.result.outcome === "blocked" && isTaskResultAccepted(result)) {
						return {
							result: {
								...result,
								reviewGate: gateOutcome.result,
							},
						};
					}

					const failureReason = gateOutcome.result.failureReason ?? "Review gate failed the task.";
					const combinedStderr = result.stderr ? `${result.stderr}\n${failureReason}` : failureReason;
					return {
						result: {
							...result,
							exitCode: 1,
							error: failureReason,
							stderr: combinedStderr,
							reviewGate: gateOutcome.result,
						},
					};
				}

				return {
					result: { ...result, reviewGate: gateOutcome.result },
					acceptedDelta: gateOutcome.acceptedDelta,
				};
			};

			const runTask = async (task: (typeof tasksWithUniqueIds)[number], index: number) => {
				if (!isIsolated) {
					const taskStart = Date.now();
					try {
						let taskBaseline: WorktreeBaseline | undefined;
						if (reviewGateConfig) {
							if (!repoRoot) {
								throw new Error("Review gate repository root not initialized.");
							}
							taskBaseline = await captureBaseline(repoRoot);
						}

						const result = await runSubprocess({
							cwd: this.session.cwd,
							agent: effectiveAgent,
							task: renderSubagentUserPrompt(task.assignment, simpleMode),
							assignment: task.assignment.trim(),
							context: sharedContext,
							description: task.description,
							index,
							id: task.id,
							taskDepth,
							modelOverride,
							parentActiveModelPattern,
							thinkingLevel: thinkingLevelOverride,
							outputSchema: effectiveOutputSchema,
							sessionFile,
							persistArtifacts: !!artifactsDir,
							artifactsDir: effectiveArtifactsDir,
							contextFile: await writeContextSnapshot(),
							enableLsp: subagentLspEnabled,
							signal,
							eventBus: this.session.eventBus,
							onProgress: progress => {
								progressMap.set(index, {
									...structuredClone(progress),
								});
								emitProgress();
							},
							authStorage: this.session.authStorage,
							modelRegistry: this.session.modelRegistry,
							settings: this.session.settings,
							mcpManager,
							contextFiles,
							skills: resolvedSessionSkills,
							autoloadSkills: resolvedAutoloadSkills,
							workspaceTree: this.session.workspaceTree,
							workspaceRoots: this.session.workspaceRoots,
							promptTemplates,
							localProtocolOptions,
							parentArtifactManager,
							parentHindsightSessionState: this.session.getHindsightSessionState?.(),
							parentTelemetry: this.session.getTelemetry?.(),
							parentEvalSessionId,
						});

						if (reviewGateConfig && taskBaseline) {
							if (!repoRoot) {
								throw new Error("Review gate repository root not initialized.");
							}
							const reviewRepoRoot = repoRoot;
							const baselineForReview = taskBaseline;
							const gated = await runReviewGateForTask(task, index, result, () =>
								captureDeltaPatch(reviewRepoRoot, baselineForReview),
							);
							return gated.result;
						}

						return result;
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						const assignment = task.assignment.trim();
						return {
							index,
							id: task.id,
							agent: agent.name,
							agentSource: agent.source,
							task: renderSubagentUserPrompt(assignment, simpleMode),
							assignment,
							description: task.description,
							exitCode: 1,
							output: "",
							stderr: message,
							truncated: false,
							durationMs: Date.now() - taskStart,
							tokens: 0,
							modelOverride,
							error: message,
						};
					}
				}

				const taskStart = Date.now();
				let isolationHandle: IsolationHandle | undefined;
				try {
					if (!repoRoot || !baseline) {
						throw new Error("Isolated task execution not initialized.");
					}
					const taskBaseline = structuredClone(baseline);

					isolationHandle = await ensureIsolation(repoRoot, task.id, preferredIsolationBackend);
					const isolationDir = isolationHandle.mergedDir;

					let result = await runSubprocess({
						cwd: this.session.cwd,
						worktree: isolationDir,
						agent: effectiveAgent,
						task: renderSubagentUserPrompt(task.assignment, simpleMode),
						assignment: task.assignment.trim(),
						context: sharedContext,
						planReference,
						description: task.description,
						index,
						id: task.id,
						taskDepth,
						modelOverride,
						parentActiveModelPattern,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						contextFile: await writeContextSnapshot(),
						enableLsp: subagentLspEnabled,
						signal,
						eventBus: this.session.eventBus,
						onProgress: progress => {
							progressMap.set(index, {
								...structuredClone(progress),
							});
							emitProgress();
						},
						authStorage: this.session.authStorage,
						modelRegistry: this.session.modelRegistry,
						settings: this.session.settings,
						mcpManager,
						contextFiles,
						skills: resolvedSessionSkills,
						autoloadSkills: resolvedAutoloadSkills,
						workspaceTree: this.session.workspaceTree,
						workspaceRoots: this.session.workspaceRoots,
						promptTemplates,
						localProtocolOptions,
						parentArtifactManager,
						parentHindsightSessionState: this.session.getHindsightSessionState?.(),
						parentMnemopiSessionState: this.session.getMnemopiSessionState?.(),
						parentTelemetry: this.session.getTelemetry?.(),
						parentEvalSessionId,
					});

					const gated = await runReviewGateForTask(
						task,
						index,
						result,
						() => captureDeltaPatch(isolationDir, taskBaseline),
						isolationDir,
					);
					result = gated.result;
					const cachedDelta = gated.acceptedDelta;
					const reviewBlocked = isReviewGateBlockedResult(result);
					if (mergeMode === "branch" && result.exitCode === 0 && !reviewBlocked) {
						try {
							if (reviewGateConfig && !cachedDelta) {
								const reason = "Review gate passed without an accepted delta.";
								return {
									...result,
									exitCode: 1,
									error: reason,
									stderr: result.stderr ? `${result.stderr}\n${reason}` : reason,
								};
							}
							const commitMsg =
								commitStyle === "ai" && this.session.modelRegistry
									? async (diff: string) => {
											return generateCommitMessage(
												diff,
												this.session.modelRegistry!,
												this.session.settings,
												this.session.getSessionId?.() ?? undefined,
											);
										}
									: undefined;
							const commitResult = await commitToBranch(
								isolationDir,
								taskBaseline,
								task.id,
								task.description,
								commitMsg,
								cachedDelta,
							);
							return {
								...result,
								branchName: commitResult?.branchName,
								nestedPatches: commitResult?.nestedPatches,
							};
						} catch (mergeErr) {
							// Agent succeeded but branch commit failed — clean up stale branch
							const branchName = `omp/task/${task.id}`;
							await git.branch.tryDelete(repoRoot, branchName);
							const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
							return { ...result, error: `Merge failed: ${msg}` };
						}
					}
					if (result.exitCode === 0 && !reviewBlocked) {
						try {
							const delta = cachedDelta ?? (await captureDeltaPatch(isolationDir, taskBaseline));
							const patchPath = path.join(effectiveArtifactsDir, `${task.id}.patch`);
							await Bun.write(patchPath, delta.rootPatch);
							return {
								...result,
								patchPath,
								nestedPatches: delta.nestedPatches,
							};
						} catch (patchErr) {
							const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
							return { ...result, error: `Patch capture failed: ${msg}` };
						}
					}
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const assignment = task.assignment.trim();
					return {
						index,
						id: task.id,
						agent: agent.name,
						agentSource: agent.source,
						task: renderSubagentUserPrompt(assignment, simpleMode),
						assignment,
						description: task.description,
						exitCode: 1,
						output: "",
						stderr: message,
						truncated: false,
						durationMs: Date.now() - taskStart,
						tokens: 0,
						modelOverride,
						error: message,
					};
				} finally {
					if (isolationHandle) {
						await cleanupIsolation(isolationHandle);
					}
				}
			};

			// Execute in parallel with concurrency limit
			const { results: partialResults, aborted } = await mapWithConcurrencyLimit(
				tasksWithUniqueIds,
				maxConcurrency,
				runTask,
				signal,
			);

			// Fill in skipped tasks (undefined entries from abort) with placeholder results
			const results: SingleResult[] = partialResults.map((result, index) => {
				if (result !== undefined) {
					return result;
				}
				const task = tasksWithUniqueIds[index];
				const assignment = task.assignment.trim();
				return {
					index,
					id: task.id,
					agent: agentName,
					agentSource: agent.source,
					task: renderSubagentUserPrompt(assignment, simpleMode),
					assignment,
					description: task.description,
					exitCode: 1,
					output: "",
					stderr: "Skipped (cancelled before start)",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					modelOverride,
					error: "Cancelled before start",
					aborted: true,
					abortReason: "Cancelled before start",
				};
			});

			// Aggregate usage from executor results (already accumulated incrementally)
			const aggregatedUsage = createUsageTotals();
			let hasAggregatedUsage = false;
			for (const result of results) {
				if (result.usage) {
					addUsageTotals(aggregatedUsage, result.usage);
					hasAggregatedUsage = true;
				}
			}

			// Collect output paths (artifacts already written by executor in real-time)
			const outputPaths: string[] = [];
			const patchPaths: string[] = [];
			for (const result of results) {
				if (result.outputPath) {
					outputPaths.push(result.outputPath);
				}
				if (result.patchPath) {
					patchPaths.push(result.patchPath);
				}
			}

			let mergeSummary = "";
			let changesApplied: boolean | null = null;
			let hadAnyChanges = false;
			let mergedBranchesForNestedPatches: Set<string> | null = null;
			if (isIsolated && repoRoot) {
				try {
					if (mergeMode === "branch") {
						// Branch mode: merge task branches sequentially
						const branchEntries = results
							.filter(r => r.branchName && isTaskResultAccepted(r))
							.map(r => ({ branchName: r.branchName!, taskId: r.id, description: r.description }));

						if (branchEntries.length === 0) {
							changesApplied = true;
							hadAnyChanges = false;
							mergeSummary = "\n\nNo changes to apply.";
						} else {
							const mergeResult = await mergeTaskBranches(repoRoot, branchEntries);
							mergedBranchesForNestedPatches = new Set(mergeResult.merged);
							changesApplied = mergeResult.failed.length === 0;
							hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

							if (changesApplied) {
								mergeSummary = hadAnyChanges
									? `\n\nMerged ${mergeResult.merged.length} branch${mergeResult.merged.length === 1 ? "" : "es"}: ${mergeResult.merged.join(", ")}`
									: "\n\nNo changes to apply.";
							} else {
								const mergedPart =
									mergeResult.merged.length > 0 ? `Merged: ${mergeResult.merged.join(", ")}.\n` : "";
								const failedPart = `Failed: ${mergeResult.failed.join(", ")}.`;
								const conflictPart = mergeResult.conflict ? `\nConflict: ${mergeResult.conflict}` : "";
								mergeSummary = `\n\n<system-notification>Branch merge failed. ${mergedPart}${failedPart}${conflictPart}\nUnmerged branches remain for manual resolution.</system-notification>`;
							}
						}

						// Clean up merged branches (keep failed ones for manual resolution)
						const allBranches = branchEntries.map(b => b.branchName);
						if (changesApplied) {
							await cleanupTaskBranches(repoRoot, allBranches);
						}
					} else {
						// Patch mode: combine and apply patches
						const applicableResults = results.filter(result => !isReviewGateBlockedResult(result));
						const patchesInOrder = applicableResults.map(result => result.patchPath).filter(Boolean) as string[];
						const missingPatch = applicableResults.some(result => !result.patchPath);
						if (missingPatch) {
							changesApplied = false;
							hadAnyChanges = false;
						} else {
							const patchStats = await Promise.all(
								patchesInOrder.map(async patchPath => ({
									patchPath,
									size: (await fs.stat(patchPath)).size,
								})),
							);
							const nonEmptyPatches = patchStats.filter(patch => patch.size > 0).map(patch => patch.patchPath);
							if (nonEmptyPatches.length === 0) {
								changesApplied = true;
								hadAnyChanges = false;
							} else {
								const patchTexts = await Promise.all(
									nonEmptyPatches.map(async patchPath => Bun.file(patchPath).text()),
								);
								const combinedPatch = patchTexts
									.map(text => (text.endsWith("\n") ? text : `${text}\n`))
									.join("");
								if (!combinedPatch.trim()) {
									changesApplied = true;
									hadAnyChanges = false;
								} else {
									changesApplied = await git.patch.canApplyText(repoRoot, combinedPatch);
									if (changesApplied) {
										try {
											await git.patch.applyText(repoRoot, combinedPatch);
											hadAnyChanges = true;
										} catch {
											changesApplied = false;
											hadAnyChanges = false;
										}
									}
								}
							}
						}

						if (changesApplied) {
							mergeSummary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
						} else {
							const notification =
								"<system-notification>Patches were not applied and must be handled manually.</system-notification>";
							const patchList =
								patchPaths.length > 0
									? `\n\nPatch artifacts:\n${patchPaths.map(patch => `- ${patch}`).join("\n")}`
									: "";
							mergeSummary = `\n\n${notification}${patchList}`;
						}
					}
				} catch (mergeErr) {
					const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
					changesApplied = false;
					hadAnyChanges = false;
					mergeSummary = `\n\n<system-notification>Merge phase failed: ${msg}\nTask outputs are preserved but changes were not applied.</system-notification>`;
				}
			}

			// Apply nested repo patches (separate from parent git)
			if (isIsolated && repoRoot && (mergeMode === "branch" || changesApplied !== false)) {
				const allNestedPatches = results
					.filter(r => {
						if (!r.nestedPatches || r.nestedPatches.length === 0 || !isTaskResultAccepted(r)) {
							return false;
						}
						if (mergeMode !== "branch") {
							return true;
						}
						if (!r.branchName || !mergedBranchesForNestedPatches) {
							return false;
						}
						return mergedBranchesForNestedPatches.has(r.branchName);
					})
					.flatMap(r => r.nestedPatches!);
				if (allNestedPatches.length > 0) {
					try {
						const commitMsg =
							commitStyle === "ai" && this.session.modelRegistry
								? async (diff: string) => {
										return generateCommitMessage(
											diff,
											this.session.modelRegistry!,
											this.session.settings,
											this.session.getSessionId?.() ?? undefined,
										);
									}
								: undefined;
						await applyNestedPatches(repoRoot, allNestedPatches, commitMsg);
					} catch {
						// Nested patch failures are non-fatal to the parent merge
						mergeSummary +=
							"\n\n<system-notification>Some nested repository patches failed to apply.</system-notification>";
					}
				}
			}

			// Build final output - match plugin format
			const cancelledCount = results.filter(r => r.aborted).length;
			const reviewBlockedCount = results.filter(isReviewGateBlockedResult).length;
			const successCount = results.filter(isTaskResultAccepted).length;
			const totalDuration = Date.now() - startTime;
			const statusNotes = [
				reviewBlockedCount > 0 ? `${reviewBlockedCount} review-blocked` : "",
				aborted && cancelledCount > 0 ? `${cancelledCount} cancelled` : "",
			]
				.filter(Boolean)
				.join(", ");

			if (reviewBlockedCount > 0) {
				const blockedLabel = reviewBlockedCount === 1 ? "task was" : "tasks were";
				const locationNote = isIsolated
					? "Their patches were not applied."
					: "Their changes remain in the working tree for follow-up fixes.";
				mergeSummary += `\n\n<system-notification>${reviewBlockedCount} review-blocked ${blockedLabel} withheld by the review gate. ${locationNote}</system-notification>`;
			}

			const summaries = results.map(r => {
				const reviewBlocked = isReviewGateBlockedResult(r);
				const status = formatSummaryStatus(r);
				const output = reviewBlocked
					? formatReviewBlockedPreview(r)
					: r.output.trim() || r.stderr.trim() || "(no output)";
				const outputCharCount = reviewBlocked ? output.length : (r.outputMeta?.charCount ?? output.length);
				const fullOutputThreshold = 5000;
				let preview = output;
				let truncated = false;
				if (outputCharCount > fullOutputThreshold) {
					const slice = output.slice(0, fullOutputThreshold);
					const lastNewline = slice.lastIndexOf("\n");
					preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
					truncated = true;
				}
				return {
					agent: r.agent,
					status,
					id: r.id,
					preview,
					truncated,
					meta:
						!reviewBlocked && r.outputMeta
							? {
									lineCount: r.outputMeta.lineCount,
									charSize: formatBytes(r.outputMeta.charCount),
								}
							: undefined,
				};
			});

			const outputIds = results.filter(r => !r.aborted || r.output.trim()).map(r => `agent://${r.id}`);
			const summary = prompt.render(taskSummaryTemplate, {
				successCount,
				totalCount: results.length,
				statusNotes: statusNotes ? ` (${statusNotes})` : "",
				duration: formatDuration(totalDuration),
				summaries,
				outputIds,
				agentName,
				mergeSummary,
			});

			// Cleanup temp directory if used
			const shouldCleanupTempArtifacts =
				tempArtifactsDir && (!isIsolated || changesApplied === true || changesApplied === null);
			if (shouldCleanupTempArtifacts) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			return {
				content: [{ type: "text", text: summary }],
				details: {
					projectAgentsDir,
					results: results,
					totalDurationMs: totalDuration,
					usage: hasAggregatedUsage ? aggregatedUsage : undefined,
					outputPaths,
				},
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}
	}
}
