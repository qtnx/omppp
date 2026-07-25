import type { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import type { AgentTelemetryConfig, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl, ImageContent, Model, ServiceTierByFamily, ToolChoice } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async/job-manager";
import type { Rule } from "../capability/rule";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { DuoExecutionScope, DuoHandoffResult, DuoStatus } from "../duo";
import { DuoEscalateTool, DuoHandoffTool } from "../duo";
import { EditTool } from "../edit";
import { checkJuliaKernelAvailability } from "../eval/jl/kernel";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { checkRubyKernelAvailability } from "../eval/rb/kernel";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState, GoalRuntime } from "../goals";
import { CreateGoalTool, GetGoalTool, GoalTool, UpdateGoalTool } from "../goals/tools/goal-tool";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import { LspTool } from "../lsp";
import type { MCPManager } from "../mcp";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { OrchestratorModeState } from "../orchestrator-mode/state";
import type { PlanModeState } from "../plan-mode/state";
import { startPreviewServer } from "../product-preview";
import type { PreviewFeedback } from "../product-preview/types";
import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRegistry } from "../registry/agent-registry";
import type { ArtifactManager } from "../session/artifacts";
import type { ClientBridge } from "../session/client-bridge";
import type { CustomMessage } from "../session/messages";
import type { UsageStatistics } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { ShakeMode } from "../session/shake-types";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import { TaskTool } from "../task";
import type { MacOSSandboxRelaunchResult } from "../task/omp-command";
import type { AgentOutputManager } from "../task/output-manager";
import { canSpawnAtDepth, type StructuredSubagentSchemaMode } from "../task/types";
import { countToolsForAutoDiscovery } from "../tool-discovery/mode";
import {
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	isMCPToolName,
	resolveEffectiveToolDiscoveryMode,
} from "../tool-discovery/tool-index";
import type { EventBus } from "../utils/event-bus";
import { WebSearchTool } from "../web/search";
import { WorkflowTool } from "../workflow";
import type { WorkspaceRoot } from "../workspace-roots";
import type { WorkspaceTree } from "../workspace-tree";
import { AskTool } from "./ask";
import { AstEditTool } from "./ast-edit";
import { AstGrepTool } from "./ast-grep";
import { BashTool } from "./bash";
import { BrowserTool } from "./browser";
import { type BuiltinToolName, type HiddenToolName, normalizeToolNames } from "./builtin-names";
import { type CheckpointState, CheckpointTool, type CompletedRewindState, RewindTool } from "./checkpoint";
import { CompactTool } from "./compact";
import { ComputerTool } from "./computer";
import { ConsultTool } from "./consult";
import { DebugTool } from "./debug";
import { EvalTool } from "./eval";
import { resolveEvalBackends } from "./eval-backends";
import { GithubTool } from "./gh";
import { GlobTool } from "./glob";
import { GrepTool } from "./grep";
import { HubTool, isIrcEnabled } from "./hub";
import { InspectImageTool } from "./inspect-image";
import { IrcTool } from "./irc";
import { JobTool } from "./job";
import { LaunchTool } from "./launch";
import { LearnTool } from "./learn";
import { LoopTool } from "./loop";
import { MacOSSandboxTool } from "./macos-sandbox";
import { ManageSkillTool } from "./manage-skill";
import { MemoryEditTool } from "./memory-edit";
import { MemoryRecallTool } from "./memory-recall";
import { MemoryReflectTool } from "./memory-reflect";
import { MemoryRetainTool } from "./memory-retain";
import { OrchestratorModeTool } from "./orchestrator-mode";
import { wrapToolWithMetaNotice } from "./output-meta";
import { createPresentTool } from "./present";
import { RateLearningTool } from "./rate-learning";
import { ReadTool } from "./read";
import { createReportToolIssueTool } from "./report-tool-issue";
import { type PlanProposalHandler, ResolveTool } from "./resolve";
import { reportFindingTool } from "./review";
import { SearchToolBm25Tool } from "./search-tool-bm25";
import { ShakeTool } from "./shake";
import { loadSshTool } from "./ssh";
import { SuperReviewTool } from "./super-review";
import { type TodoPhase, TodoTool } from "./todo";
import { WriteTool } from "./write";
import { isMountableUnderXdev, XdevRegistry } from "./xdev";
import { YieldTool } from "./yield";

export * from "../edit";
export * from "../goals";
export * from "../lsp";
export * from "../session/streaming-output";
export * from "../task";
export * from "../web/search";
export * from "../workflow";
export * from "./ask";
export * from "./ast-edit";
export * from "./ast-grep";
export * from "./bash";
export * from "./browser";
export * from "./checkpoint";
export * from "./compact";
export * from "./computer";
export * from "./computer/supervisor";
export * from "./debug";
export * from "./essential-tools";
export * from "./eval";
export * from "./eval-backends";
export * from "./gh";
export * from "./glob";
export * from "./grep";
export type {
	AgentActivitySnapshot,
	CancelOutcome,
	CancelStatus,
	CoordinationDetails,
	HubDetails,
	HubOp,
	HubPeerInfo,
	HubRenderArgs,
	JobSnapshot as HubJobSnapshot,
} from "./hub";
export { createIrcMessageCard, HubTool, hubErrorResult, hubToolRenderer } from "./hub";
export * from "./image-gen";
export * from "./inspect-image";
export * from "./irc";
export * from "./job";
export * from "./launch";
export * from "./learn";
export * from "./loop";
export * from "./macos-sandbox";
export * from "./manage-skill";
export * from "./memory-edit";
export * from "./memory-recall";
export * from "./memory-reflect";
export * from "./memory-retain";
export * from "./orchestrator-mode";
export * from "./present";
export * from "./rate-learning";
export * from "./read";
export * from "./report-tool-issue";
export * from "./resolve";
export * from "./review";
export * from "./search-tool-bm25";
export * from "./shake";
export * from "./ssh";
export * from "./super-review";
export * from "./todo";
export * from "./tts";
export * from "./vibe";
export * from "./write";
export * from "./xdev";
export * from "./yield";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
};

