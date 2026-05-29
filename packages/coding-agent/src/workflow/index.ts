/**
 * Workflow tool — runs a deterministic orchestration script in the background.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async";
import { MCPManager } from "../mcp/manager";
import workflowDescription from "../prompts/tools/workflow.md" with { type: "text" };
import { getBundledAgent } from "../task/agents";
import { discoverAgents, getAgent } from "../task/discovery";
import { type ExecutorOptions, runSubprocess } from "../task/executor";
import { AgentOutputManager } from "../task/output-manager";
import type { AgentDefinition } from "../task/types";
import type { ToolSession } from "../tools";
import { discoverWorkflows, getWorkflowSource } from "./discovery";
import { WorkflowRun, workflowConcurrency } from "./engine";
import { WorkflowJournal } from "./journal";
import { extractMeta, validateMeta } from "./meta";
import { createWorkflowGlobals } from "./runtime";
import { runWorkflowScript, validateSyntax } from "./sandbox";
import { persistWorkflowScript, readWorkflowScript, subagentTranscriptDir } from "./storage";
import {
	WORKFLOW_PROGRESS_CHANNEL,
	type WorkflowMeta,
	type WorkflowParams,
	type WorkflowProgressFrame,
	type WorkflowToolDetails,
	workflowSchema,
} from "./types";

function textResult(text: string, details: WorkflowToolDetails): AgentToolResult<WorkflowToolDetails> {
	return { content: [{ type: "text", text }], details };
}
function emptyDetails(runId: string): WorkflowToolDetails {
	return { runId, phases: [], agents: [], logs: [] };
}

export class WorkflowTool implements AgentTool<typeof workflowSchema, WorkflowToolDetails> {
	readonly name = "workflow";
	readonly approval = "exec" as const;
	readonly label = "Workflow";
	readonly summary = "Orchestrate subagents with a deterministic workflow script";
	// No loadMode → always present when the gate (workflow.enabled) admits it, rather than
	// hidden behind search_tool_bm25. Workflow is an explicit opt-in feature.
	readonly description: string;
	readonly parameters = workflowSchema;
	readonly strict = true;
	readonly #agents: AgentDefinition[];

	private constructor(
		private readonly session: ToolSession,
		agents: AgentDefinition[],
		workflowNames: string[],
	) {
		this.#agents = agents;
		this.description = prompt.render(workflowDescription, { namedWorkflows: workflowNames.join(", ") });
	}

	static async create(session: ToolSession): Promise<WorkflowTool> {
		const [{ agents }, workflows] = await Promise.all([discoverAgents(session.cwd), discoverWorkflows(session.cwd)]);
		return new WorkflowTool(
			session,
			agents,
			workflows.map(w => w.name),
		);
	}

	/** Resolve the source for this invocation. */
	async #resolveSource(params: WorkflowParams): Promise<{ source?: string; error?: string }> {
		if (params.scriptPath) {
			const r = await readWorkflowScript(params.scriptPath);
			return { source: r.script, error: r.error };
		}
		if (params.script) return { source: params.script };
		if (params.name) return getWorkflowSource(this.session.cwd, params.name);
		return { error: "Provide one of `script`, `scriptPath`, or `name`." };
	}

	#resolveAgent = (agentType: string | undefined): AgentDefinition => {
		const fallback = getBundledAgent("workflow-subagent");
		if (!fallback) throw new Error("workflow-subagent agent is not registered.");
		if (!agentType) return fallback;
		const found = getAgent(this.#agents, agentType);
		if (!found) {
			throw new Error(
				`agent({agentType}): '${agentType}' not found. Available: ${this.#agents.map(a => a.name).join(", ")}`,
			);
		}
		return found;
	};

	async execute(
		_toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WorkflowToolDetails>,
	): Promise<AgentToolResult<WorkflowToolDetails>> {
		const params = rawParams as WorkflowParams;
		const isResume = !!params.resumeFromRunId;
		const runId = params.resumeFromRunId ?? randomUUID();

		const resolved = await this.#resolveSource(params);
		if (resolved.error || !resolved.source) {
			return textResult(resolved.error ?? "No workflow source.", emptyDetails(runId));
		}
		const source = resolved.source;

		const syntax = validateSyntax(source);
		if (!syntax.ok) return textResult(`Workflow script has a syntax error: ${syntax.error}`, emptyDetails(runId));

		const { meta, metaError } = extractMeta(source);
		if (metaError || !meta) return textResult(metaError ?? "Invalid meta.", emptyDetails(runId));
		const metaValidation = validateMeta(meta);
		if (metaValidation) return textResult(metaValidation, emptyDetails(runId));

		const artifactsDir = this.session.getArtifactsDir?.() ?? null;
		const scriptPath = artifactsDir ? await persistWorkflowScript(artifactsDir, meta.name, runId, source) : undefined;

		const manager = AsyncJobManager.instance();
		if (!manager) {
			// No background runner (e.g. headless --print). Run synchronously and return the result.
			const text = await this.#runScript(
				source,
				runId,
				meta,
				params.args,
				signal ?? new AbortController().signal,
				artifactsDir,
				isResume,
			);
			return textResult(text, { ...emptyDetails(runId), meta, scriptPath });
		}

		const jobId = manager.register(
			"workflow",
			`workflow:${meta.name}`,
			async ({ signal: jobSignal }) =>
				this.#runScript(source, runId, meta, params.args, jobSignal, artifactsDir, isResume),
			{ id: runId, ownerId: this.session.getAgentId?.() ?? undefined },
		);

		const details: WorkflowToolDetails = {
			runId,
			scriptPath,
			meta,
			phases: [],
			agents: [],
			logs: [],
			async: { state: "running", jobId, type: "workflow" },
		};

		const resumeNote = scriptPath
			? `\nScript: ${scriptPath}\nTo resume after editing: Workflow({scriptPath: "${scriptPath}", resumeFromRunId: "${runId}"})`
			: "";
		return textResult(
			`Workflow "${meta.name}" launched in background. Run id: ${runId}. Watch progress with /workflows.${resumeNote}`,
			details,
		);
	}

	/** Build a WorkflowRun and execute the script. Returns the final notification text. */
	async #runScript(
		source: string,
		runId: string,
		meta: WorkflowMeta,
		args: unknown,
		signal: AbortSignal,
		artifactsDir: string | null,
		isResume: boolean,
	): Promise<string> {
		const configured = this.session.settings.get("workflow.maxConcurrency") as number;
		const concurrency = configured && configured > 0 ? configured : workflowConcurrency();
		const budgetSetting = this.session.settings.get("workflow.tokenBudget") as number;
		const budgetTotal = budgetSetting && budgetSetting > 0 ? budgetSetting : null;

		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const emit = (frame: WorkflowProgressFrame) => this.session.eventBus?.emit(WORKFLOW_PROGRESS_CHANNEL, frame);
		const transcriptDir = artifactsDir ? subagentTranscriptDir(artifactsDir, runId) : undefined;

		const journal = transcriptDir
			? isResume
				? await WorkflowJournal.openForResume(path.join(transcriptDir, "journal.jsonl"))
				: await WorkflowJournal.open(path.join(transcriptDir, "journal.jsonl"))
			: undefined;

		const run = new WorkflowRun({
			runId,
			cwd: this.session.cwd,
			concurrency,
			budgetTotal,
			signal,
			allocateId: label => outputManager.allocate(label),
			emit,
			resolveAgent: this.#resolveAgent,
			journal,
			runSubprocess: (options: ExecutorOptions) =>
				runSubprocess({
					// Mirrors task/index.ts:989-1031 — keep this wiring in sync with the task tool.
					...options,
					assignment: options.task,
					taskDepth: (this.session.taskDepth ?? 0) + 1,
					parentActiveModelPattern: this.session.getActiveModelString?.(),
					persistArtifacts: !!artifactsDir,
					artifactsDir: transcriptDir,
					eventBus: this.session.eventBus,
					authStorage: this.session.authStorage,
					modelRegistry: this.session.modelRegistry,
					settings: this.session.settings,
					mcpManager: MCPManager.instance(),
					contextFiles: this.session.contextFiles,
					skills: this.session.skills,
					workspaceTree: this.session.workspaceTree,
					promptTemplates: this.session.promptTemplates,
					localProtocolOptions: {
						getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
						getSessionId: this.session.getSessionId ?? (() => null),
					},
					parentArtifactManager: this.session.getArtifactManager?.() ?? undefined,
					parentHindsightSessionState: this.session.getHindsightSessionState?.(),
					parentEvalSessionId: this.session.getEvalSessionId?.() ?? undefined,
				}),
		});

		const globals = createWorkflowGlobals(run, args, {
			runWorkflow: async (nameOrRef, subArgs) => {
				const sub =
					typeof nameOrRef === "string"
						? await getWorkflowSource(this.session.cwd, nameOrRef)
						: await readWorkflowScript(nameOrRef.scriptPath).then(r => ({ source: r.script, error: r.error }));
				if (sub.error || !sub.source) throw new Error(sub.error ?? "Unreadable sub-workflow.");
				const subSyntax = validateSyntax(sub.source);
				if (!subSyntax.ok) throw new Error(`Sub-workflow syntax error: ${subSyntax.error}`);
				// One-level nesting: child globals have no runWorkflow dep, so workflow() inside throws.
				const subGlobals = createWorkflowGlobals(run, subArgs);
				return runWorkflowScript(sub.source, subGlobals as unknown as Record<string, unknown>, subArgs);
			},
		});
		try {
			const result = await runWorkflowScript(source, globals as unknown as Record<string, unknown>, args);
			const text =
				typeof result === "string"
					? result
					: result === undefined
						? "(workflow completed)"
						: JSON.stringify(result);
			return `Workflow "${meta.name}" (${runId}) completed.\n${text}`;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return `Workflow "${meta.name}" (${runId}) failed: ${msg}`;
		} finally {
			await journal?.close();
		}
	}
}