/** Image attachment handle exposed to tools for user-facing labels such as `Image #1`. */
export type ImageAttachmentEntry = {
	label: string;
	uri: string;
	image: ImageContent;
};

export type {
	DiscoverableTool,
	DiscoverableToolSearchIndex,
	DiscoverableToolSearchResult,
	DiscoverableToolSource,
} from "../tool-discovery/tool-index";

/** Scheduling result of an agent-initiated compaction request (the `compact` tool). */
export type ToolCompactionRequest =
	| { status: "scheduled" }
	| { status: "already-scheduled" }
	| { status: "unavailable"; detail: string };

/** Threshold check result for compaction considered while a tool is blocking. */
export type ToolWaitingCompactionCheck =
	| { status: "scheduled" }
	| { status: "already-scheduled" }
	| { status: "not-needed" }
	| { status: "unavailable"; detail: string };

/** Scheduling result of an agent-initiated shake request (the `shake` tool). */
export type ToolShakeRequest =
	| { status: "scheduled" }
	| { status: "already-scheduled" }
	| { status: "unavailable"; detail: string };
/**
 * A late LSP diagnostics result that arrived after the edit/write tool already
 * returned. Surfaced to the model and the transcript via
 * {@link ToolSession.queueDeferredDiagnostics}, batched through the session
 * yield queue like background-job results.
 */
export interface DeferredDiagnosticsEntry {
	/** Absolute path the diagnostics belong to (the renderer shortens it). */
	path: string;
	/** One-line severity summary, e.g. "2 errors". */
	summary: string;
	/** Formatted, ready-to-display diagnostic lines. */
	messages: string[];
	/** True when any message is error severity. */
	errored: boolean;
	/**
	 * Evaluated at injection time (in the dispatcher's stale check): drop the entry
	 * when a newer mutation to the same file has superseded it, so the model never
	 * sees diagnostics for stale content.
	 */
	isStale(): boolean;
}

/** Browser annotation submitted from the visible overlay while the agent is running or idle. */
export interface BrowserAnnotationEntry {
	tab: string;
	url: string;
	title?: string;
	text: string;
	screenshot: { data: string; mimeType: string };
	timestamp: number;
}

/** Structural loop scheduler surface for the `loop` tool. Session `LoopManager`
 *  satisfies this without a tools↔session import cycle. */
export interface ToolLoopManager {
	schedule(options: { prompt: string; intervalMs: number; count: number }): { readonly id: string };
	cancelAll(): void;
	readonly activeCount: number;
}

export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** Additional workspace directories beyond cwd (multi-root), forwarded to subagents. */
	additionalDirectories?: string[];
	/** Whether UI is available */
	hasUI: boolean;
	/**
	 * Suppress the spawn specialization/coordination advisory appended to `task`
	 * results. Set by internal/programmatic callers (e.g. the commit agent's
	 * file-analysis fan-out) whose results are consumed by code — not by a model
	 * orchestrating further spawns — so the nudge would only be noise.
	 */
	suppressSpawnAdvisory?: boolean;
	/** Optional fetch implementation injected into the URL read pipeline (tests, proxies). Defaults to global fetch. */
	fetch?: FetchImpl;
	/** Skip subprocess-kernel availability checks and warmup */
	skipPythonPreflight?: boolean;
	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded workspace tree (forwarded to subagents to skip re-scanning) */
	workspaceTree?: WorkspaceTree;
	/** Tagged workspace roots (--be/--fe/--add-dir), forwarded to subagents. */
	workspaceRoots?: WorkspaceRoot[];
	/** Pre-loaded skills */
	skills?: readonly Skill[];
	/** Rediscover live session skills after a tool mutates their backing files. */
	refreshSkills?: () => Promise<void>;
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Pre-loaded rules (forwarded to subagents to skip re-discovery). */
	rules?: Rule[];
	/**
	 * Pre-discovered extension source paths. Forwarded to subagents so they
	 * skip the FS scan but still re-bind extensions to their own session-scoped
	 * `ExtensionAPI` (cwd, eventBus, runtime). Inline extension factories
	 * (`<inline-N>`) are NOT included — those are session-local.
	 */
	extensionPaths?: string[];
	/**
	 * Pre-discovered custom-tool source paths from `.omp/tools/`, `.claude/tools/`,
	 * plugins, etc. Forwarded to subagents so they skip the FS scan but still
	 * re-bind tools to their own session-scoped `CustomToolAPI`.
	 */
	customToolPaths?: ToolPathWithSource[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Whether this invocation may expose IRC. `false` removes it even for subagents. */
	enableIrc?: boolean;
	/**
	 * Whether MCP capabilities may be forwarded to child sessions. `false`
	 * prohibits inherited-manager and process-global MCP fallback.
	 */
	enableMCP?: boolean;
	/** Whether an edit-capable tool is available in this session (controls hashline output) */
	hasEditTool?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents). */
	outputSchema?: unknown;
	/** Enforcement policy for {@link outputSchema}; defaults to legacy permissive behavior. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Session starts with a prewalk hand-off armed. Keeps `todo` in yield-gated
	 *  (subagent) registries: the prewalk plan nudge + todo gate need it. */
	prewalkArmed?: boolean;
	/**
	 * Constrain the active set to the caller's explicit built-in names (plus a
	 * required yield tool). Suppresses automatic tool-set expansion.
	 */
	restrictToolNames?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Get shared eval executor session ID. Subagents inherit this to share JS/Python/Ruby/Julia state. */
	getEvalSessionId?: () => string | null;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Parent session journal used by tools that persist runtime lifecycle state. */
	sessionManager?: Pick<SessionManager, "appendCustomEntry" | "ensureOnDisk" | "flush" | "getBranch" | "getEntries">;
	/** Get eval kernel owner ID for session-scoped retained-kernel cleanup. */
	getEvalKernelOwnerId?: () => string | null;
	/** Reject new eval work once session disposal has started. */
	assertEvalExecutionAllowed?: () => void;
	/** Track tool-owned eval work so session disposal can await/abort it like direct session eval runs. */
	trackEvalExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Get Hindsight runtime state for this agent session. */
	getHindsightSessionState?: () => HindsightSessionState | undefined;
	/** Get Mnemopi runtime state for this agent session. */
	getMnemopiSessionState?: () => MnemopiSessionState | undefined;
	/** Agent identity used for IRC routing. Returns the registry id (e.g. "Main", "AuthLoader"). */
	getAgentId?: () => string | null;
	/**
	 * True when context is queued for this agent that the next loop boundary
	 * would inject: pending IRC asides, idle-flushable yield-queue entries
	 * (other jobs' async-results), or queued steering messages. Blocking waits
	 * (`job` poll) return early so the boundary can inject it instead of
	 * sitting blind.
	 */
	hasPendingAgentAsides?: () => boolean;
	/** Look up a registered tool by name (used by the eval js backend's tool bridge). */
	getToolByName?: (name: string) => AgentTool | undefined;
	/** Return whether a built-in tool is active in this turn's tool set. */
	isToolActive?: (name: string) => boolean;
	/** Update the active built-in tool predicate when a session changes tools mid-run. */
	setActiveToolNames?: (names: Iterable<string>) => void;
	/** Tools mounted under `xd://` (set by createTools when `tools.xdev` is active); read/write consult it at execute time. */
	xdevRegistry?: XdevRegistry;
	/** Agent registry for IRC routing across live sessions. */
	agentRegistry?: AgentRegistry;
	/** Idle→parked→revive lifecycle owner; lets the hub kill a non-job-backed agent registration. Default: AgentLifecycleManager.global(). */
	agentLifecycle?: () => AgentLifecycleManager;
	/** Get artifacts directory for artifact:// URLs */
	getArtifactsDir?: () => string | null;
	/** Get the ArtifactManager backing this session (shared across parent + subagents). */
	getArtifactManager?: () => ArtifactManager | null;
	/** Allocate a new artifact path and ID for session-scoped truncated output. */
	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model context window, regardless of how it was chosen */
	getActiveModelContextWindow?: () => number | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Get the current session model object (provider/api capabilities), regardless of how it was chosen. */
	getActiveModel?: () => Model | undefined;
	/** Get the session's live per-family service tiers (undefined = none). Source of truth for subagent `tier.subagent: inherit`. */
	getServiceTierByFamily?: () => ServiceTierByFamily | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: import("../session/auth-storage").AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/**
	 * Async job manager scoped to this session.
	 *
	 * - Top-level session that constructed one: its own manager.
	 * - Subagent (`parentTaskPrefix` set): the parent's manager, so background
	 *   bash/task work and `onJobComplete` deliveries flow into the conversation
	 *   that spawned it.
	 * - Secondary in-process top-level session that found a singleton already
	 *   installed (issue #1923): `undefined`. Tools refuse async work rather
	 *   than silently route completions into the owning session's `yieldQueue`.
	 *
	 * Tools MUST use this instead of `AsyncJobManager.instance()` so a secondary
	 * session never borrows the owning session's manager by accident.
	 */
	asyncJobManager?: AsyncJobManager;
	/** MCP manager visible to subagents without relying on the process-global singleton. */
	mcpManager?: MCPManager;
	/** Local protocol root to propagate to nested subagents and eval-created agents. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Settings instance for passing to subagents */
	settings: Settings;
	/** Plan mode state (if active) */
	getPlanModeState?: () => PlanModeState | undefined;
	/** Orchestrator mode state (if active) */
	getOrchestratorModeState?: () => OrchestratorModeState | undefined;
	/** Duo auto model switch status (if a duo controller exists). */
	getDuoStatus?: () => DuoStatus | undefined;
	/** Switch Safe orchestrator mode for the active agent session. */
	setOrchestratorModeState?: (
		state: OrchestratorModeState | undefined,
		options?: { persistModeChange?: boolean; restorePreviousTools?: boolean; reuseRestoreSnapshot?: boolean },
	) => void | Promise<void>;
	/** Path of the session's active plan reference (e.g. `local://<title>.md`); defaults to `local://PLAN.md`. */
	getPlanReferencePath?: () => string;
	/** Goal mode state (if active or paused) */
	getGoalModeState?: () => GoalModeState | undefined;
	/** Goal runtime for the active agent session. */
	getGoalRuntime?: () => GoalRuntime | undefined;
	/** Get cumulative session usage statistics (input/output tokens, cost). */
	getUsageStatistics?: () => UsageStatistics;
	/** Current per-turn token budget {total, spent, hard} for the eval `budget` helper. */
	getTurnBudget?: () => { total: number | null; spent: number; hard: boolean };
	/** Record output tokens consumed by an eval-spawned subagent toward the current turn budget. */
	recordEvalSubagentUsage?: (output: number) => void;
	/** Bridge to the connected client (e.g. ACP editor host). Tools should route fs/terminal/permission requests through this when available. */
	getClientBridge?: () => ClientBridge | undefined;
	/** Get cached todo phases for this session. */
	getTodoPhases?: () => TodoPhase[];
	/** Replace cached todo phases for this session. */
	setTodoPhases?: (phases: TodoPhase[]) => void;
	/** Append a durable custom branch entry for tool-owned session state. */
	appendCustomEntry?: (customType: string, data?: unknown) => string;
	/** Mark the session as blocked inside a subagent wait tool. */
	enterSubagentWait?: () => void;
	/** Release a prior subagent wait marker, flushing held steering at depth zero. */
	exitSubagentWait?: () => void;
	/** Whether MCP tool discovery is active for this session. */
	isMCPDiscoveryEnabled?: () => boolean;
	/** Get MCP tools activated by prior search_tool_bm25 calls. */
	getSelectedMCPToolNames?: () => string[];
	/** Merge MCP tool selections into the active session tool set. */
	activateDiscoveredMCPTools?: (toolNames: string[]) => Promise<string[]>;
	// ── Generic tool discovery (unified — covers built-in + MCP + extension) ──
	/** Whether any form of tool discovery is active (tools.discoveryMode !== "off" or mcp.discoveryMode). */
	isToolDiscoveryEnabled?: () => boolean;
	/** Get all hidden-but-discoverable tools for search_tool_bm25 prompts. */
	getDiscoverableTools?: (filter?: {
		source?: import("../tool-discovery/tool-index").DiscoverableToolSource;
	}) => DiscoverableTool[];
	/** Get the cached generic discoverable search index. */
	getDiscoverableToolSearchIndex?: () => DiscoverableToolSearchIndex;
	/** Get tool names activated by prior search_tool_bm25 calls (all sources). */
	getSelectedDiscoveredToolNames?: () => string[];
	/** Merge tool selections into the active session tool set. */
	activateDiscoveredTools?: (toolNames: string[]) => Promise<string[]>;
	/** The tool-choice queue used to force forthcoming tool invocations and carry invocation handlers. */
	getToolChoiceQueue?(): ToolChoiceQueue;
	/** Build a model-provider-specific ToolChoice that targets the named tool, or undefined if unsupported. */
	buildToolChoice?(toolName: string): ToolChoice | undefined;
	/** Steer a hidden custom message into the conversation (e.g. a preview reminder). */
	steer?(message: { customType: string; content: string; details?: unknown }): void;
	/** Peek the currently in-flight tool-choice queue directive's invocation handler. Used by
	 *  the `xd://resolve` and `xd://reject` dispatch to reach the pending action. */
	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Peek the most-recently registered non-forcing pending preview invoker. A `write` to
	 *  `xd://resolve` or `xd://reject` dispatches to it so a staged preview resolves
	 *  WITHOUT forcing tool_choice — the agent-loop's SoftToolRequirement lifecycle owns
	 *  reminder injection and escalation. */
	peekPendingInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Clear stale pending preview markers when a resolution dispatch cannot run them. */
	clearPendingInvokers?(): void;
	/** Peek the plan-proposal handler installed by plan mode. `xd://propose` dispatches the
	 *  written plan title to it. */
	peekPlanProposalHandler?(): PlanProposalHandler | undefined;
	/** Register or clear the plan-proposal handler. Passing `null` clears it. */
	setPlanProposalHandler?(handler: PlanProposalHandler | null): void;
	/** Get active checkpoint state if any. */
	getCheckpointState?: () => CheckpointState | undefined;
	/** Set or clear active checkpoint state. */
	setCheckpointState?: (state: CheckpointState | null) => void;
	/** Get the most recent completed rewind, if this session just rewound a checkpoint. */
	getLastCompletedRewind?: () => CompletedRewindState | undefined;

	/** Per-session snapshot store of file contents as last shown to the model
	 *  by `read`/`search`. Used by hashline anchor-stale recovery to
	 *  reconstruct the version the model authored anchors against when the
	 *  file changed out-of-band. Lazily initialized by `getFileSnapshotStore`. */
	fileSnapshotStore?: InMemorySnapshotStore;

	/** Per-session log of unresolved git merge conflict regions surfaced by
	 *  `read`. Each entry gets a stable id N referenced by `write conflict://N`
	 *  to splice the recorded region with replacement content. Lazily initialized
	 *  by `getConflictHistory`. */
	conflictHistory?: import("./conflict-detect").ConflictHistory;

	/** Per-session ledger of post-edit LSP diagnostics already surfaced to the
	 *  model for each file. Lazily initialized by `getDiagnosticsLedger`. */
	diagnosticsLedger?: import("../lsp/diagnostics-ledger").DiagnosticsLedger;

	/** Per-session ledger of consecutive byte-identical no-op edits, keyed by
	 *  canonical file path. The hashline executor escalates a soft no-op hint
	 *  to a thrown error once the same payload no-ops `NOOP_HARD_LIMIT` times,
	 *  breaking subagent loops that ignore the textual hint (issue #2081).
	 *  Lazily initialized by `getNoopLoopGuard`. */
	noopLoopGuard?: import("../edit/hashline/noop-loop-guard").NoopLoopGuard;

	/** Queue a hidden message to be injected at the next agent turn. */
	queueDeferredMessage?(message: CustomMessage): void;
	/** Request a compaction at the next turn boundary. Returns scheduling status. */
	requestCompaction?(reason: string, options?: { focus?: string }): ToolCompactionRequest;
	/** Check whether blocking waits should schedule compaction at the next turn boundary. */
	considerCompactionWhileWaiting?(reason: string, options?: { focus?: string }): ToolWaitingCompactionCheck;
	/** Request a context shake at the next turn boundary. Returns scheduling status. */
	requestShake?(mode: ShakeMode): ToolShakeRequest;
	/** Request the macOS sandbox supervisor to relaunch this session with extra sandbox allowlist roots. */
	requestMacOSSandboxRelaunch?(paths: string[]): MacOSSandboxRelaunchResult;
	/** Queue late LSP diagnostics (arrived after an edit/write returned) to be shown
	 *  in the transcript and delivered to the model at the next yield, like background
	 *  job results. */
	queueDeferredDiagnostics?(entry: DeferredDiagnosticsEntry): void;
	/** Queue browser annotation feedback from the visible overlay; wakes idle agents like async job results. */
	queueBrowserAnnotation?(entry: BrowserAnnotationEntry): void;
	/** Queue product-preview side-ask/comment/answer feedback into the owner session. */
	queuePreviewFeedback?(feedback: PreviewFeedback): void;

	/** Bump and return the session-global mutation counter for `path`. Edit/write
	 *  tools call this on every file mutation so stale late-diagnostics can be dropped. */
	bumpFileMutationVersion?(path: string): number;
	/** Read the current session-global mutation counter for `path` (0 if never mutated). */
	getFileMutationVersion?(path: string): number;
	/** Get the active OpenTelemetry config so subagent dispatch can forward
	 *  the parent's tracer/hooks with the subagent's own identity stamped. */
	getTelemetry?: () => AgentTelemetryConfig | undefined;
	/** Return image attachments visible to tools for resolving labels such as `Image #1`. */
	getImageAttachments?: () => ImageAttachmentEntry[];
	/**
	 * "Phone a friend": ask the always-watching advisor a question mid-turn and
	 * block until it answers. Resolves with the advisor's plain-text reply, or
	 * `null` when the advisor is inactive / did not answer in time / was aborted.
	 * Used by the `consult` tool.
	 */
	consultAdvisor?: (question: string, signal?: AbortSignal) => Promise<string | null>;
	/** Fire-and-forget consult; advisor answers later through its advice channel. */
	consultAdvisorAsync?: (question: string) => boolean;
	/** Whether an advisor runtime is currently live for this session. */
	isAdvisorActive?: () => boolean;
	/**
	 * Whether this session will run an advisor at all. Resolved, not raw:
	 * `advisor.enabled` defaults off for models that opt out (see
	 * `resolveAdvisorEnabled`), so the raw setting would leak a dead `consult`
	 * tool into those sessions.
	 */
	isAdvisorEnabled?: () => boolean;
	/** Handoff an approved duo planner/takeover turn back to the executor. */
	duoHandoffToExecutor?: (resolution: string, scope?: DuoExecutionScope) => Promise<DuoHandoffResult>;
	/** Escalate an executor turn back to the duo planner. */
	duoEscalateToPlanner?: (reason: string) => Promise<"ok" | "unavailable">;
	/** Session-scoped loop scheduler for the `loop` tool. Iterations are delivered as
	 *  follow-up turns; all loops are cancelled on session dispose/reset. Undefined in
	 *  sessions that cannot host loops (e.g. secondary in-process sessions). */
	getLoopManager?: () => ToolLoopManager | undefined;
}

export type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export type BuiltinToolLoadMode = "essential" | "discoverable";

/** Default essential tool names when tools.essentialOverride is empty. */
export const DEFAULT_ESSENTIAL_TOOL_NAMES: readonly string[] = [
	"orchestrator_mode",
	"read",
	"bash",
	"launch",
	"edit",
	"write",
	"glob",
	"eval",
	"task",
	"todo",
	"browser",
	"super_review",
] as const;

/**
 * Resolve the active essential built-in tool names from settings.
 * Returns `tools.essentialOverride` if non-empty (filtered to known built-ins),
 * otherwise `DEFAULT_ESSENTIAL_TOOL_NAMES`.
 */
export function computeEssentialBuiltinNames(settings: Settings): string[] {
	const override = settings.get("tools.essentialOverride") ?? [];
	const cleaned = normalizeToolNames(override.map(name => name.trim()).filter(Boolean));
	if (cleaned.length > 0) {
		return cleaned.filter(name => name in BUILTIN_TOOLS);
	}
	return [...DEFAULT_ESSENTIAL_TOOL_NAMES];
}

/**
 * Filter the initial active tool set when `tools.discoveryMode === "all"`.
 *
 * Non-essential discoverable built-ins are hidden — the model rediscovers them
 * via `search_tool_bm25` and activates them on demand. A tool survives hiding
 * when it is essential, explicitly requested, restored from a prior selection,
 * or required by a forced tool_choice feature (`forceActive`). The last case is
 * load-bearing: a named tool_choice (e.g. the eager `todo` prelude) must
 * reference a tool present in the request, or the provider rejects it with 400.
 */
export function filterInitialToolsForDiscoveryAll(
	initialToolNames: string[],
	opts: {
		loadModeOf: (name: string) => BuiltinToolLoadMode | undefined;
		essentialNames: ReadonlySet<string>;
		explicitlyRequested: ReadonlySet<string>;
		restored: ReadonlySet<string>;
		forceActive: ReadonlySet<string>;
	},
): string[] {
	return initialToolNames.filter(name => {
		const loadMode = opts.loadModeOf(name);
		if (!loadMode) return true; // not a built-in — leave MCP/custom/extension to existing logic
		if (loadMode === "essential") return true;
		if (opts.essentialNames.has(name)) return true;
		if (opts.explicitlyRequested.has(name)) return true;
		if (opts.restored.has(name)) return true;
		if (opts.forceActive.has(name)) return true;
		return false;
	});
}
/**
 * Public callable factory map. External callers may invoke `BUILTIN_TOOLS.read(session)` or
 * `BUILTIN_TOOLS[name](session)` to construct a tool directly.
 */
export const BUILTIN_TOOLS: Record<BuiltinToolName | "rate_learning" | "sandbox", ToolFactory> = {
	orchestrator_mode: s => new OrchestratorModeTool(s),
	duo_handoff: s =>
		new DuoHandoffTool(async (resolution, scope) => {
			return (await s.duoHandoffToExecutor?.(resolution, scope)) ?? "no-controller";
		}),
	duo_escalate: s => new DuoEscalateTool(async reason => (await s.duoEscalateToPlanner?.(reason)) ?? "unavailable"),
	read: s => new ReadTool(s),
	bash: s => new BashTool(s),
	launch: s => new LaunchTool(s),
	edit: s => new EditTool(s),
	ast_grep: s => new AstGrepTool(s),
	ast_edit: s => new AstEditTool(s),
	ask: AskTool.createIf,
	debug: DebugTool.createIf,
	eval: s => new EvalTool(s),
	ssh: loadSshTool,
	sandbox: s => new MacOSSandboxTool(s),
	github: GithubTool.createIf,
	glob: s => new GlobTool(s, { rootPathAlias: true }),
	grep: s => new GrepTool(s),
	lsp: LspTool.createIf,
	inspect_image: s => new InspectImageTool(s),
	browser: s => new BrowserTool(s),
	computer: s => new ComputerTool(s),
	checkpoint: CheckpointTool.createIf,
	rewind: RewindTool.createIf,
	compact: CompactTool.createIf,
	shake: ShakeTool.createIf,
	task: s => TaskTool.create(s),
	hub: s => new HubTool(s),
	workflow: s => WorkflowTool.create(s),
	job: s => new JobTool(s),
	loop: LoopTool.createIf,
	irc: IrcTool.createIf,
	todo: s => new TodoTool(s),
	web_search: s => new WebSearchTool(s),
	search_tool_bm25: SearchToolBm25Tool.createIf,
	write: s => new WriteTool(s),
	memory_edit: MemoryEditTool.createIf,
	retain: MemoryRetainTool.createIf,
	recall: MemoryRecallTool.createIf,
	reflect: MemoryReflectTool.createIf,
	learn: LearnTool.createIf,
	rate_learning: RateLearningTool.createIf,
	manage_skill: ManageSkillTool.createIf,
	consult: s => new ConsultTool(s),
	super_review: s => new SuperReviewTool(s),
	// Session-receiving factory: enqueue preview feedback into the owner yieldQueue.
	present: s =>
		createPresentTool({
			startServer: startPreviewServer,
			deliverFeedback: s.queuePreviewFeedback ? feedback => s.queuePreviewFeedback?.(feedback) : undefined,
		}),
};

export const HIDDEN_TOOLS: Record<HiddenToolName, ToolFactory> = {
	yield: s => new YieldTool(s),
	report_finding: () => reportFindingTool,
	report_tool_issue: s => createReportToolIssueTool(s),
	resolve: s => new ResolveTool(s),
	goal: s => new GoalTool(s),
	get_goal: s => new GetGoalTool(s),
	create_goal: s => new CreateGoalTool(s),
	update_goal: s => new UpdateGoalTool(s),
};

export type ToolName = BuiltinToolName;

export const CODEX_GOAL_HIDDEN_TOOL_NAMES = ["get_goal", "create_goal", "update_goal"] as const;
export const GOAL_HIDDEN_TOOL_NAMES = ["goal", ...CODEX_GOAL_HIDDEN_TOOL_NAMES] as const;

export function isGoalHiddenToolName(name: string): boolean {
	return GOAL_HIDDEN_TOOL_NAMES.some(goalToolName => goalToolName === name);
}

function isCodexGoalHiddenToolName(name: string): boolean {
	return CODEX_GOAL_HIDDEN_TOOL_NAMES.some(goalToolName => goalToolName === name);
}

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const restrictToolNames = session.restrictToolNames === true;
	const includeYield = session.requireYieldTool === true;
	const enableLsp = session.enableLsp ?? true;
	const requestedTools = toolNames && toolNames.length > 0 ? normalizeToolNames(toolNames) : undefined;
	const goalEnabled = session.settings.get("goal.enabled");
	const goalModeActive = goalEnabled && session.getGoalModeState?.()?.enabled === true;
	if (goalModeActive && requestedTools) {
		for (const name of GOAL_HIDDEN_TOOL_NAMES) {
			if (!requestedTools.includes(name)) {
				requestedTools.push(name);
			}
		}
	}
	const backends = resolveEvalBackends(session);
	const allowPython = backends.python;
	const allowJs = backends.js;
	const allowRuby = backends.ruby;
	const allowJulia = backends.julia;
	const skipEvalPreflight = session.skipPythonPreflight === true;
	// Eval tool is enabled if ANY backend is reachable. JS needs no preflight, so
	// we only probe Python/Ruby/Julia when JS is disabled — otherwise allowEval is
	// already true and per-backend availability is checked at first invocation.
	let pythonAvailable = true;
	let rubyAvailable = true;
	let juliaAvailable = true;
	const evalRequested = requestedTools === undefined || requestedTools.includes("eval");
	if (!skipEvalPreflight && !allowJs && evalRequested) {
		if (allowPython) {
			const availability = await logger.time(
				"createTools:pythonCheck",
				checkPythonKernelAvailability,
				session.cwd,
				session.settings.get("python.interpreter")?.trim() || undefined,
			);
			pythonAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Python kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowRuby) {
			const availability = await checkRubyKernelAvailability(
				session.cwd,
				session.settings.get("ruby.interpreter")?.trim() || undefined,
			);
			rubyAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Ruby kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowJulia) {
			const availability = await checkJuliaKernelAvailability(
				session.cwd,
				session.settings.get("julia.interpreter")?.trim() || undefined,
			);
			juliaAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Julia kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
	}

	const effectivePythonAllowed = allowPython && pythonAvailable;
	const effectiveRubyAllowed = allowRuby && rubyAvailable;
	const effectiveJuliaAllowed = allowJulia && juliaAvailable;
	// Eval is exposed whenever any backend is reachable. A backend may be
	// unreachable, in which case eval dispatches exclusively to the others.
	const allowEval = effectivePythonAllowed || allowJs || effectiveRubyAllowed || effectiveJuliaAllowed;

	// Auto-include AST counterparts when their text-based sibling is present.
	// Restricted callers own the active list and must not have it widened.
	if (requestedTools && !restrictToolNames) {
		if (goalModeActive && !requestedTools.includes("goal")) {
			requestedTools.push("goal");
		}
		if (
			requestedTools.includes("grep") &&
			!requestedTools.includes("ast_grep") &&
			session.settings.get("astGrep.enabled")
		) {
			requestedTools.push("ast_grep");
		}
		if (
			requestedTools.includes("edit") &&
			!requestedTools.includes("ast_edit") &&
			session.settings.get("astEdit.enabled")
		) {
			requestedTools.push("ast_edit");
		}
		if (["hindsight", "mnemopi"].includes(session.settings.get("memory.backend") ?? "")) {
			for (const name of ["recall", "retain", "reflect"]) {
				if (!requestedTools.includes(name)) requestedTools.push(name);
			}
		}
		if (session.settings.get("memory.backend") === "mnemopi" && !requestedTools.includes("memory_edit")) {
			requestedTools.push("memory_edit");
		}
		// Auto-learn tools are gated by `autolearn.enabled` but, like the memory
		// tools above, must also be force-included into an explicit requestedTools
		// list so a restricted top-level session whose controller/guidance is
		// active still exposes the tools the nudge points at. Gated to top-level
		// (taskDepth 0): the controller only runs there, so a subagent's explicit
		// tool whitelist must never be silently widened with write-capable tools.
		if (session.settings.get("autolearn.enabled") && (session.taskDepth ?? 0) === 0) {
			if (!requestedTools.includes("manage_skill")) requestedTools.push("manage_skill");
			if (
				["hindsight", "mnemopi", "local"].includes(session.settings.get("memory.backend") ?? "") &&
				!requestedTools.includes("learn")
			) {
				requestedTools.push("learn");
			}
		}
		if (session.settings.get("learning.enabled") && (session.taskDepth ?? 0) === 0) {
			if (!requestedTools.includes("rate_learning")) requestedTools.push("rate_learning");
		}
	}
	const effectiveDiscoveryMode = resolveEffectiveToolDiscoveryMode(
		session.settings,
		{ contextWindow: session.getActiveModelContextWindow?.() },
		countToolsForAutoDiscovery((requestedTools ?? Object.keys(BUILTIN_TOOLS)).filter(isMCPToolName)),
	);
	const discoveryActive = effectiveDiscoveryMode !== "off";
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const isToolAllowed = (name: string) => {
		if (name === "goal") return goalEnabled && goalModeActive;
		if (isCodexGoalHiddenToolName(name)) return goalEnabled;
		if (name === "lsp") return enableLsp && session.settings.get("lsp.enabled");
		if (name === "bash") return session.settings.get("bash.enabled");
		if (name === "launch") return session.settings.get("launch.enabled");
		if (name === "eval") return allowEval;
		if (name === "debug") return session.settings.get("debug.enabled");
		if (name === "todo")
			return (!includeYield || session.prewalkArmed === true) && session.settings.get("todo.enabled");
		if (name === "glob") return session.settings.get("glob.enabled");
		if (name === "grep") return session.settings.get("grep.enabled");
		if (name === "github") return session.settings.get("github.enabled");
		if (name === "ast_grep") return session.settings.get("astGrep.enabled");
		if (name === "ast_edit") return session.settings.get("astEdit.enabled");
		if (name === "inspect_image") return session.settings.get("inspect_image.enabled");
		if (name === "web_search") return session.settings.get("web_search.enabled");
		if (name === "search_tool_bm25") return discoveryActive;
		if (name === "ask") return session.settings.get("ask.enabled");
		if (name === "browser") return session.settings.get("browser.enabled");
		if (name === "computer") return session.settings.get("computer.enabled");
		if (name === "checkpoint" || name === "rewind") return session.settings.get("checkpoint.enabled");
		if (name === "compact") return session.settings.get("compaction.strategy") !== "off";
		if (name === "irc") return isIrcEnabled(session.settings, session.taskDepth ?? 0);
		if (name === "retain" || name === "recall" || name === "reflect") {
			return ["hindsight", "mnemopi"].includes(session.settings.get("memory.backend") ?? "");
		}
		if (name === "memory_edit") return session.settings.get("memory.backend") === "mnemopi";
		if (name === "manage_skill") return session.settings.get("autolearn.enabled") && (session.taskDepth ?? 0) === 0;
		if (name === "learn") {
			return (
				session.settings.get("autolearn.enabled") &&
				(session.taskDepth ?? 0) === 0 &&
				["hindsight", "mnemopi", "local"].includes(session.settings.get("memory.backend") ?? "")
			);
		}
		if (name === "rate_learning") {
			return session.settings.get("learning.enabled") && (session.taskDepth ?? 0) === 0;
		}
		if (name === "task") {
			return canSpawnAtDepth(session.settings.get("task.maxRecursionDepth") ?? 2, session.taskDepth ?? 0);
		}
		if (name === "workflow") {
			return session.settings.get("workflow.enabled") === true && (session.taskDepth ?? 0) === 0;
		}
		if (name === "loop") {
			return (session.taskDepth ?? 0) === 0 && typeof session.getLoopManager === "function";
		}
		// Deliberate compound gate: `advisor.consult` defaults true, so gating on
		// it alone would drop a dead `consult` tool into every non-advisor session.
		// Mid-session advisor enablement gets the tool at the next session build;
		// the prompt block is `{{#has tools "consult"}}`-guarded so prompts follow.
		if (name === "consult") {
			const advisorOn = session.isAdvisorEnabled?.() ?? session.settings.get("advisor.enabled") === true;
			return (advisorOn || session.isAdvisorActive?.()) && session.settings.get("advisor.consult") !== false;
		}
		return true;
	};
	if (includeYield && requestedTools && !requestedTools.includes("yield")) {
		requestedTools.push("yield");
	}

	const filteredRequestedTools = requestedTools?.filter(name => name in allTools && isToolAllowed(name));
	const resolveEntry = [["resolve", HIDDEN_TOOLS.resolve] as const];
	const baseEntries =
		filteredRequestedTools !== undefined
			? [
					...filteredRequestedTools
						.filter(name => name !== "resolve")
						.map(name => [name, allTools[name]] as const),
					...(!restrictToolNames ? resolveEntry : []),
				]
			: [
					...Object.entries(BUILTIN_TOOLS)
						.filter(([name]) => isToolAllowed(name))
						.map(([name, factory]) => [name, factory] as const),
					...(includeYield ? ([["yield", HIDDEN_TOOLS.yield]] as const) : []),
					...(goalEnabled ? CODEX_GOAL_HIDDEN_TOOL_NAMES.map(name => [name, HIDDEN_TOOLS[name]] as const) : []),
					...(goalModeActive ? ([["goal", HIDDEN_TOOLS.goal]] as const) : []),
					...(!restrictToolNames ? resolveEntry : []),
				];

	const activeToolNames = new Set(baseEntries.map(([name]) => name));
	if (session.setActiveToolNames) {
		session.setActiveToolNames(activeToolNames);
	} else {
		session.isToolActive = name => activeToolNames.has(name);
	}

	const baseResults = await Promise.all(
		baseEntries.map(async ([name, factory]) => {
			const tool = await logger.time(`createTools:${name}`, factory as ToolFactory, session);
			return tool ? wrapToolWithMetaNotice(tool) : null;
		}),
	);
	let tools = baseResults.filter((r): r is Tool => r !== null);

	// Ordinary sessions use xd:// for discoverable built-ins, custom tools, and
	// MCP tools. Structured children must expose only their host-provided names,
	// so never allocate a registry that later SDK assembly could populate.
	// Explicitly requested built-ins retain their top-level presentation.
	const xdevEnabled = !restrictToolNames && session.settings.get("tools.xdev");
	const mountBuiltinTools = requestedTools === undefined;
	if (xdevEnabled) {
		const mounted: Tool[] = [];
		const kept: Tool[] = [];
		for (const tool of tools) {
			const mountable = mountBuiltinTools && isMountableUnderXdev(tool) && tool.name in BUILTIN_TOOLS;
			(mountable ? mounted : kept).push(tool);
		}
		session.xdevRegistry = new XdevRegistry(mounted);
		tools = kept;
		const finalActiveNames = new Set(tools.map(tool => tool.name));
		if (session.setActiveToolNames) {
			session.setActiveToolNames(finalActiveNames);
		} else {
			session.isToolActive = name => finalActiveNames.has(name);
		}
	}
	// The xd:// transport rides read/write: `read xd://` lists+documents devices,
	// `write xd://<tool>` executes them. Staged previews from deferrable tools
	// (e.g. ast_edit) also resolve through a `write` to xd://resolve/reject. Retain
	// both whenever any device is mounted or a deferrable tool can stage one.
	const xdevMounted = (session.xdevRegistry?.size ?? 0) > 0;
	if (
		!restrictToolNames &&
		(tools.some(tool => tool.deferrable === true) || xdevMounted) &&
		!tools.some(tool => tool.name === "write")
	) {
		const writeTool = await logger.time("createTools:write", BUILTIN_TOOLS.write, session);
		if (writeTool) {
			tools.push(wrapToolWithMetaNotice(writeTool));
		}
	}
	if (!restrictToolNames && xdevMounted && !tools.some(tool => tool.name === "read")) {
		const readTool = await logger.time("createTools:read", BUILTIN_TOOLS.read, session);
		if (readTool) {
			tools.push(wrapToolWithMetaNotice(readTool));
		}
	}

	return tools;
}
