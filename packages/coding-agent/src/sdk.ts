import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	appendContextGcSystemPrompt,
	createContextGcExtension,
	setDefaultContextGcDbPath,
} from "@oh-my-pi/context-gc-plugin";
import { createDelegationReminderExtension, DELEGATION_REMINDER_LABEL } from "@oh-my-pi/delegation-reminder-plugin";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentOptions,
	type AgentTelemetryConfig,
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	AppendOnlyContextManager,
	filterProviderReplayMessages,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import {
	type ApiKeyResolver,
	type Context,
	type CredentialDisabledEvent,
	Effort,
	type ImageContent,
	type Message,
	type Model,
	type ModelUsageHealth,
	type ProviderSessionState,
	resolveModelServiceTier,
	type SimpleStreamOptions,
	type TextContent,
} from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { FALLBACK_DIALECT, preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	$env,
	$flag,
	getAgentDir,
	getProjectDir,
	logger,
	postmortem,
	prompt,
	reportSoftCrash,
	Snowflake,
} from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import {
	appendSystemContextReminderPrompt,
	createSystemContextReminderExtension,
	SYSTEM_CONTEXT_REMINDER_LABEL,
} from "@oh-my-pi/system-context-reminder-plugin";
import {
	discoverAdvisorConfigs,
	discoverWatchdogFiles,
	formatActiveRepoWatchdogPrompt,
	formatAdvisorContextPrompt,
} from "./advisor";
import { type AsyncJob, AsyncJobManager } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { createAutoresearchExtension } from "./autoresearch";
import { loadCapability } from "./capability";
import { type Rule, ruleCapability, setActiveRules } from "./capability/rule";
import { bucketRules } from "./capability/rule-buckets";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { shouldInlineToolDescriptors } from "./config/inline-tool-descriptors-mode";
import { isAuthenticated, kNoAuth, ModelRegistry } from "./config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	resolveAllowedModels,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "./config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { buildServiceTierByFamily } from "./config/service-tier";
import { resolveThinkingDisplay, Settings, type SkillsSettings } from "./config/settings";
import { CursorExecHandlers } from "./cursor";
import "./discovery";
import { applyProviderGlobalsFromSettings } from "./config/provider-globals";
import { initializeWithSettings } from "./discovery";
import { disposeAllJuliaKernelSessions, disposeJuliaKernelSessionsByOwner } from "./eval/jl/executor";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
import { disposeAllRubyKernelSessions, disposeRubyKernelSessionsByOwner } from "./eval/rb/executor";
import { defaultEvalSessionId } from "./eval/session-id";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import {
	createHerdrAgentStateExtension,
	HERDR_MANAGED_FALLBACK_SENTINEL,
	isNativeHerdrAgentStateEnabled,
} from "./extensibility/extensions/herdr-agent-state";
import {
	loadSkills as loadSkillsInternal,
	type Skill,
	type SkillWarning,
	setActiveSkills,
} from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import type { HindsightSessionState } from "./hindsight/state";
import { LocalProtocolHandler, type LocalProtocolOptions } from "./internal-urls";
import { buildLearningDeveloperInstructions, startLearningStartupTask } from "./learnings";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import {
	discoverAndLoadMCPTools,
	type MCPLoadResult,
	MCPManager,
	MCPToolCache,
	type MCPToolsLoadResult,
	parseMCPToolName,
} from "./mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory-backend";
import { MEMORY_BACKEND_TOOL_NAMES } from "./memory-backend/tool-names";
import type { MnemopiSessionState } from "./mnemopi/state";
import { formatPreviewFeedback } from "./product-preview/feedback";
import type { PreviewFeedback } from "./product-preview/types";
import asyncResultTemplate from "./prompts/tools/async-result.md" with { type: "text" };
import browserAnnotationTemplate from "./prompts/tools/browser-annotation.md" with { type: "text" };
import lateDiagnosticTemplate from "./prompts/tools/lsp-late-diagnostic.md" with { type: "text" };
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
import {
	collectEnvSecrets,
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	getExistingSecretPlaceholderKey,
	getSecretPlaceholderKey,
	loadSecrets,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
	secretEntriesNeedPlaceholderKey,
} from "./secrets";
import {
	AgentSession,
	type InitialRetryFallbackState,
	type PlanYolo,
	type Prewalk,
	type ReasoningSlide,
	type SystemPromptRebuildContext,
} from "./session/agent-session";
import {
	type DiscoverAuthStorageOptions,
	discoverAuthStorage as discoverAuthStorageFromConfig,
} from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { getCodexSnapcompactProviderContextMaxBytes } from "./session/codex-payload-limits";
import { createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import {
	BROWSER_ANNOTATION_MESSAGE_TYPE,
	type CustomMessage,
	convertToLlm,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	MAX_BACKGROUND_BROWSER_ANNOTATIONS,
	PREVIEW_FEEDBACK_MESSAGE_TYPE,
	replaceLlmImagesWithText,
	stripOversizedCompactionSummaryImagesForCodex,
	USER_INTERRUPT_LABEL,
	wrapSteeringForModel,
} from "./session/messages";
import { clampProviderContextImages } from "./session/provider-image-budget";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "./session/retry-fallback-chains";
import { resolveAdvisorEnabled } from "./session/session-advisors";
import { getRestorableSessionModels } from "./session/session-context";
import { SessionManager } from "./session/session-manager";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { SnapcompactInlineTransformer } from "./session/snapcompact-inline";
import { createSnapcompactSavingsRecorder } from "./session/snapcompact-savings-journal";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { requestMacOSSandboxRelaunch } from "./task/omp-command";
import { AgentOutputManager } from "./task/output-manager";
import { wrapStreamFnWithProviderConcurrency } from "./task/provider-concurrency";
import type { StructuredSubagentSchemaMode } from "./task/types";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "./thinking";
import { countToolsForAutoDiscovery } from "./tool-discovery/mode";
import {
	collectDiscoverableTools,
	type DiscoverableTool,
	filterBySource,
	formatDiscoverableToolServerSummary,
	isMCPToolName,
	resolveEffectiveToolDiscoveryMode,
	selectDiscoverableToolNamesByServer,
	summarizeDiscoverableTools,
} from "./tool-discovery/tool-index";
import {
	BashTool,
	type BrowserAnnotationEntry,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	createVibeTools,
	type DeferredDiagnosticsEntry,
	defaultLoadModeForToolName,
	discoverStartupLspServers,
	EditTool,
	EvalTool,
	filterInitialToolsForDiscoveryAll,
	GlobTool,
	GOAL_HIDDEN_TOOL_NAMES,
	GrepTool,
	getSearchTools,
	HIDDEN_TOOLS,
	isMountableUnderXdev,
	type LspStartupServerInfo,
	loadSshTool,
	MacOSSandboxTool,
	ReadTool,
	releaseComputerSessionsForOwner,
	renderSearchToolBm25Description,
	SearchToolBm25Tool,
	type Tool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
	warmupLspServers,
} from "./tools";
import { normalizeToolName, normalizeToolNames } from "./tools/builtin-names";
import { ToolContextStore } from "./tools/context";
import { isIrcEnabled } from "./tools/hub";
import { getImageGenTools } from "./tools/image-gen";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { isAutoQaEnabled } from "./tools/report-tool-issue";
import { queueResolveHandler } from "./tools/resolve";
import { ttsTool } from "./tools/tts";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import { EventBus } from "./utils/event-bus";
import { buildNamedToolChoice } from "./utils/tool-choice";
import { VibeSessionRegistry } from "./vibe/runtime";
import { hydrateWorkspaceRoots, type WorkspaceRoot } from "./workspace-roots";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

const HERDR_MANAGED_AGENT_STATE_EXTENSION_FILENAME = "herdr-omp-agent-state.ts";
const HERDR_NATIVE_AGENT_STATE_EXTENSION_PATH = "<native-herdr-agent-state>";

function isManagedHerdrAgentStateExtensionPath(extensionPath: string): boolean {
	return path.basename(extensionPath) === HERDR_MANAGED_AGENT_STATE_EXTENSION_FILENAME;
}

function isHerdrAgentStateExtensionPath(extensionPath: string): boolean {
	return (
		extensionPath === HERDR_NATIVE_AGENT_STATE_EXTENSION_PATH || isManagedHerdrAgentStateExtensionPath(extensionPath)
	);
}

function filterSubagentExtensionPaths(extensionPaths: string[], isSubagentSession: boolean): string[] {
	if (!isSubagentSession) return extensionPaths;
	return extensionPaths.filter(extensionPath => !isHerdrAgentStateExtensionPath(extensionPath));
}

type AsyncResultEntry = {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
};

type AsyncResultJobDetails = {
	jobId: string;
	type?: "bash" | "task" | "workflow";
	label?: string;
	durationMs?: number;
};

type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};
type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

type BrowserAnnotationDetails = {
	annotations: Array<{ tab: string; url: string; title?: string; timestamp: number }>;
};
function escapeBrowserAnnotationText(value: string): string {
	return value.replace(/[&<>]/g, char => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			default:
				return char;
		}
	});
}

function buildBrowserAnnotationBatchMessage(
	entries: BrowserAnnotationEntry[],
): CustomMessage<BrowserAnnotationDetails> | null {
	if (entries.length === 0) return null;
	const multiple = entries.length > 1;
	const count = entries.length;
	const annotations: BrowserAnnotationDetails["annotations"] = [];
	for (const entry of entries) {
		const annotation: BrowserAnnotationDetails["annotations"][number] = {
			tab: entry.tab,
			url: entry.url,
			timestamp: entry.timestamp,
		};
		if (entry.title !== undefined) annotation.title = entry.title;
		annotations.push(annotation);
	}
	const content: (TextContent | ImageContent)[] = [];
	for (const [index, entry] of entries.entries()) {
		const annotation = {
			tab: escapeBrowserAnnotationText(entry.tab),
			text: escapeBrowserAnnotationText(entry.text),
		};
		content.push({
			type: "text",
			text: prompt.render(browserAnnotationTemplate, {
				annotation,
				multiple,
				index: index + 1,
				count,
			}),
		});
		content.push({ type: "image", data: entry.screenshot.data, mimeType: entry.screenshot.mimeType });
	}
	return {
		role: "custom",
		customType: BROWSER_ANNOTATION_MESSAGE_TYPE,
		content,
		display: true,
		attribution: "user",
		details: { annotations },
		timestamp: Date.now(),
	};
}

/** Build a visible custom steering message for product-preview feedback. */
function buildPreviewFeedbackBatchMessage(
	entries: PreviewFeedback[],
): CustomMessage<{ feedbacks: PreviewFeedback[] }> | null {
	if (entries.length === 0) return null;
	// One text block per event so multiple rapid comments/answers stay ordered
	// and each retains its full markdown body for the model.
	const content = entries.map(entry => ({
		type: "text" as const,
		text: formatPreviewFeedback(entry),
	}));
	return {
		role: "custom",
		customType: PREVIEW_FEEDBACK_MESSAGE_TYPE,
		content,
		display: true,
		// User-attribution marks this as steering-class human feedback, not agent.
		attribution: "user",
		details: { feedbacks: entries },
		timestamp: Date.now(),
	};
}

function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
	};
	return {
		role: "custom",
		customType: "async-result",
		content: prompt.render(asyncResultTemplate, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}
type LateDiagnosticsDetails = {
	files: Array<{ path: string; summary: string; errored: boolean; messages: string[] }>;
};

function buildLateDiagnosticsBatchMessage(
	entries: DeferredDiagnosticsEntry[],
): CustomMessage<LateDiagnosticsDetails> | null {
	if (entries.length === 0) return null;
	const files = entries.map(entry => ({
		path: entry.path,
		summary: entry.summary,
		messages: entry.messages,
		errored: entry.errored,
	}));
	const details: LateDiagnosticsDetails = {
		files: files.map(file => ({
			path: file.path,
			summary: file.summary,
			errored: file.errored,
			messages: file.messages,
		})),
	};
	return {
		role: "custom",
		customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
		content: prompt.render(lateDiagnosticTemplate, {
			multiple: files.length > 1,
			files,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}

type DeferredMCPActivation = {
	mcpDiscoveryEnabled: boolean;
	explicitlyRequestedMCPToolNames: string[];
	activateAllMCPTools: boolean;
};

/** Combined text-block cap for advisor read-only tool results (chars). */
const ADVISOR_TOOL_OUTPUT_CAP = 12_000;
/** Marker so double-wrapping a tool's execute is a no-op. */
const kAdvisorOutputClamped = Symbol("advisorOutputClamped");

/** Cap the combined text content of an advisor tool result, truncating the last text block. */
function clampAdvisorResultText(result: AgentToolResult): AgentToolResult {
	let total = 0;
	let lastTextIdx = -1;
	for (let i = 0; i < result.content.length; i++) {
		const block = result.content[i];
		if (block.type === "text") {
			total += block.text.length;
			lastTextIdx = i;
		}
	}
	if (total <= ADVISOR_TOOL_OUTPUT_CAP || lastTextIdx < 0) return result;
	const overBy = total - ADVISOR_TOOL_OUTPUT_CAP;
	const content = result.content.slice();
	const last = content[lastTextIdx];
	if (last.type === "text") {
		const keep = Math.max(0, last.text.length - overBy);
		content[lastTextIdx] = {
			...last,
			text: `${last.text.slice(0, keep)}\n[truncated for advisor context — request a narrower range]`,
		};
	}
	return { ...result, content };
}

/**
 * Compose over an already-`wrapToolWithMetaNotice`d advisor read-only tool to cap
 * its combined text output at {@link ADVISOR_TOOL_OUTPUT_CAP}. Mutates in place
 * (like the meta wrapper) and guards with a marker Symbol so double-wrapping is a
 * no-op. Non-text blocks (images) and `details` are left untouched.
 */
function clampAdvisorToolOutput<T extends AgentTool>(tool: T): T {
	if (kAdvisorOutputClamped in tool) return tool;
	const inner = tool.execute;
	return Object.defineProperties(tool, {
		[kAdvisorOutputClamped]: { value: true, enumerable: false, configurable: true },
		execute: {
			value: async function (
				this: AgentTool,
				toolCallId: string,
				params: any,
				signal?: AbortSignal,
				onUpdate?: AgentToolUpdateCallback,
				context?: AgentToolContext,
			): Promise<AgentToolResult> {
				const result = await inner.call(this, toolCallId, params, signal, onUpdate, context);
				return clampAdvisorResultText(result);
			},
			enumerable: false,
			configurable: true,
			writable: true,
		},
	});
}
function createPendingMCPTool(name: string): Tool {
	const parsed = parseMCPToolName(name);
	const serverName = parsed?.serverName;
	const mcpToolName = parsed?.toolName ?? name;
	const label = serverName ? `${serverName}/${mcpToolName}` : name;
	const message = serverName
		? `MCP server "${serverName}" is still connecting; tool "${name}" is not yet available. Retry after the MCP connection completes.`
		: `MCP discovery is still in progress; tool "${name}" is not yet available. Retry after MCP connection completes.`;
	const tool: Tool & { mcpServerName?: string; mcpToolName?: string } = {
		name,
		label,
		description: `Pending MCP tool. ${message}`,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: true,
		},
		approval: "write",
		intent: "omit",
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return {
				content: [{ type: "text", text: message }],
				details: { serverName, mcpToolName, isError: true },
				isError: true,
			};
		},
	};
	return tool;
}

function collectPendingMCPToolNames(explicitToolNames: readonly string[] | undefined): string[] {
	const names = new Set<string>();
	for (const name of explicitToolNames ?? []) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	return [...names];
}

function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}

function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
	if (result.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
		Bun.env.EXA_API_KEY = result.exaApiKeys[0];
	}
}

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Additional workspace directories beyond cwd (multi-root), absolute or cwd-relative. */
	additionalDirectories?: string[];
	/** Global config directory. Default: ~/.omp/agent */
	agentDir?: string;
	/** Context GC SQLite path. Default: `<agentDir>/context-gc.sqlite`. */
	contextGcDbPath?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern(s) (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string | string[];
	/** Authenticated fallback selector for deferred subagent model patterns. */
	modelPatternAuthFallback?: string;
	/** Role name used to install retry fallbacks after deferred subagent patterns resolve. */
	modelPatternFallbackRole?: string;
	/** Validated default retry chain to install when a deferred singleton pattern resolves. */
	modelPatternDefaultFallbackChain?: string[];
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Prewalk from the starting model to a fast/cheap target at the first edit/write once the todo list exists. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve on the model's first resolve call, then switch to execute. */
	planYolo?: PlanYolo;
	/** One-way model switch after a fixed number of completed assistant turns. */
	reasoningSlide?: ReasoningSlide;

	/** System prompt blocks. Array replaces default, function receives default blocks and returns final blocks. */
	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[] | Promise<string | string[]>);
	/** Already-loaded custom prompt text rendered through the bundled custom system prompt template. */
	customSystemPrompt?: string;
	/** Already-loaded text appended through the bundled system prompt templates. */
	appendSystemPrompt?: string;
	/**
	 * Already-loaded title-generation system prompt override (typically
	 * {@link discoverTitleSystemPromptFile} → {@link resolvePromptInput}). When
	 * set, every automatic session-title generation path on this session — the
	 * first-input title and the replan-driven refresh — uses this prompt
	 * instead of the bundled default. Refresh on cwd change via
	 * {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;
	/** Optional provider-facing prompt cache key, distinct from request lineage. */
	providerPromptCacheKey?: string;
	/** Whether `providerPromptCacheKey` is caller-pinned or inherited from a full fork. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery and the per-session factory
	 * call). Used by the CLI when extensions are loaded early to parse custom
	 * flags — the same process owns the returned instances, so reusing them is
	 * safe.
	 *
	 * NEVER pass this across session boundaries (e.g. parent → subagent).
	 * `Extension` instances close over a parent-bound `ExtensionAPI` (cwd,
	 * eventBus, runtime), and reusing them would route tools/handlers/commands
	 * back through the parent. For subagents, forward
	 * {@link preloadedExtensionPaths} instead.
	 *
	 * @internal
	 */
	preloadedExtensions?: LoadExtensionsResult;
	/**
	 * Pre-discovered extension source paths. When provided, the filesystem-scan
	 * inside `discoverExtensionPaths()` is skipped — the session still calls
	 * `loadExtensions()` itself so each `Extension` is bound to THIS session's
	 * `ExtensionAPI` (cwd, eventBus, runtime).
	 *
	 * This is the safe pass-through for parent → subagent forwarding.
	 */
	preloadedExtensionPaths?: string[];
	/**
	 * Pre-discovered custom-tool source paths from `.omp/tools/`, `.claude/tools/`,
	 * plugins, etc. When provided, the filesystem-scan inside
	 * `discoverCustomToolPaths()` is skipped — subagents inherit the parent's
	 * scan result and call `loadCustomTools()` themselves so each session binds
	 * tools to its OWN `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
	 *
	 * Forwarding the loaded `LoadedCustomTool[]` instances directly would reuse
	 * the parent's session-bound API and route tool execution back through the
	 * parent — wrong for isolated tasks and for pending-action routing.
	 */
	preloadedCustomToolPaths?: ToolPathWithSource[];

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-built workspace tree (skips re-scanning; passed by parents to subagents). */
	workspaceTree?: WorkspaceTree;
	/** Tagged workspace roots (--be/--fe/--add-dir). Surfaced in the prompt and forwarded to subagents. */
	workspaceRoots?: WorkspaceRoot[];
	/** Prompt templates. Default: discovered from cwd/.omp/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/**
	 * Enable MCP capabilities. `false` skips MCP discovery and ignores
	 * `mcpManager`, preventing process-global or inherited MCP access. Default:
	 * true.
	 */
	enableMCP?: boolean;
	/** Existing MCP manager to reuse when MCP is enabled (skips discovery, propagates to toolSession). */
	mcpManager?: MCPManager;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Whether this invocation may expose IRC. `false` removes it even for subagents. */
	enableIrc?: boolean;
	/** Skip subprocess-kernel availability checks and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];
	/** When true, explicit toolNames also gate custom and extension tools. */
	respectToolNamesForCustomTools?: boolean;
	/** When true, skip non-essential extension/custom-tool discovery for restricted subagent sessions. */
	minimalExtensionRuntime?: boolean;
	/** Limit the session to explicitly supplied tool names, without discovered extras. */
	restrictToolNames?: boolean;

	/** Output schema for structured completion (subagents). */
	outputSchema?: unknown;
	/** Enforcement policy for {@link outputSchema}; defaults to legacy permissive behavior. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Parent Hindsight state to alias for subagent memory tools. */
	parentHindsightSessionState?: HindsightSessionState;
	/** Parent Mnemopi state to alias for subagent memory tools. */
	parentMnemopiSessionState?: MnemopiSessionState;
	/** Pre-allocated agent identity for IRC routing. Default: "Main" for top-level, parentTaskPrefix-derived for sub. */
	agentId?: string;
	/** Display name for the agent in IRC. Default: "main" or "sub". */
	agentDisplayName?: string;
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
	/**
	 * Registry generation authorized for this creation. `null` requires the id
	 * to be absent; an AgentRef allows a parked revival to reuse only that ref.
	 * Undefined preserves legacy unconditional registration for external SDK callers.
	 * @internal
	 */
	expectedAgentRef?: AgentRef | null;
	/** Parent task ID prefix for nested artifact naming (e.g., "Extensions") */
	parentTaskPrefix?: string;
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent in
	 * the agent registry. Distinct from `parentTaskPrefix`, which is this agent's
	 * own artifact/output-id prefix (the executor passes the child's own id
	 * there, so it must never double as the parent link). Undefined for the
	 * top-level "Main" session, which has no parent.
	 */
	parentAgentId?: string;
	/** Inherited eval executor session id for subagents sharing parent eval state. */
	parentEvalSessionId?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;
	/**
	 * Legacy alias for `settings`. Older Pi extensions pass SettingsManager.create(...)
	 * through this field; accept it so their SDK calls keep the configured settings.
	 */
	settingsManager?: Settings | Promise<Settings>;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
	/**
	 * Defer `confirm` reserve-policy fallback until AgentSession prompt-time UI is configured.
	 * ACP uses this while capabilities are negotiated without enabling UI-only tools.
	 */
	deferUsageReserveConfirmation?: boolean;

	/**
	 * Opt-in OpenTelemetry instrumentation forwarded to the underlying Agent.
	 * Passing `{}` enables the loop's GenAI-semantic-convention spans. See
	 * {@link AgentTelemetryConfig} for the full surface (hooks, content capture,
	 * cost estimator, agent identity).
	 *
	 * Safe to enable without an OTEL SDK registered in the host: the
	 * `@opentelemetry/api` package returns a no-op tracer in that case.
	 */
	telemetry?: AgentTelemetryConfig;

	/**
	 * Fired once, when the agent loop hands its first request to the provider
	 * transport (i.e. the `streamFn` wrapper is first invoked). Used to measure
	 * subagent launch latency — the boundary between "session built" and "model
	 * call dispatched". This is the loop's dispatch point, slightly before the
	 * actual provider HTTP call (per-request prep, identical across all
	 * requests, follows it), which is the right granularity for launch timing.
	 */
	onFirstChatDispatch?: () => void;

	/** Whether to auto-approve all tool calls (--auto-approve CLI flag). Default: false */
	autoApprove?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers detected for startup; warmup may continue in the background */
	lspServers?: LspStartupServerInfo[];
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
}

export type DialectFormat = "auto" | "native" | Dialect;

export function resolveDialect(
	format: DialectFormat,
	model: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined,
): Dialect | undefined {
	if (format === "native") return undefined;
	if (format === "auto") {
		if (model?.supportsTools !== false) return undefined;
		if (!model.id) return "glm";
		const preferred = preferredDialect(model.id);
		return preferred === FALLBACK_DIALECT ? "glm" : preferred;
	}
	return format;
}

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
export type { Tool } from "./tools";
export { buildDirectoryTree, buildWorkspaceTree, type DirectoryTree, type WorkspaceTree } from "./workspace-tree";

export {
	// Individual tool classes (for custom usage)
	BashTool,
	// Tool classes and factories
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	EvalTool,
	GlobTool,
	GrepTool,
	HIDDEN_TOOLS,
	loadSshTool,
	MacOSSandboxTool,
	ReadTool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

let contextGcExtensionLoadTail: Promise<void> = Promise.resolve();

async function withContextGcDbPath<T>(dbPath: string, load: () => Promise<T>): Promise<T> {
	const previous = contextGcExtensionLoadTail;
	const { promise, resolve } = Promise.withResolvers<void>();
	contextGcExtensionLoadTail = previous.then(() => promise);
	await previous;
	const restoreContextGcDbPath = setDefaultContextGcDbPath(dbPath);
	try {
		return await load();
	} finally {
		restoreContextGcDbPath();
		resolve();
	}
}

// Discovery Functions

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `OMP_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 *
 * Delegates to {@link ./session/auth-broker-config} so the TUI and the catalog
 * generator share the same credential-discovery logic.
 */
export async function discoverAuthStorage(
	agentDir: string = getAgentDir(),
	options?: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver">,
): Promise<AuthStorage> {
	return discoverAuthStorageFromConfig(agentDir, options);
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on {@link ToolSession.extensionPaths}) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 */
export async function discoverSessionExtensionPaths(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
): Promise<string[]> {
	if (options.disableExtensionDiscovery) {
		return options.additionalExtensionPaths ?? [];
	}
	const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discovered = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds);
	// The native Herdr agent-state reporter supersedes herdr-installed managed
	// reporters once it registers and marks OMP_NATIVE_HERDR_AGENT_STATE=1.
	// Only V3 managed fallback files have a per-send marker gate and can safely
	// stay loaded as live fallback until native marks itself live.
	if (isNativeHerdrAgentStateEnabled()) {
		const filtered: string[] = [];
		let dropped = 0;
		for (const extensionPath of discovered) {
			if (!isManagedHerdrAgentStateExtensionPath(extensionPath)) {
				filtered.push(extensionPath);
				continue;
			}
			try {
				const content = await Bun.file(extensionPath).text();
				if (content.includes(HERDR_MANAGED_FALLBACK_SENTINEL)) {
					filtered.push(extensionPath);
					continue;
				}
			} catch {
				// Treat unreadable managed files as stale so native remains authoritative.
			}
			dropped += 1;
		}
		if (dropped > 0) {
			logger.debug("herdr-agent-state: dropped managed reporter from discovery", { dropped });
		}
		return filtered;
	}
	return discovered;
}

/**
 * Load the discovered/configured extensions for a session — everything {@link
 * createAgentSession} would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * {@link CreateAgentSessionOptions.preloadedExtensions} so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 */
export async function loadSessionExtensions(
	options: Pick<
		CreateAgentSessionOptions,
		"agentDir" | "contextGcDbPath" | "disableExtensionDiscovery" | "additionalExtensionPaths"
	>,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
): Promise<LoadExtensionsResult> {
	const contextGcDbPath =
		options.contextGcDbPath ?? path.join(options.agentDir ?? getDefaultAgentDir(), "context-gc.sqlite");
	return await withContextGcDbPath(contextGcDbPath, async () => {
		const paths = await discoverSessionExtensionPaths(options, cwd, settings);
		const result = await logger.time("loadExtensions", loadExtensions, paths, cwd, eventBus);
		for (const { path, error } of result.errors) {
			logger.error("Failed to load extension", { path, error });
		}
		return result;
	});
}

/**
 * Load discovered/configured extensions and register their providers into
 * `modelRegistry`, then discover the dynamic provider catalogs. One-shot CLIs
 * (`omp bench`, dry-balance) build a bare {@link ModelRegistry} that only knows
 * built-in catalog providers; without this, providers contributed by an
 * extension (e.g. a custom OpenAI-compatible provider under
 * `~/.omp/agent/extensions/`) never reach model resolution. Mirrors the
 * session / `omp models` path: drain the queued provider registrations, then
 * `refreshRuntimeProviders` so dynamically-discovered models exist before
 * selectors are resolved.
 */
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths"> = {},
): Promise<void> {
	const eventBus = new EventBus();
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	await modelRegistry.refreshRuntimeProviders();
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
	workspaceRoots?: WorkspaceRoot[],
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		workspaceRoots,
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	customPrompt?: string;
	appendPrompt?: string;
	nativeDiscoveryToolSummaries?: string[];
	inlineToolDescriptors?: boolean;
	includeWorkspaceTree?: boolean;
}

/**
 * Build the default provider-facing system prompt blocks.
 *
 * The returned `systemPrompt` preserves the stable harness prompt and dynamic project context
 * as separate entries so providers can cache prompt prefixes without concatenating blocks.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	const toolMap = options.tools ? new Map(options.tools.map(tool => [tool.name, tool])) : undefined;
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		customPrompt: options.customPrompt,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		nativeDiscoveryToolSummaries: options.nativeDiscoveryToolSummaries,
		inlineToolDescriptors: options.inlineToolDescriptors,
		includeWorkspaceTree: options.includeWorkspaceTree,
		toolNames: options.tools?.map(tool => tool.name),
		tools: toolMap ? buildSystemPromptToolMetadata(toolMap) : undefined,
	});
}

// Internal Helpers

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
		localProtocolOptions: ctx.localProtocolOptions,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__ompLegacyBuiltinTool" in tool && tool.__ompLegacyBuiltinTool === true;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

/** Matches the truncation applied to per-server instructions inside `rebuildSystemPrompt`. */
const MAX_MCP_INSTRUCTIONS_LENGTH = 4000;

function formatNativeDiscoveryToolSummary(tool: DiscoverableTool): string {
	const label = tool.label && tool.label !== tool.name ? `${tool.label} (\`${tool.name}\`)` : `\`${tool.name}\``;
	const summary = tool.summary.trim().replace(/\s+/g, " ");
	return summary ? `${label}: ${summary}` : label;
}

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

async function ensureAgentDirLayout(agentDir: string): Promise<void> {
	await fs.mkdir(path.join(agentDir, "workflows"), { recursive: true });
}

let evalCleanupRegistered = false;

function registerEvalCleanup(): void {
	if (evalCleanupRegistered) return;
	evalCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
	postmortem.register("ruby-cleanup", disposeAllRubyKernelSessions);
	postmortem.register("julia-cleanup", disposeAllJuliaKernelSessions);
}

export function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		loadMode: defaultLoadModeForToolName(tool.name, tool.loadMode),
		deferrable: tool.deferrable,
		approval: typeof tool.approval === "function" ? tool.approval.bind(tool) : tool.approval,
		// Preserved through RegisteredToolAdapter so MCP-backed tools' explicit
		// `strict: false` (#4336/#4340) survives the custom-tool → definition bridge.
		strict: tool.strict,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	return api => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					errorId: event.errorId,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
					recoveredErrors: event.recoveredErrors,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}

/** Dependencies used to construct an isolated auto-learn capture agent. */
export interface AutoLearnCaptureRunnerOptions {
	sourceAgent: Agent;
	captureTools: AgentTool[];
	createAgent: (options: AgentOptions) => Agent;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	createSessionId?: () => string;
}

/** Build a private capture runner over a detached message snapshot and provider session. */
export function createAutoLearnCaptureRunner(
	options: AutoLearnCaptureRunnerOptions,
): (content: string, signal?: AbortSignal) => Promise<void> {
	return async (content, signal) => {
		if (options.captureTools.length === 0 || signal?.aborted) return;
		const captureModel = options.sourceAgent.state.model;
		if (!captureModel) return;

		const captureSessionId = options.createSessionId?.() ?? Bun.randomUUIDv7();
		const captureProviderSessionState = new Map<string, ProviderSessionState>();
		const captureMessages = options.sourceAgent.state.messages.map((message): AgentMessage => {
			if (message.role === "assistant") {
				return { ...message, responseId: undefined, providerPayload: undefined };
			}
			if (message.role === "user" || message.role === "developer") {
				return { ...message, providerPayload: undefined };
			}
			return message;
		});
		const captureAgent = options.createAgent({
			initialState: {
				systemPrompt: [...options.sourceAgent.state.systemPrompt],
				model: captureModel,
				thinkingLevel: options.sourceAgent.state.thinkingLevel,
				disableReasoning: options.sourceAgent.state.disableReasoning,
				tools: options.captureTools,
				messages: captureMessages,
			},
			sessionId: captureSessionId,
			promptCacheKey: captureSessionId,
			providerSessionState: captureProviderSessionState,
			getApiKey: requestModel => options.sourceAgent.getApiKey?.(requestModel),
			onPayload: options.onPayload,
			onResponse: options.onResponse,
		});
		captureAgent.setMetadataResolver(provider => options.sourceAgent.metadataForProvider(provider));
		const captureMessage: CustomMessage = {
			role: "custom",
			customType: "autolearn-nudge",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		const abortCapture = () => captureAgent.abort(signal?.reason);
		signal?.addEventListener("abort", abortCapture, { once: true });
		try {
			if (signal?.aborted) {
				abortCapture();
				return;
			}
			await captureAgent.prompt(captureMessage);
		} catch (error) {
			if (!signal?.aborted) throw error;
		} finally {
			signal?.removeEventListener("abort", abortCapture);
			for (const [providerKey, state] of captureProviderSessionState) {
				try {
					state.close();
				} catch (error) {
					logger.warn("Failed to close auto-learn capture provider state", {
						providerKey,
						error: String(error),
					});
				}
			}
			captureProviderSessionState.clear();
		}
	};
}
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@oh-my-pi/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: ['You are helpful.'],
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	await ensureAgentDirLayout(agentDir);
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerEvalCleanup();

	// Pin authStorage to modelRegistry.authStorage: ModelRegistry.getApiKey() routes refresh
	// failures through that instance, so any divergent storage handed to the bridge / mcpManager
	// / session would silently miss credential_disabled events.
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)));
	// Track whether we internally created the authStorage so we can close it
	// if construction fails before the session takes ownership.
	const ownsAuthStorage = !options.authStorage && !options.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}
	// Subscribe before any getApiKey() call so startup model probes can't fire a
	// credential_disabled event past us. An embedder's constructor handler makes the
	// listener set non-empty from construction, which defeats AuthStorage's no-listener
	// buffer — so we can't rely on it to catch startup events for the extension runner.
	const startupCredentialDisabledEvents: CredentialDisabledEvent[] = [];
	let credentialDisabledTarget: ExtensionRunner | undefined;
	const unsubscribeCredentialDisabled: (() => void) | undefined = authStorage.onCredentialDisabled(event => {
		if (credentialDisabledTarget) {
			// Discard return: any handler error is routed through runner.onError listeners.
			void credentialDisabledTarget.emitCredentialDisabled(event);
		} else {
			startupCredentialDisabledEvents.push(event);
		}
	});

	let session!: AgentSession;
	let hasSession = false;
	let hasRegistered = false;
	let asyncJobManager: AsyncJobManager | undefined;
	let evalKernelOwnerId = "";
	let registeredAgentRef: AgentRef | undefined;
	let unregisterUnlessParked = (): void => {};

	try {
		const settings = await (options.settings ??
			options.settingsManager ??
			logger.time("settings", Settings.init, { cwd, agentDir }));
		logger.time("initializeWithSettings", initializeWithSettings, settings);
		if (!options.modelRegistry) {
			modelRegistry.refreshInBackground();
		}
		const sessionManager =
			options.sessionManager ??
			logger.time("sessionManager", () =>
				SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
			);
		if (options.additionalDirectories) {
			await sessionManager.setAdditionalDirectories([
				...sessionManager.getAdditionalDirectories(),
				...options.additionalDirectories,
			]);
		}
		const workspaceRoots =
			options.workspaceRoots && options.workspaceRoots.length > 0
				? options.workspaceRoots
				: await logger.time(
						"hydrateWorkspaceRoots",
						hydrateWorkspaceRoots,
						sessionManager.getWorkspaceRoots(),
						sessionManager.getCwd(),
					);
		const restrictToolNames = options.restrictToolNames === true;
		if (workspaceRoots.length > 0) {
			sessionManager.setWorkspaceRoots(workspaceRoots);
		}

		const minimalExtensionRuntime = options.minimalExtensionRuntime === true;
		// Kick off workspace tree discovery early. The native workspace scan returns
		// both the rendered-tree input and the AGENTS.md directory-context index, so
		// startup does not perform a second recursive filesystem search. Subagents
		// inherit the parent's resolved values via options.
		const STARTUP_SCAN_DEADLINE_MS = 5000;
		const shouldBuildStartupWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
		const workspaceTreePromise: Promise<WorkspaceTree> = options.workspaceTree
			? Promise.resolve(options.workspaceTree)
			: shouldBuildStartupWorkspaceTree
				? logger.time("buildWorkspaceTree", () => buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }))
				: Promise.resolve({ rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] });
		workspaceTreePromise.catch(() => {});

		// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
		// at their respective consumer sites. Their work can overlap with model resolution, secret loading,
		// session-context build, tool creation, MCP discovery, and extension discovery.
		const contextFilesPromise = options.contextFiles
			? Promise.resolve(options.contextFiles)
			: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir, workspaceRoots);
		contextFilesPromise.catch(() => {});
		const activeRepoContextPromise = logger.time("resolveActiveRepoContext", async () => {
			try {
				return await resolveActiveRepoContext(cwd);
			} catch (err) {
				logger.debug("Failed to resolve active repo context", { err: String(err) });
				return null;
			}
		});
		activeRepoContextPromise.catch(() => {});
		const watchdogFilesPromise = logger.time("discoverWatchdogFiles", () => discoverWatchdogFiles(cwd, agentDir));
		watchdogFilesPromise.catch(() => {});
		const discoveredAdvisorsPromise = logger.time("discoverAdvisorConfigs", () =>
			discoverAdvisorConfigs(cwd, agentDir),
		);
		discoveredAdvisorsPromise.catch(() => {});
		const promptTemplatesPromise = options.promptTemplates
			? Promise.resolve(options.promptTemplates)
			: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
		promptTemplatesPromise.catch(() => {});
		const slashCommandsPromise = options.slashCommands
			? Promise.resolve(options.slashCommands)
			: minimalExtensionRuntime
				? Promise.resolve([])
				: logger.time("discoverSlashCommands", discoverSlashCommands, cwd);
		slashCommandsPromise.catch(() => {});
		const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
		const skillsSettings = {
			...settings.getGroup("skills"),
			disabledExtensions: disabledExtensionIds,
		};
		const discoveredSkillsPromise =
			options.skills === undefined
				? logger.time("discoverSkills", discoverSkills, cwd, agentDir, skillsSettings)
				: undefined;
		discoveredSkillsPromise?.catch(() => {});

		// Apply validated ordered provider preferences to the tool runtimes.
		applyProviderGlobalsFromSettings(settings);

		const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
		const forkCacheShapeChanged =
			options.model !== undefined ||
			options.modelPattern !== undefined ||
			options.thinkingLevel !== undefined ||
			options.systemPrompt !== undefined ||
			options.customSystemPrompt !== undefined ||
			options.appendSystemPrompt !== undefined ||
			options.toolNames !== undefined ||
			options.customTools !== undefined;
		const inheritedPromptCacheKey = forkCacheShapeChanged
			? undefined
			: sessionManager.getHeader()?.providerPromptCacheKey;
		const providerPromptCacheKey = options.providerPromptCacheKey ?? inheritedPromptCacheKey;
		const providerPromptCacheKeySource =
			options.providerPromptCacheKey !== undefined
				? (options.providerPromptCacheKeySource ?? "explicit")
				: providerPromptCacheKey !== undefined
					? "fork"
					: undefined;
		// Startup model *selection* only needs to know whether auth is configured for
		// a candidate's provider — never the resolved key bytes. Use the synchronous,
		// side-effect-free probe (`hasConfiguredAuth`): it refreshes no OAuth tokens,
		// executes no `!command` keys, and issues no auth-broker requests. Resolving the
		// real key here (`getApiKey`) blocks resume on those network paths — a slow or
		// unreachable OAuth/broker endpoint stalls startup for the full ~10s refresh
		// timeout per candidate (observed as a hang in `restoreSessionModel`). The real
		// key is resolved lazily per request via ModelRegistry.resolver.
		const hasModelAuth = (candidate: Model): boolean => modelRegistry.hasConfiguredAuth(candidate);

		// Load and create secret obfuscator early so resumed session state and prompt warnings
		// reflect actual loaded secrets, not just the setting toggle.
		let obfuscator: SecretObfuscator | undefined;
		if (settings.get("secrets.enabled")) {
			const fileEntries = await logger.time("loadSecrets", loadSecrets, cwd, agentDir);
			const envEntries = collectEnvSecrets();
			const allEntries = [...envEntries, ...fileEntries];
			// The keyed placeholder digest must survive a process restart so persisted
			// obfuscate-mode placeholders deobfuscate on resume. Only create/persist the
			// per-install key when an active entry can actually mint a reversible
			// placeholder (secretEntriesNeedPlaceholderKey); a replace-only / short /
			// no-secret config must NOT write secret-placeholder.key (a readable file a
			// prompt-injected tool could surface). When no key is needed we still LOAD an
			// existing key without creating one and redact it as a one-way secret, so a
			// tool read of the stale key file cannot leak it to the provider.
			const redactableEntries: SecretEntry[] = [...allEntries];
			let placeholderKey: string | undefined;
			if (secretEntriesNeedPlaceholderKey(allEntries)) {
				placeholderKey = await getSecretPlaceholderKey(agentDir);
			} else {
				const existingKey = await getExistingSecretPlaceholderKey(agentDir);
				if (existingKey !== undefined) {
					placeholderKey = existingKey;
					redactableEntries.push({ type: "plain", content: existingKey, mode: "replace" });
				}
			}
			if (redactableEntries.length > 0) {
				obfuscator =
					placeholderKey !== undefined
						? new SecretObfuscator(redactableEntries, placeholderKey)
						: new SecretObfuscator(redactableEntries);
			}
		}
		const secretsEnabled = obfuscator?.hasSecrets() === true;

		// Check if session has existing data to restore
		let existingSession = logger.time("loadSessionContext", () =>
			deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
		);
		let existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
		const hasExistingSession = existingBranch.length > 0;
		const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
		const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

		const deferredModelPatterns = Array.isArray(options.modelPattern)
			? options.modelPattern.map(pattern => pattern.trim()).filter(Boolean)
			: options.modelPattern?.trim()
				? [options.modelPattern.trim()]
				: [];
		const hasExplicitModel = options.model !== undefined || deferredModelPatterns.length > 0;
		const modelMatchPreferences = getModelMatchPreferences(settings);
		const allowedModels = await logger.time("resolveAllowedModels", () =>
			resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
		);
		let defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
			resolveModelRoleValue(settings.getModelRole("default"), allowedModels, {
				settings,
				matchPreferences: modelMatchPreferences,
				modelRegistry,
			}),
		);
		let model = options.model;
		let modelFallbackMessage: string | undefined;
		let initialRetryFallback: InitialRetryFallbackState | undefined;
		// Identify session model strings to restore in fallback order. We do an
		// initial pass here so model-dependent setup (thinking-level resolution,
		// host preconnect) can use the restored model; extension-registered
		// providers aren't visible yet, so we retry the preferred candidates once
		// extensions register below.
		const sessionModelStrings =
			!hasExplicitModel && hasExistingSession
				? getRestorableSessionModels(existingSession.models, sessionManager.getLastModelChangeRole())
				: [];
		let restoredSessionModelIndex = -1;
		let restoredSessionThinkingLevel: ConfiguredThinkingLevel | undefined;
		if (!hasExplicitModel && !model && sessionModelStrings.length > 0) {
			logger.time("restoreSessionModel", () => {
				let failedSessionModel: string | undefined;
				for (let i = 0; i < sessionModelStrings.length; i++) {
					const sessionModelStr = sessionModelStrings[i];
					const parsedModel = parseModelString(sessionModelStr, {
						allowMaxSuffix: true,
						allowAutoAlias: true,
						isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
					});
					if (!parsedModel) {
						failedSessionModel ??= sessionModelStr;
						continue;
					}

					const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
					if (restoredModel && hasModelAuth(restoredModel)) {
						model = restoredModel;
						restoredSessionModelIndex = i;
						restoredSessionThinkingLevel = parsedModel.thinkingLevel;
						break;
					}
					failedSessionModel ??= sessionModelStr;
				}
				if (failedSessionModel) {
					modelFallbackMessage = `Could not restore model ${failedSessionModel}`;
				}
			});
		}

		// If still no model, try settings default.
		// Skip settings fallback when an explicit model was requested.
		if (!hasExplicitModel && !model && defaultRoleSpec.model) {
			const settingsDefaultModel = defaultRoleSpec.model;
			logger.time("resolveSettingsDefaultModel", () => {
				// defaultRoleSpec.model already comes from modelRegistry.getAvailable(),
				// so re-validating auth here just repeats the expensive lookup path.
				model = settingsDefaultModel;
			});
		}

		const taskDepth = options.taskDepth ?? 0;

		// Resolves the session/agent thinking level using the same precedence we
		// apply at startup: explicit option → persisted session entry → restored
		// model selector suffix → default role's explicit selector → selected
		// model's defaultLevel → global settings default. Run again after extension
		// role reclaim so the final model's own defaults aren't masked by an earlier
		// fallback model's.
		const pickInitialThinkingLevel = (selectedModel: Model | undefined): ConfiguredThinkingLevel | undefined => {
			let level = options.thinkingLevel;
			if (level === undefined && hasExistingSession && hasThinkingEntry) {
				level =
					parseConfiguredThinkingLevel(existingSession.configuredThinkingLevel) ??
					parseThinkingLevel(existingSession.thinkingLevel);
			}
			if (level === undefined && !hasThinkingEntry && restoredSessionThinkingLevel !== undefined) {
				level = restoredSessionThinkingLevel;
			}
			if (level === undefined && !hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
				level = defaultRoleSpec.thinkingLevel;
			}
			if (level === undefined && selectedModel?.thinking?.defaultLevel !== undefined) {
				level = selectedModel.thinking.defaultLevel;
			}
			if (level === undefined) {
				level = parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel"));
			}
			return level;
		};
		let thinkingLevel = pickInitialThinkingLevel(model);
		let autoThinking = thinkingLevel === AUTO_THINKING;
		// Concrete level the agent/session start with. With `auto` this is the
		// provisional level shown until the first per-turn classification resolves;
		// `auto` itself stays a session-only concept handled by AgentSession.
		let effectiveThinkingLevel: ThinkingLevel | undefined = concreteThinkingLevel(thinkingLevel);
		if (model) {
			const resolvedModel = model;
			effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
				autoThinking
					? resolveProvisionalAutoLevel(resolvedModel)
					: resolveThinkingLevelForModel(resolvedModel, effectiveThinkingLevel),
			);
			// Fire-and-forget TLS+H2 handshake to the model's host so it overlaps
			// with the rest of session setup (extension/skill load, tool registry,
			// system prompt build). Without this, the first `fetch(...)` pays the
			// full handshake serially — 100–300 ms transcontinental for
			// api.anthropic.com from a residential IP. Every mode benefits
			// (interactive, print, rpc, acp).
			preconnectModelHost(model.baseUrl);
		}

		let skills: Skill[];
		let skillWarnings: SkillWarning[];
		if (options.skills !== undefined) {
			skills = options.skills;
			skillWarnings = [];
		} else {
			const discovered = await (discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }));
			skills = discovered.skills;
			skillWarnings = discovered.warnings;
		}

		// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
		const { ttsrManager, rulebookRules, alwaysApplyRules, allRules } = await logger.time(
			"discoverTtsrRules",
			async () => {
				const { TtsrManager } = await import("./export/ttsr");
				const ttsrSettings = settings.getGroup("ttsr");
				const ttsrManager = new TtsrManager(ttsrSettings);
				const rulesResult =
					options.rules !== undefined
						? { items: options.rules, warnings: undefined }
						: await loadCapability<Rule>(ruleCapability.id, { cwd });
				const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
					builtinRules: ttsrSettings.builtinRules,
					disabledRules: ttsrSettings.disabledRules,
				});
				if (existingSession.injectedTtsrRules.length > 0) {
					ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
				}
				return { ttsrManager, rulebookRules, alwaysApplyRules, allRules: rulesResult.items };
			},
		);

		// Resolve contextFiles up-front (it's needed before tool creation). The
		// workspace tree scan is slow on large repos and we MUST NOT block startup on
		// it. On timeout we forward `undefined` to ToolSession; buildSystemPromptInternal
		// will re-race the same promise through its own withDeadline path. Background
		// work continues so caches still warm.
		const raceWithDeadline = async <T>(name: string, work: Promise<T>): Promise<T | undefined> => {
			let timedOut = false;
			const result = await Promise.race([
				work,
				Bun.sleep(STARTUP_SCAN_DEADLINE_MS).then(() => {
					timedOut = true;
					return undefined;
				}),
			]);
			if (timedOut) {
				logger.warn("Startup scan exceeded deadline; deferring to system prompt fallback", {
					name,
					timeoutMs: STARTUP_SCAN_DEADLINE_MS,
					cwd,
				});
			}
			return result;
		};
		const [contextFiles, resolvedWorkspaceTree, watchdogFiles, discoveredAdvisors, activeRepoContext] =
			await Promise.all([
				contextFilesPromise,
				raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
				watchdogFilesPromise,
				discoveredAdvisorsPromise,
				activeRepoContextPromise,
			]);

		let agent: Agent;
		const enableLsp = options.enableLsp ?? true;
		const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
		const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
		const ASYNC_PREVIEW_MAX_CHARS = 4_000;
		const formatAsyncResultForFollowUp = async (result: string): Promise<string> => {
			if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
				return result;
			}

			const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
			try {
				const { path: artifactPath, id: artifactId } = await sessionManager.allocateArtifactPath("async");
				if (artifactPath && artifactId) {
					await Bun.write(artifactPath, result);
					return `${preview}\nFull output: artifact://${artifactId}`;
				}
			} catch (error) {
				logger.warn("Failed to persist async follow-up artifact", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			return preview;
		};
		// Only the first top-level session in a process owns an AsyncJobManager.
		// Subagents inherit the parent's manager via `AsyncJobManager.instance()`
		// (set below), and any additional top-level session spun up in-process
		// (e.g. the agent-creation architect in `agent-dashboard.ts`) must share
		// the live singleton — otherwise its dispose path would clobber the
		// owning session's manager and break the `task`/`bash` async paths
		// (issue #1923). The `instance()` guard means later sessions also skip
		// constructing an orphaned manager that nothing would ever route to.
		asyncJobManager =
			!options.parentTaskPrefix && !AsyncJobManager.instance()
				? new AsyncJobManager({
						maxRunningJobs: asyncMaxJobs,
						eventBus,
						onJobComplete: async (jobId, result, job) => {
							if (!session || asyncJobManager!.isDeliverySuppressed(jobId)) return;
							const formattedResult = await formatAsyncResultForFollowUp(result);
							if (asyncJobManager!.isDeliverySuppressed(jobId)) return;

							const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
							session.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
								jobId,
								result: formattedResult,
								job,
								durationMs,
							});
						},
					})
				: undefined;

		const scopedAsyncJobManager =
			asyncJobManager ?? (options.parentTaskPrefix ? AsyncJobManager.instance() : undefined);

		const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
		const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
		const resolvedAgentDisplayName =
			options.agentDisplayName ?? ((options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? "sub" : "main");
		const agentKind = (options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? ("sub" as const) : ("main" as const);
		/**
		 * Forget the agent ref on teardown — unless the agent is being parked (or is
		 * already parked). Parking disposes the session but keeps the ref addressable
		 * (history://, revive); only process teardown / explicit kill unregisters.
		 */
		unregisterUnlessParked = (): void => {
			const ref = registeredAgentRef;
			if (!ref || agentRegistry.get(resolvedAgentId) !== ref) return;
			if (ref.status === "parked") return;
			if (AgentLifecycleManager.global().isParking(resolvedAgentId, ref)) return;
			agentRegistry.unregister(resolvedAgentId, ref);
		};
		evalKernelOwnerId = `agent-session:${Snowflake.next()}`;

		const getActiveModelString = (): string | undefined => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		// Per-path mutation counter shared across edit/write tools. Late-diagnostics
		// entries capture it at fetch time and are dropped at injection if a newer
		// mutation (any tool) bumped it in the meantime.
		const fileMutationVersions = new Map<string, number>();
		const activeToolNames = new Set<string>();
		const promptActiveToolNames = new AsyncLocalStorage<ReadonlySet<string>>();
		const setActiveToolNames = (names: Iterable<string>): void => {
			activeToolNames.clear();
			for (const name of names) {
				activeToolNames.add(name);
			}
		};
		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			isToolActive: name => promptActiveToolNames.getStore()?.has(name) ?? activeToolNames.has(name),
			setActiveToolNames,
			hasUI: options.hasUI ?? false,
			get additionalDirectories() {
				return sessionManager.getAdditionalDirectories();
			},
			enableLsp,
			enableIrc: restrictToolNames ? false : options.enableIrc,
			restrictToolNames,
			get hasEditTool() {
				const requestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
				return restrictToolNames
					? requestedToolNames?.includes("edit") === true
					: !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			contextFiles,
			workspaceTree: resolvedWorkspaceTree,
			workspaceRoots,
			get skills() {
				return session?.skills ?? skills;
			},
			refreshSkills: () => session.refreshSkills(),
			rules: allRules,
			eventBus,
			outputSchema: options.outputSchema,
			outputSchemaMode: options.outputSchemaMode,
			requireYieldTool: options.requireYieldTool,
			prewalkArmed: options.prewalk !== undefined,
			taskDepth: options.taskDepth ?? 0,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			sessionManager,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			getEvalSessionId: () =>
				session?.getEvalSessionId() ?? options.parentEvalSessionId ?? defaultEvalSessionId(toolSession),
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			hasPendingAgentAsides: () => session?.hasPendingDeliverableAsides() ?? false,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			requestMacOSSandboxRelaunch: paths => {
				const sessionFile = sessionManager.getSessionFile();
				return sessionFile
					? requestMacOSSandboxRelaunch(paths, sessionManager.getSessionId(), path.dirname(sessionFile))
					: { requested: false, reason: "missing-session" };
			},
			getHindsightSessionState: () => session?.getHindsightSessionState(),
			getMnemopiSessionState: () => session?.getMnemopiSessionState(),
			getAgentId: () => resolvedAgentId,
			getToolByName: name => session?.getToolByName(name),
			agentRegistry,
			// The global lifecycle releases through AgentRegistry.global(); wiring it
			// onto a caller-supplied registry would report a cancel while releasing an
			// unrelated global ref. With no lifecycle, hub cancel falls back to
			// dispose + unregister on the session's own registry.
			agentLifecycle: options.agentRegistry ? undefined : () => AgentLifecycleManager.global(),
			getSessionSpawns: () => options.spawns ?? "*",
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getActiveModelContextWindow: () => agent?.state.model?.contextWindow ?? model?.contextWindow ?? undefined,
			getActiveModel: () => agent?.state.model ?? model,
			getServiceTierByFamily: () => session?.serviceTierByFamily,
			getImageAttachments: () => session?.getImageAttachments() ?? [],
			consultAdvisor: (question, signal) => session?.consultAdvisor(question, signal) ?? Promise.resolve(null),
			consultAdvisorAsync: question => session?.consultAdvisorAsync(question) ?? false,
			isAdvisorActive: () => session?.isAdvisorActive() ?? false,
			isAdvisorEnabled: () =>
				session?.isAdvisorEnabled() ?? resolveAdvisorEnabled(settings, agent?.state.model ?? model),
			duoHandoffToExecutor: (resolution, scope) =>
				session?.duoHandoffToExecutor(resolution, scope) ?? Promise.resolve("no-controller"),
			duoEscalateToPlanner: reason => session?.duoEscalateToPlanner(reason) ?? Promise.resolve("unavailable"),
			getPlanModeState: () => session?.getPlanModeState(),
			getOrchestratorModeState: () => session?.getOrchestratorModeState(),
			setOrchestratorModeState: state => session?.setOrchestratorModeState(state),
			getPlanReferencePath: () => session?.getPlanReferencePath() ?? "local://PLAN.md",
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
			getUsageStatistics: () => sessionManager.getUsageStatistics(),
			getTurnBudget: () => sessionManager.getTurnBudget(),
			recordEvalSubagentUsage: output => sessionManager.recordEvalSubagentOutput(output),
			getClientBridge: () => session?.clientBridge,
			queueDeferredDiagnostics: entry => session?.yieldQueue.enqueue(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, entry),
			queueBrowserAnnotation: entry =>
				session?.yieldQueue.enqueue(BROWSER_ANNOTATION_MESSAGE_TYPE, entry, {
					maxEntries: MAX_BACKGROUND_BROWSER_ANNOTATIONS,
				}),
			// Mirror browser-annotation: enqueue into yieldQueue so idle agents wake
			// and streaming turns pick it up as steering (not followUp).
			queuePreviewFeedback: feedback => session?.yieldQueue.enqueue(PREVIEW_FEEDBACK_MESSAGE_TYPE, feedback),
			requestCompaction: (reason, options) =>
				session?.requestCompactionFromAgent(reason, options) ?? {
					status: "unavailable",
					detail: "session is not ready yet",
				},
			considerCompactionWhileWaiting: (reason, options) =>
				session?.considerCompactionWhileWaiting(reason, options) ?? {
					status: "unavailable",
					detail: "session is not ready yet",
				},
			requestShake: mode =>
				session?.requestShakeFromAgent(mode) ?? {
					status: "unavailable",
					detail: "session is not ready yet",
				},
			bumpFileMutationVersion: path => {
				const next = (fileMutationVersions.get(path) ?? 0) + 1;
				fileMutationVersions.set(path, next);
				return next;
			},
			getFileMutationVersion: path => fileMutationVersions.get(path) ?? 0,
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			appendCustomEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
			enterSubagentWait: () => session.enterSubagentWait(),
			exitSubagentWait: () => session.exitSubagentWait(),
			isMCPDiscoveryEnabled: () => session.isMCPDiscoveryEnabled(),
			getSelectedMCPToolNames: () => session.getSelectedMCPToolNames(),
			activateDiscoveredMCPTools: toolNames => session.activateDiscoveredMCPTools(toolNames),
			// Generic tool discovery (unified — covers built-in + MCP + extension)
			isToolDiscoveryEnabled: () => session.isToolDiscoveryEnabled(),
			getDiscoverableTools: filter => session.getDiscoverableTools(filter),
			getDiscoverableToolSearchIndex: () => session.getDiscoverableToolSearchIndex(),
			getSelectedDiscoveredToolNames: () => session.getSelectedDiscoveredToolNames(),
			activateDiscoveredTools: toolNames => session.activateDiscoveredTools(toolNames),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			peekPendingInvoker: () => session.peekPendingInvoker(),
			clearPendingInvokers: () => session.clearPendingInvokers(),
			peekPlanProposalHandler: () => session.peekPlanProposalHandler(),
			setPlanProposalHandler: handler => session.setPlanProposalHandler(handler),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch {
					return {};
				}
			},
			getArtifactManager: () => sessionManager.getArtifactManager(),
			settings,
			authStorage,
			modelRegistry,
			getTelemetry: () => agent?.telemetry,
			// Subagents inherit the singleton (the parent's manager) so their bash/task
			// completions still flow into the spawning conversation's yieldQueue.
			// Secondary in-process top-level sessions (no parentTaskPrefix, no
			// constructed manager because the singleton was already installed) leave
			// this undefined so tools and session job snapshots refuse async work
			// instead of silently routing into the owning session (issue #1923).
			asyncJobManager: scopedAsyncJobManager,
			// Top-level / full AgentSession hosts loops. Secondary parentTaskPrefix
			// sessions (e.g. /tan) omit this so loop is neither advertised nor
			// executable (mirrors asyncJobManager issue #1923).
			getLoopManager: options.parentTaskPrefix ? undefined : () => session?.getLoopManager(),
		};
		const reloadSshTool = async (): Promise<AgentTool | null> => {
			const sshTool = await loadSshTool(toolSession);
			return sshTool === null ? null : (sshTool as unknown as AgentTool);
		};

		// Wire process-wide internal URL singletons owned by their real classes.
		// Top-level sessions install the active snapshots; subagents inherit them.
		// Artifact and agent-output URLs resolve via `AgentRegistry.global()` —
		// the protocol handlers walk each ref's `sessionManager.getArtifactsDir()`,
		// which collapses to the parent's dir for subagents (they adopt the
		// parent's ArtifactManager) so one lookup hits everything.
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		if (!options.parentTaskPrefix) {
			setActiveSkills(skills);
			// Include TTSR rules so `rule://<name>` can resolve them too. They are
			// registered with the manager and bucketed out before rulebook/always,
			// so without this a TTSR-only rule (e.g. a triggered builtin) is not
			// addressable and `rule://` reports "Available: none".
			setActiveRules([...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()]);
			if (asyncJobManager) AsyncJobManager.setInstance(asyncJobManager);
		}
		const localProtocolOptions = options.localProtocolOptions ?? {
			getArtifactsDir,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
		};
		if (options.localProtocolOptions) {
			LocalProtocolHandler.setOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.localProtocolOptions = localProtocolOptions;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// Create built-in tools (already wrapped with meta notice formatting)
		const builtinTools = await logger.time("createAllTools", createTools, toolSession, options.toolNames);

		// Restricted sessions cannot inherit or discover MCP capabilities.
		const enableMCP = !restrictToolNames && (options.enableMCP ?? true);
		let mcpManager: MCPManager | undefined = enableMCP ? options.mcpManager : undefined;
		toolSession.mcpManager = mcpManager;
		toolSession.enableMCP = enableMCP;
		let startDeferredMCPDiscovery:
			| ((liveSession: AgentSession, activation: DeferredMCPActivation) => void)
			| undefined;
		const customTools: CustomTool[] = [];
		const startupQuiet = settings.get("startup.quiet");
		const onMCPStatus = (event: McpConnectionStatusEvent) => {
			if (!options.hasUI || startupQuiet) return;
			if (event.type === "connecting" && event.serverNames.length === 0) return;
			eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
		};
		const mcpDiscoverOptions = {
			onStatus: onMCPStatus,
			enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
			// Always filter Exa - we have native integration
			filterExa: true,
			// Filter browser MCP servers when builtin browser tool is active
			filterBrowser: settings.get("browser.enabled") ?? false,
		};
		// UI sessions defer MCP connections until the live session can reconcile
		// discovery mode, explicit tool requests, and persisted selections together.
		const deferMCPDiscoveryForUI = options.hasUI === true;
		if (enableMCP && !mcpManager) {
			if (deferMCPDiscoveryForUI) {
				const cacheStorage = settings.getStorage();
				mcpManager = new MCPManager(cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null);
				mcpManager.setAuthStorage(authStorage);
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}
				const deferredMCPManager = mcpManager;
				startDeferredMCPDiscovery = (liveSession, activation) => {
					void (async () => {
						try {
							const mcpResult = await logger.time("discoverAndLoadMCPTools", () =>
								deferredMCPManager.discoverAndConnect(mcpDiscoverOptions),
							);
							// The session can be torn down while servers are still connecting.
							// Don't resurrect tools on a disposed session, and don't leak the
							// transports/subprocesses the connect just spawned.
							if (liveSession.isDisposed) {
								await deferredMCPManager.disconnectAll();
								return;
							}
							applyMCPEnvironment(mcpResult);
							logMCPLoadErrors(mcpResult.errors);
							// `tools.discoveryMode: "auto"` was resolved before deferred MCP
							// tools existed. Reconcile again before refresh so a large toolset
							// cannot bypass discovery by arriving after first paint.
							let discoveryEnabled = activation.mcpDiscoveryEnabled;
							let activateAll = activation.activateAllMCPTools;
							if (
								!discoveryEnabled &&
								(await enableDeferredMCPDiscoveryForTools(liveSession, mcpResult.tools))
							) {
								discoveryEnabled = true;
								activateAll = false;
							}
							await liveSession.refreshMCPTools(mcpResult.tools, { activateAll });
							// refreshMCPTools rebuilds the active set from the explicit tool
							// whitelist, dropping the discovery tool added above. Re-enable MCP
							// discovery and search together so observers never see discovery on
							// before the activation tool is available.
							if (discoveryEnabled) {
								await liveSession.enableMCPDiscoveryWithSearchTool(effectiveDiscoveryMode);
							}
							if (activation.explicitlyRequestedMCPToolNames.length > 0) {
								if (discoveryEnabled && !activation.mcpDiscoveryEnabled) {
									// Discovery flipped on mid-flight: route the explicit request
									// through discovery-aware activation so selection persists.
									await liveSession.activateDiscoveredMCPTools(activation.explicitlyRequestedMCPToolNames);
								} else if (!discoveryEnabled && !activateAll) {
									await liveSession.setActiveToolsByName([
										...liveSession.getActiveToolNames(),
										...activation.explicitlyRequestedMCPToolNames,
									]);
								}
							}
						} catch (error) {
							logger.error("MCP tool load failed", {
								path: ".mcp.json",
								error: error instanceof Error ? error.message : String(error),
							});
						}
					})();
				};
			} else {
				const mcpResult = await logger.time("discoverAndLoadMCPTools", discoverAndLoadMCPTools, cwd, {
					...mcpDiscoverOptions,
					cacheStorage: settings.getStorage(),
					authStorage,
				});
				mcpManager = mcpResult.manager;
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}
				applyMCPEnvironment(mcpResult);

				// Log MCP errors
				for (const { path, error } of mcpResult.errors) {
					logger.error("MCP tool load failed", { path, error });
				}

				if (mcpResult.tools.length > 0) {
					// MCP tools are LoadedCustomTool, extract the tool property
					customTools.push(...mcpResult.tools.map(loaded => loaded.tool));
				}
			}
		}

		// Only top-level sessions own the global MCPManager. Subagents already
		// receive the parent's manager via `options.mcpManager`, and reassigning
		// the singleton to the same value is a no-op — keep the gate explicit
		// to mirror the AsyncJobManager ownership rule.
		if (mcpManager && !options.parentTaskPrefix) MCPManager.setInstance(mcpManager);

		const builtInToolNames = builtinTools.map(t => t.name);
		let customToolPaths: ToolPathWithSource[] = [];
		const inlineExtensions: ExtensionFactory[] = [];
		if (!minimalExtensionRuntime && !restrictToolNames) {
			// Add image tools when generation is enabled and either no explicit tool
			// whitelist was given or it names `generate_image`. Unlike built-in tools
			// (filtered in `createTools`), custom tools are force-activated via
			// `alwaysInclude` below, so an explicit `--no-tools`/whitelist must be
			// honored here or image-gen would leak past every filter (issue #5305).
			const imageGenRequested = !options.toolNames || options.toolNames.includes("generate_image");
			if (settings.get("generate_image.enabled") && imageGenRequested) {
				const imageGenTools = await logger.time("getImageGenTools", () => getImageGenTools(modelRegistry, model));
				if (imageGenTools.length > 0) {
					customTools.push(...(imageGenTools as unknown as CustomTool[]));
				}
			}

			if (settings.get("speechgen.enabled")) {
				customTools.push(ttsTool as unknown as CustomTool);
			}

			// Add web search tools
			if (options.toolNames?.includes("web_search")) {
				customTools.push(...getSearchTools());
			}
			// Discover custom tools from `.omp/tools/`, `.claude/tools/`, plugins, etc.
			// Subagents reuse the parent's scan via `preloadedCustomToolPaths` to skip
			// the FS walk, but ALWAYS re-call `loadCustomTools` here so factories bind
			// to THIS session's `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
			// Forwarding the parent's `LoadedCustomTool[]` directly would route tool
			// execution back through the parent — wrong for isolated tasks and for
			// pending-action queueing.

			customToolPaths =
				options.preloadedCustomToolPaths ??
				(await logger.time("discoverCustomToolPaths", () => discoverCustomToolPaths([], cwd)));
			const customToolsLoadResult = await logger.time("loadCustomTools", () =>
				loadCustomTools(customToolPaths, cwd, builtInToolNames, action => queueResolveHandler(toolSession, action)),
			);
			for (const { path, error } of customToolsLoadResult.errors) {
				logger.error("Custom tool load failed", { path, error });
			}
			if (customToolsLoadResult.tools.length > 0) {
				customTools.push(...customToolsLoadResult.tools.map(loaded => loaded.tool));
			}

			inlineExtensions.push(...(options.extensions ?? []));
			inlineExtensions.push(createAutoresearchExtension);
			if (customTools.length > 0) {
				inlineExtensions.push(createCustomToolsExtension(customTools));
			}
		}
		// Forward the path list (NOT the loaded tools) to subagents so they
		// re-bind under their own `CustomToolAPI` while skipping the FS scan.
		toolSession.customToolPaths = customToolPaths;

		const contextGcDbPath = options.contextGcDbPath ?? path.join(agentDir, "context-gc.sqlite");
		const isHerdrSubagentSession = options.parentTaskPrefix !== undefined || (options.taskDepth ?? 0) > 0;
		const nativeHerdrAgentStateEnabled =
			!minimalExtensionRuntime && !isHerdrSubagentSession && isNativeHerdrAgentStateEnabled();

		// Load extensions. Restricted sessions and minimal subagent runtimes skip
		// extension evaluation; normal sessions preserve preloaded and discovered paths.
		//      Extension instances. Shallow-clone `extensions` so the inline
		//      push below cannot mutate the caller's array. `runtime` is shared
		//      so flag values set pre-creation flow into the live session.
		//   3. `preloadedExtensionPaths` (subagent): caller resolved paths;
		//      skip the FS scan but always re-call `loadExtensions` here so
		//      each `Extension` binds to THIS session's `ExtensionAPI`
		//      (cwd, eventBus, runtime).
		//   4. No preload: run the full session discovery.
		// `disableExtensionDiscovery` is honored implicitly: a caller that set
		// the flag and pre-resolved the result already reflects that choice.
		let extensionPaths: string[] = [];
		let extensionsResult: LoadExtensionsResult;
		try {
			if (restrictToolNames || minimalExtensionRuntime) {
				extensionsResult = await logger.time("loadExtensions", loadExtensions, [], cwd, eventBus);
			} else if (options.preloadedExtensions) {
				const preloadedExtensions = isHerdrSubagentSession
					? options.preloadedExtensions.extensions.filter(
							extension =>
								!isHerdrAgentStateExtensionPath(extension.path) &&
								!isHerdrAgentStateExtensionPath(extension.resolvedPath),
						)
					: options.preloadedExtensions.extensions;
				extensionsResult = {
					...options.preloadedExtensions,
					extensions: [...preloadedExtensions],
				};
				// Capture paths for downstream forwarding; filter inline-factory
				// entries plus Herdr state reporters — those are per-session, not
				// subagent source paths.
				extensionPaths = filterSubagentExtensionPaths(
					extensionsResult.extensions.map(ext => ext.resolvedPath).filter(p => !p.startsWith("<inline")),
					true,
				);
			} else if (options.preloadedExtensionPaths) {
				extensionPaths = filterSubagentExtensionPaths(options.preloadedExtensionPaths, isHerdrSubagentSession);
				extensionsResult = await withContextGcDbPath(contextGcDbPath, async () =>
					logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus),
				);
				for (const { path, error } of extensionsResult.errors) {
					logger.error("Failed to load extension", { path, error });
				}
			} else {
				const discoveredExtensionPaths = await logger.time("discoverSessionExtensionPaths", () =>
					discoverSessionExtensionPaths(options, cwd, settings),
				);
				extensionPaths = filterSubagentExtensionPaths(discoveredExtensionPaths, isHerdrSubagentSession);
				extensionsResult = await withContextGcDbPath(contextGcDbPath, async () =>
					logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus),
				);
				for (const { path, error } of extensionsResult.errors) {
					logger.error("Failed to load extension", { path, error });
				}
			}
		} catch (error) {
			reportSoftCrash({
				label: "extension-load",
				error,
				context: { phase: "session-startup" },
			});
			throw error;
		}
		// Forward the source-path list (NOT the loaded instances) so subagents
		// rebuild their own session-scoped extensions.
		toolSession.extensionPaths = extensionPaths;

		let shouldAppendNativeSystemContextReminderPrompt = false;
		try {
			await withContextGcDbPath(contextGcDbPath, async () => {
				// Load inline extensions from factories
				if (inlineExtensions.length > 0) {
					for (let i = 0; i < inlineExtensions.length; i++) {
						const factory = inlineExtensions[i];
						const loaded = await loadExtensionFromFactory(
							factory,
							cwd,
							eventBus,
							extensionsResult.runtime,
							`<inline-${i}>`,
						);
						extensionsResult.extensions.push(loaded);
					}
				}

				if (nativeHerdrAgentStateEnabled) {
					if (
						extensionsResult.extensions.some(
							extension => extension.path === HERDR_NATIVE_AGENT_STATE_EXTENSION_PATH,
						)
					) {
						logger.debug("herdr-agent-state: native append skipped (already present)");
					} else {
						const loaded = await loadExtensionFromFactory(
							createHerdrAgentStateExtension(),
							cwd,
							eventBus,
							extensionsResult.runtime,
							HERDR_NATIVE_AGENT_STATE_EXTENSION_PATH,
						);
						extensionsResult.extensions.push(loaded);
						logger.debug("herdr-agent-state: native reporter appended");
					}
				} else if (process.env.HERDR_ENV === "1") {
					logger.warn("herdr-agent-state: reporter NOT enabled in a herdr pane", {
						minimalExtensionRuntime,
						isHerdrSubagentSession,
						marker: process.env.OMP_NATIVE_HERDR_AGENT_STATE,
					});
				}
				// Context GC is shipped as a plugin package for external reuse, but loaded natively in
				// bundled OMPx so users get durable unload/recall without `ompx plugin install`. This runs
				// after user inline factories so wrappers that set the same label are deduped too.
				if (
					!minimalExtensionRuntime &&
					!extensionsResult.extensions.some(extension => extension.label === "Context GC")
				) {
					const loaded = await loadExtensionFromFactory(
						createContextGcExtension({ dbPath: contextGcDbPath }),
						cwd,
						eventBus,
						extensionsResult.runtime,
						"<native-context-gc>",
					);
					extensionsResult.extensions.push(loaded);
				}

				// The system-context reminder is also shipped as a plugin package, but loaded natively so
				// bundled omp can remind the agent when its final prose drops high-priority persona context.
				if (
					!minimalExtensionRuntime &&
					!extensionsResult.extensions.some(extension => extension.label === SYSTEM_CONTEXT_REMINDER_LABEL)
				) {
					const loaded = await loadExtensionFromFactory(
						createSystemContextReminderExtension({ injectPromptOnBeforeAgentStart: false }),
						cwd,
						eventBus,
						extensionsResult.runtime,
						"<native-system-context-reminder>",
					);
					extensionsResult.extensions.push(loaded);
					shouldAppendNativeSystemContextReminderPrompt = true;
				}
			});
		} catch (error) {
			reportSoftCrash({
				label: "extension-load",
				error,
				context: { phase: "inline-factory" },
			});
			throw error;
		}

		// Process provider registrations queued during extension loading.
		// This must happen before the runner is created so that models registered by
		// extensions are available for model selection on session resume / fallback.
		const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
		modelRegistry.syncExtensionSources(activeExtensionSources);
		for (const sourceId of new Set(activeExtensionSources)) {
			modelRegistry.clearSourceRegistrations(sourceId);
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}
		// Hydrate cached runtime (extension) provider catalogs before model
		// resolution. Dynamic-only providers have no synchronous registration side
		// effect, so a cold --model/provider resume must see the same fresh SQLite
		// cache that `omp models find` uses before the online refresh continues in
		// the background.
		await modelRegistry.refreshRuntimeProviders("offline");
		// Continue runtime discovery in the background (cache-aware) so startup is
		// only blocked on local cache reads, not provider network fetches. Stash
		// the promise so the deferred `--model` retry below can await it instead
		// of starting a second concurrent discovery pass (the unfiltered
		// `refresh()` also covers runtime model managers).
		const runtimeDiscoveryPromise = modelRegistry.refreshRuntimeProviders().catch(error => {
			logger.warn("runtime provider discovery failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});

		// Retry session-model candidates now that extension providers are
		// registered. The initial restore runs before extensions load, so a role
		// model supplied by an extension would have either fallen back to the
		// saved default (`restoredSessionModelIndex > 0`) or failed entirely
		// (`restoredSessionModelIndex === -1`, with the settings default or
		// downstream fallback filling `model`). Reclaim it here so resume
		// honors the last active role in either case.
		const sessionRetryLimit = restoredSessionModelIndex >= 0 ? restoredSessionModelIndex : sessionModelStrings.length;
		if (!hasExplicitModel && sessionRetryLimit > 0) {
			for (let i = 0; i < sessionRetryLimit; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowMaxSuffix: true,
					allowAutoAlias: true,
					isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
				});
				if (!parsedModel) continue;
				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && hasModelAuth(restoredModel)) {
					model = restoredModel;
					modelFallbackMessage = undefined;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;
					// Recompute thinking-level from scratch against the reclaimed
					// model: any value derived from the earlier fallback model's
					// `thinking.defaultLevel` must not become sticky.
					thinkingLevel = pickInitialThinkingLevel(restoredModel);
					autoThinking = thinkingLevel === AUTO_THINKING;
					effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
					effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
						autoThinking
							? resolveProvisionalAutoLevel(restoredModel)
							: resolveThinkingLevelForModel(restoredModel, effectiveThinkingLevel),
					);
					preconnectModelHost(restoredModel.baseUrl);
					break;
				}
			}
		}
		// Resolve deferred --model/subagent patterns now that extension models are
		// registered. Use the same CLI resolver as the immediate path so bare role
		// names, exact model names, and provider selectors keep one precedence rule.
		if (!model && deferredModelPatterns.length > 0) {
			// Deferred `--model` patterns almost always failed at the immediate
			// path (main.ts:881) precisely because discovery-backed providers
			// hadn't populated yet. Await the in-flight runtime discovery
			// already kicked off above (stash + reuse avoids a second concurrent
			// `#refreshRuntimeDiscoveries` pass for the same runtime model
			// managers; it resolves instantly when no runtime managers are
			// registered). `refreshRuntimeProviders()` only covers runtime model
			// managers, not config-discovery providers (e.g. user-configured
			// ollama); fall back to a full cache-aware refresh only when the
			// runtime pass didn't surface a match AND config-discovery providers
			// exist to fetch from. By then runtime managers short-circuit on the
			// fresh cache written by the awaited pass, closing the double-fetch
			// window.
			await logger.time("resolveModelDiscoveryDeferredRetry", () => runtimeDiscoveryPromise);
			const matchPreferences = getModelMatchPreferences(settings);
			const runtimeResolved = deferredModelPatterns.some(pattern =>
				pattern.split(",").some(selector => {
					const trimmedSelector = selector.trim();
					if (!trimmedSelector) return false;
					const resolved = resolveCliModel({
						cliModel: trimmedSelector,
						modelRegistry,
						settings,
						preferences: matchPreferences,
					});
					return Boolean(
						resolved.model || (resolved.configuredPatterns && resolved.configuredPatterns.length > 0),
					);
				}),
			);
			if (!runtimeResolved && modelRegistry.getDiscoverableProviders().length > 0) {
				await logger.time("resolveModelDiscoveryFallbackNonRuntime", () =>
					modelRegistry.refresh("online-if-uncached"),
				);
			}
			const availableModels = modelRegistry.getAll();
			const expandedModelPatterns = deferredModelPatterns.flatMap(pattern =>
				pattern.split(",").flatMap(selector => {
					const trimmedSelector = selector.trim();
					if (!trimmedSelector) return [];
					const resolved = resolveCliModel({
						cliModel: trimmedSelector,
						modelRegistry,
						settings,
						preferences: matchPreferences,
					});
					if (resolved.configuredPatterns && resolved.configuredPatterns.length > 0) {
						const primaryPatterns: Array<{
							pattern: string;
							retryFallback: InitialRetryFallbackState | undefined;
						}> = resolved.configuredPatterns.map(pattern => ({
							pattern,
							retryFallback: undefined,
						}));
						if (!resolved.configuredRole || !settings.get("retry.modelFallback")) {
							return primaryPatterns;
						}
						const fallbackContext: RetryFallbackResolutionContext = {
							chains: expandDefaultRetryFallbackChains(settings.get("retry.fallbackChains"), [
								...Object.keys(settings.getModelRoles()),
								resolved.configuredRole,
							]),
							getModelRole: role => settings.getModelRole(role),
							modelLookup: modelRegistry,
						};
						const originalSelector = resolved.configuredPatterns[0];
						const originalModel = parseModelPattern(originalSelector, availableModels, matchPreferences).model;
						const chainKey = resolveRetryFallbackChainKey(
							fallbackContext,
							originalSelector,
							originalModel,
							resolved.configuredRole,
						);
						if (!chainKey) return primaryPatterns;
						const parsedOriginal = parseModelString(originalSelector, {
							allowMaxSuffix: true,
							allowAutoAlias: true,
							isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
						});
						const retryFallback: InitialRetryFallbackState = {
							role: chainKey,
							originalSelector,
							originalThinkingLevel: parsedOriginal?.thinkingLevel,
						};
						return [
							...primaryPatterns,
							...findRetryFallbackCandidates(fallbackContext, chainKey, originalSelector, originalModel, {
								allowMissingPrimary: true,
							}).map(candidate => ({ pattern: candidate.raw, retryFallback })),
						];
					}
					if (resolved.model) {
						return [
							{
								pattern: formatModelSelectorValue(
									resolved.selector ?? formatModelStringWithRouting(resolved.model),
									resolved.thinkingLevel,
								),
								retryFallback: undefined,
							},
						];
					}
					return resolveConfiguredModelPatterns([trimmedSelector], settings).map(pattern => ({
						pattern,
						retryFallback: undefined,
					}));
				}),
			);
			let usageFallbackTriggered = false;
			for (let patternIndex = 0; patternIndex < expandedModelPatterns.length; patternIndex += 1) {
				const { pattern, retryFallback } = expandedModelPatterns[patternIndex];
				const primary = parseModelPattern(pattern, availableModels, matchPreferences);
				if (!primary.model || (retryFallback && !hasModelAuth(primary.model))) continue;
				let hasUsageFallbackCandidate = false;
				for (
					let candidateIndex = patternIndex + 1;
					candidateIndex < expandedModelPatterns.length;
					candidateIndex += 1
				) {
					const candidate = parseModelPattern(
						expandedModelPatterns[candidateIndex].pattern,
						availableModels,
						matchPreferences,
					);
					if (candidate.model && hasModelAuth(candidate.model)) {
						hasUsageFallbackCandidate = true;
						break;
					}
				}
				const usageReservePolicy = settings.get("retry.usageReservePolicy");
				if (
					(hasUsageFallbackCandidate || usageReservePolicy === "fail-closed") &&
					settings.get("retry.modelFallback") &&
					settings.get("retry.usageAwareFallback")
				) {
					let usageHealth: ModelUsageHealth | undefined;
					try {
						usageHealth = await modelRegistry.authStorage.getModelUsageHealth(primary.model.provider, {
							modelId: primary.model.id,
							baseUrl: primary.model.baseUrl,
							reserveFraction: settings.get("retry.usageReservePct") / 100,
						});
					} catch (error) {
						logger.debug("Usage-aware model preflight failed open", {
							provider: primary.model.provider,
							model: primary.model.id,
							error: String(error),
						});
					}
					if (usageHealth?.state === "depleted") {
						if (usageReservePolicy === "fail-closed") {
							throw new Error(
								`Usage depleted for ${primary.model.provider}/${primary.model.id}; reserve policy is fail-closed.`,
							);
						}
						usageFallbackTriggered = true;
						continue;
					}
					if (usageHealth?.state === "reserve") {
						if (usageReservePolicy === "fail-closed") {
							throw new Error(
								`Usage reserve reached for ${primary.model.provider}/${primary.model.id}; reserve policy is fail-closed.`,
							);
						}
						if (usageReservePolicy === "auto" || (!options.hasUI && !options.deferUsageReserveConfirmation)) {
							usageFallbackTriggered = true;
							continue;
						}
					}
				}
				let selectedModel = primary.model;
				let selectedThinkingLevel = primary.thinkingLevel;
				let selectedExplicitThinkingLevel = primary.explicitThinkingLevel;
				// A chain entry without its own `:level` suffix inherits the
				// unavailable primary's configured thinking level, matching
				// runtime fallback-chain semantics.
				if (retryFallback && !selectedExplicitThinkingLevel && retryFallback.originalThinkingLevel !== undefined) {
					selectedThinkingLevel = retryFallback.originalThinkingLevel;
					selectedExplicitThinkingLevel = true;
				}
				let authFallbackUsed = false;
				if (options.modelPatternAuthFallback) {
					const primaryKey = await modelRegistry.getApiKey(primary.model);
					if (primaryKey !== kNoAuth && !isAuthenticated(primaryKey)) {
						const fallback = parseModelPattern(
							options.modelPatternAuthFallback,
							availableModels,
							matchPreferences,
						);
						if (fallback.model) {
							const fallbackKey = await modelRegistry.getApiKey(fallback.model);
							if (isAuthenticated(fallbackKey)) {
								selectedModel = fallback.model;
								selectedThinkingLevel = fallback.thinkingLevel;
								selectedExplicitThinkingLevel = fallback.explicitThinkingLevel;
								authFallbackUsed = true;
							}
						}
					}
				}
				if (!authFallbackUsed && options.modelPatternFallbackRole) {
					const primarySelector = formatModelSelectorValue(
						formatModelStringWithRouting(primary.model),
						primary.thinkingLevel,
					);
					const seenSelectors = new Set<string>([primarySelector]);
					const fallbackSelectors: string[] = [];
					for (const fallbackEntry of expandedModelPatterns.slice(patternIndex + 1)) {
						const fallback = parseModelPattern(fallbackEntry.pattern, availableModels, matchPreferences);
						if (!fallback.model) continue;
						const fallbackSelector = formatModelSelectorValue(
							formatModelStringWithRouting(fallback.model),
							fallback.thinkingLevel,
						);
						if (seenSelectors.has(fallbackSelector)) continue;
						seenSelectors.add(fallbackSelector);
						fallbackSelectors.push(fallbackSelector);
					}
					if (fallbackSelectors.length === 0) {
						for (const selector of options.modelPatternDefaultFallbackChain ?? []) {
							if (typeof selector !== "string" || seenSelectors.has(selector)) continue;
							seenSelectors.add(selector);
							fallbackSelectors.push(selector);
						}
					}
					if (fallbackSelectors.length > 0) {
						const modelRoles: Record<string, string> = {};
						const existingRoles = settings.getModelRoles();
						for (const role in existingRoles) {
							const selector = existingRoles[role];
							if (selector) {
								modelRoles[role] = selector;
							}
						}
						modelRoles[options.modelPatternFallbackRole] = primarySelector;
						settings.override("modelRoles", modelRoles);
						const fallbackChains: Record<string, string[]> = {
							[options.modelPatternFallbackRole]: fallbackSelectors,
						};
						const existingFallbackChains = settings.get("retry.fallbackChains");
						for (const role in existingFallbackChains) {
							if (role !== options.modelPatternFallbackRole) {
								fallbackChains[role] = existingFallbackChains[role];
							}
						}
						settings.override("retry.fallbackChains", fallbackChains);
					}
				}
				model = selectedModel;
				initialRetryFallback =
					retryFallback && usageFallbackTriggered ? { ...retryFallback, pinned: true } : retryFallback;
				modelFallbackMessage = undefined;
				if (selectedExplicitThinkingLevel) {
					restoredSessionThinkingLevel = selectedThinkingLevel;
				}
				thinkingLevel = pickInitialThinkingLevel(selectedModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(selectedModel)
						: resolveThinkingLevelForModel(selectedModel, effectiveThinkingLevel),
				);
				preconnectModelHost(selectedModel.baseUrl);
				break;
			}
			if (!model) {
				const requested =
					deferredModelPatterns.length === 1
						? `"${deferredModelPatterns[0]}"`
						: `one of ${deferredModelPatterns.map(pattern => `"${pattern}"`).join(", ")}`;
				modelFallbackMessage = `Model ${requested} not found`;
			}
		}

		// Fall back to first available model with a valid API key, honoring the
		// path-scoped `enabledModels` allow-list when configured. Skip when the
		// user explicitly requested a model via --model that wasn't found.
		if (!model && deferredModelPatterns.length === 0) {
			// Retry the configured default role against the current catalog,
			// setting `model` (+ thinking level) when it resolves. Extension
			// factories register providers AFTER the early `defaultRoleSpec`
			// resolution, and configured discovery providers may still be
			// mid-discovery, so a role pointing at such a model (an openai-compat
			// plugin's `posthog/claude-opus-4-8`, a models.yml `openai-models-list`
			// endpoint) returned `undefined` there. Without this retry the
			// `pickDefaultAvailableModel` fallback below happily replaces the
			// user's configured default with a bundled provider's default whenever
			// a stray `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is in the environment.
			// (issues #3569, #6162)
			const tryResolveDefaultRole = async (): Promise<boolean> => {
				if (hasExplicitModel) return false;
				// Re-resolve the allowed set: extension factories and discovery
				// refreshes above may have registered models not visible earlier.
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				const reResolvedRoleSpec = resolveModelRoleValue(settings.getModelRole("default"), fallbackCandidates, {
					settings,
					matchPreferences: modelMatchPreferences,
				});
				if (!reResolvedRoleSpec.model) return false;
				defaultRoleSpec = reResolvedRoleSpec;
				const resolvedDefaultModel = reResolvedRoleSpec.model;
				model = resolvedDefaultModel;
				modelFallbackMessage = undefined;
				// Recompute the thinking level against the now-real model.
				// `pickInitialThinkingLevel` closes over `defaultRoleSpec`,
				// so the role's explicit selector (e.g. `:max`) now applies.
				thinkingLevel = pickInitialThinkingLevel(resolvedDefaultModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(resolvedDefaultModel)
						: resolveThinkingLevelForModel(resolvedDefaultModel, effectiveThinkingLevel),
				);
				preconnectModelHost(resolvedDefaultModel.baseUrl);
				return true;
			};

			await tryResolveDefaultRole();

			if (!model) {
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				let pick = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth));

				// Cold-cache discovery race (issues #6114, #6162): a discovery
				// provider (models.yml `openai-models-list`, LM Studio/Ollama/
				// llama.cpp, or an openai-compat proxy) ships no static models, so
				// the static+cached catalog resolved nothing above. Background
				// discovery in main.ts fires only AFTER createAgentSession returns,
				// so on a cache-cold boot the configured default stays unresolved
				// and `pick` silently degrades to an unrelated authed provider's
				// default (#6162) or "No models available" (#6114) — even though
				// `omp models` (which awaits discovery) lists the model. Await one
				// cache-aware discovery pass and retry when a default role is
				// configured (must win over `pick`) or nothing resolved at all.
				// The common path — role already resolved, or a `pick` with no
				// configured default — never pays for it.
				const defaultRoleConfigured = Boolean(settings.getModelRole("default"));
				if (
					!hasExplicitModel &&
					(defaultRoleConfigured || !pick) &&
					modelRegistry.getDiscoverableProviders().length > 0
				) {
					await logger.time("resolveModelDiscoveryFallback", () => modelRegistry.refresh("online-if-uncached"));
					if (!(await tryResolveDefaultRole()) && !model) {
						const refreshedCandidates = await resolveAllowedModels(
							modelRegistry,
							settings,
							modelMatchPreferences,
						);
						pick = pickDefaultAvailableModel(refreshedCandidates.filter(hasModelAuth));
					}
				}

				if (!model && pick) {
					model = pick;
				}
			}
			if (model) {
				if (modelFallbackMessage) {
					modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
				}
			} else {
				const patterns = settings.get("enabledModels");
				modelFallbackMessage =
					patterns && patterns.length > 0
						? `No model available matching enabledModels (${patterns.join(", ")}) with usable credentials. Configure auth for an allowed provider or adjust enabledModels.`
						: "No models available. Use /login or set an API key environment variable. Then use /model to select a model.";
			}
		}

		if (model) {
			const selectedModel = model;
			const refreshedModel = await logger.time("refreshInitialModelMetadata", () =>
				modelRegistry.refreshSelectedModelMetadata(selectedModel),
			);
			if (refreshedModel !== selectedModel) {
				model = refreshedModel;
				thinkingLevel = pickInitialThinkingLevel(refreshedModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(refreshedModel)
						: resolveThinkingLevelForModel(refreshedModel, effectiveThinkingLevel),
				);
			}
		}

		// A first-turn user tail has no assistant metadata to copy. Once startup
		// has selected its final model, use that model to terminate the
		// interrupted turn before the live agent consumes the restored context.
		if (model) {
			const selectedModelAbort = createInterruptedTurnAbortMessage(existingBranch, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			if (selectedModelAbort) {
				sessionManager.appendMessage(selectedModelAbort);
				existingBranch = logger.time("getRecoveredUserTailBranch", () => sessionManager.getBranch());
				existingSession = logger.time("loadRecoveredUserTailContext", () =>
					deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
				);
			}
		}

		// Restricted and minimal sessions do not discover or evaluate custom command modules.
		const customCommandsResult: CustomCommandsLoadResult =
			options.disableExtensionDiscovery || minimalExtensionRuntime || restrictToolNames
				? { commands: [], errors: [] }
				: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
		if (!options.disableExtensionDiscovery && !minimalExtensionRuntime && !restrictToolNames) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
			}
		}

		// The runner is created unconditionally — even with zero extensions loaded — because the
		// `ExtensionToolWrapper` installed below is the only place the per-tool approval gate runs.
		// A conditional runner means the approval system silently disappears for users with no
		// extensions, contradicting non-yolo `tools.approvalMode` settings without feedback.
		// (The builtin autoresearch extension is unconditionally loaded above, so this scenario
		// is unreachable; unconditional runner construction keeps that invariant explicit and
		// prevents future optional extensions from silently re-opening the hole.)
		const extensionRunner: ExtensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
			() => (hasSession ? createSessionMemoryRuntimeContext(session, agentDir, cwd) : undefined),
			settings,
			localProtocolOptions,
		);

		credentialDisabledTarget = extensionRunner;
		for (const event of startupCredentialDisabledEvents.splice(0)) {
			// Discard return: any handler error is routed through runner.onError listeners.
			void extensionRunner.emitCredentialDisabled(event);
		}

		const getSessionContext = () => ({
			sessionManager,
			modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				session.abort({ reason: USER_INTERRUPT_LABEL });
			},
			settings,
			localProtocolOptions,
			autoApprove: options.autoApprove ?? false,
		});
		const toolContextStore = new ToolContextStore(getSessionContext);

		const registeredTools = restrictToolNames ? [] : extensionRunner.getAllRegisteredTools();
		const sdkCustomTools = restrictToolNames
			? []
			: (options.customTools?.filter(tool => !isLegacyBuiltinToolDefinition(tool)) ?? []);
		const allCustomTools = [
			...registeredTools,
			...sdkCustomTools.map(tool => {
				const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
				return { definition, extensionPath: "<sdk>" };
			}),
		];
		// `wrapToolWithMetaNotice` runs the centralized large-output → artifact spill.
		// Built-in tools get it in `createTools`; extension, SDK-custom, image-gen,
		// TTS, and startup (non-deferred) MCP tools all funnel through here, so apply
		// it once at this adapter boundary (idempotent — a no-op if already wrapped).
		const wrappedExtensionTools: Tool[] = wrapRegisteredTools(allCustomTools, extensionRunner).map(
			wrapToolWithMetaNotice,
		);

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
		const builtInRegistryToolNames = new Set<string>();
		const toolRegistry = new Map<string, Tool>();
		for (const tool of builtinTools) {
			toolRegistry.set(tool.name, tool);
			builtInRegistryToolNames.add(tool.name);
		}
		if (!restrictToolNames && settings.get("goal.enabled")) {
			for (const goalToolName of GOAL_HIDDEN_TOOL_NAMES) {
				if (toolRegistry.has(goalToolName)) continue;
				const goalTool = await logger.time(
					`createTools:${goalToolName}:session`,
					HIDDEN_TOOLS[goalToolName],
					toolSession,
				);
				if (goalTool) {
					toolRegistry.set(goalTool.name, wrapToolWithMetaNotice(goalTool));
					builtInRegistryToolNames.add(goalTool.name);
				}
			}
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
			builtInRegistryToolNames.delete(tool.name);
		}
		if (deferMCPDiscoveryForUI && mcpManager) {
			for (const name of collectPendingMCPToolNames(options.toolNames)) {
				if (!toolRegistry.has(name)) {
					toolRegistry.set(name, createPendingMCPTool(name));
				}
			}
		}

		// Wrap every tool with `ExtensionToolWrapper` so the per-tool approval gate runs on every
		// call site, regardless of whether any user extensions are loaded. See the runner-construction
		// comment above for the safety invariant this enforces.
		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
		}
		if (model?.provider === "cursor") {
			toolRegistry.delete("edit");
			builtInRegistryToolNames.delete("edit");
		}

		let writeRegistration: Promise<boolean> | undefined;
		const ensureWriteRegistered = (): Promise<boolean> => {
			if (toolRegistry.has("write")) return Promise.resolve(builtInRegistryToolNames.has("write"));
			writeRegistration ??= (async () => {
				const writeTool = await logger.time("createTools:write:session", BUILTIN_TOOLS.write, toolSession);
				if (!writeTool || toolRegistry.has("write")) return builtInRegistryToolNames.has("write");
				toolRegistry.set(
					writeTool.name,
					new ExtensionToolWrapper(wrapToolWithMetaNotice(writeTool), extensionRunner) as Tool,
				);
				builtInRegistryToolNames.add(writeTool.name);
				return true;
			})().finally(() => {
				writeRegistration = undefined;
			});
			return writeRegistration;
		};

		// Existing staged/device paths need write registered before active-set assembly.
		// Deferred MCP also registers it now, but refresh activates it only after a server connects.
		const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
		const hasXdevTools = (toolSession.xdevRegistry?.size ?? 0) > 0;
		const planModeAvailable = settings.get("plan.enabled");
		if (!restrictToolNames && (hasDeferrableTools || hasXdevTools || planModeAvailable || deferMCPDiscoveryForUI)) {
			await ensureWriteRegistered();
		}
		if (!restrictToolNames && !toolRegistry.has("search_tool_bm25")) {
			const searchTool: Tool = new SearchToolBm25Tool(toolSession);
			toolRegistry.set(
				searchTool.name,
				new ExtensionToolWrapper(wrapToolWithMetaNotice(searchTool), extensionRunner) as Tool,
			);
			builtInRegistryToolNames.add(searchTool.name);
		}
		let effectiveDiscoveryMode = resolveEffectiveToolDiscoveryMode(
			settings,
			model ? { contextWindow: model.contextWindow ?? undefined } : undefined,
			countToolsForAutoDiscovery([...toolRegistry.keys()].filter(isMCPToolName)),
			enableMCP,
		);
		let mcpDiscoveryEnabled = effectiveDiscoveryMode !== "off" && !deferMCPDiscoveryForUI;
		async function enableDeferredMCPDiscoveryForTools(
			liveSession: AgentSession,
			mcpTools: CustomTool[],
		): Promise<boolean> {
			if (mcpDiscoveryEnabled) return true;
			const activeNonMCPToolNames = liveSession.getActiveToolNames().filter(name => !isMCPToolName(name));
			const projectedMode = resolveEffectiveToolDiscoveryMode(
				settings,
				undefined,
				countToolsForAutoDiscovery([...activeNonMCPToolNames, ...mcpTools.map(tool => tool.name)]),
				enableMCP,
			);
			if (projectedMode === "off") return false;
			effectiveDiscoveryMode = projectedMode;
			mcpDiscoveryEnabled = true;
			await liveSession.enableMCPDiscoveryWithSearchTool(projectedMode);
			return true;
		}

		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
		// Built-in xd:// devices (ast_edit, debug, browser, lsp, web_search) are
		// mounted in createTools BEFORE this loop wraps registry entries in
		// ExtensionToolWrapper, so the registry holds them unwrapped. The normal
		// `write xd://<tool>` path runs approval through the wrapped `write` tool's
		// tier gate, but Cursor invokes advertised devices via `tool.execute()`
		// directly, and the agent loop's fallback resolver executes mounted
		// devices the model called by their top-level name — so wrap unwrapped
		// devices here to keep the approval/deny/prompt gate. Dynamic mounts
		// (custom/MCP) already come from the wrapped registry.
		const resolveDeviceTool = (name: string): AgentTool | undefined => {
			const device = toolSession.xdevRegistry?.get(name);
			if (!device) return undefined;
			return device instanceof ExtensionToolWrapper ? device : new ExtensionToolWrapper(device, extensionRunner);
		};
		const cursorExecHandlers = new CursorExecHandlers({
			cwd,
			tools: toolRegistry,
			getTool: resolveDeviceTool,
			getToolContext: () => toolContextStore.getContext(),
			emitEvent: event => cursorEventEmitter?.(event),
		});

		// Resolve the inline-descriptors setting against the session-start model.
		// `auto` enforces the per-model policy (inline for Gemini, off otherwise);
		// like the rest of the prune machinery this is fixed for the session, so a
		// mid-session model switch keeps the start-time decision.
		const inlineToolDescriptors = shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), model?.id);
		const eagerTasks = settings.get("task.eager") !== "default";
		const eagerTasksAlways = settings.get("task.eager") === "always";
		const intentField = $flag("PI_INTENT_TRACING", settings.get("tools.intentTracing")) ? INTENT_FIELD : undefined;
		const includeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
		const rebuildSystemPromptUnscoped = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
			context?: SystemPromptRebuildContext,
		): Promise<BuildSystemPromptResult> => {
			const currentCwd = sessionManager.getCwd();
			const usingInitialCwd = currentCwd === cwd;
			const promptContextFilesPromise = usingInitialCwd
				? Promise.resolve(contextFiles)
				: logger.time("discoverContextFiles", discoverContextFiles, currentCwd, agentDir, workspaceRoots);
			const promptWorkspaceTreePromise = usingInitialCwd
				? workspaceTreePromise
				: logger.time("buildWorkspaceTree", () =>
						buildWorkspaceTree(currentCwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }),
					);
			toolContextStore.setToolNames(toolNames);
			const currentModel = agent?.state.model ?? model;
			const currentEffectiveDiscoveryMode = resolveEffectiveToolDiscoveryMode(
				settings,
				currentModel ? { contextWindow: currentModel.contextWindow ?? undefined } : undefined,
				countToolsForAutoDiscovery([...tools.keys()].filter(isMCPToolName)),
				enableMCP,
			);
			const currentMcpDiscoveryEnabled = currentEffectiveDiscoveryMode !== "off";
			const discoverableMCPTools: DiscoverableTool[] = currentMcpDiscoveryEnabled
				? filterBySource(collectDiscoverableTools(tools.values()), "mcp")
				: [];
			const activeToolNames = new Set(toolNames);
			const discoverableBuiltinTools: DiscoverableTool[] =
				currentEffectiveDiscoveryMode === "all"
					? collectDiscoverableTools(
							Array.from(tools.values()).filter(
								tool => tool.loadMode === "discoverable" && !activeToolNames.has(tool.name),
							),
							{ source: "builtin" },
						)
					: [];
			const nativeDiscoveryToolSummaries = discoverableBuiltinTools.map(formatNativeDiscoveryToolSummary);
			const discoverableToolsForDesc: DiscoverableTool[] = [...discoverableBuiltinTools, ...discoverableMCPTools];
			const discoverableToolSummary = summarizeDiscoverableTools(discoverableToolsForDesc);
			const hasDiscoverableTools =
				currentMcpDiscoveryEnabled && toolNames.includes("search_tool_bm25") && discoverableToolsForDesc.length > 0;
			const promptTools = buildSystemPromptToolMetadata(tools, {
				search_tool_bm25: { description: renderSearchToolBm25Description(discoverableToolsForDesc) },
			});
			const learningInstructions = await buildLearningDeveloperInstructions(agentDir, settings, currentCwd);
			const memoryBackend = await resolveMemoryBackend(settings);
			const memoryInstructions = await memoryBackend.buildDeveloperInstructions(agentDir, settings, session);

			// Build combined append prompt: live learning + memory instructions +
			// auto-learn guidance + MCP server instructions. For UI sessions MCP
			// discovery is deferred, so the rebuild that `refreshMCPTools` triggers
			// post-discovery then picks up connected servers' instructions.
			const serverInstructions = mcpManager?.getServerInstructions();
			// Drive guidance off the auto-learn BUILTINS that createTools actually built
			// (provenance, not just an active name): `builtinTools` excludes a
			// custom/extension tool that merely shares the name, and reflects the
			// session-start build.
			const autoLearnInstructions = buildAutoLearnInstructions({
				manageSkill: builtinTools.some(tool => tool.name === "manage_skill"),
				learn: builtinTools.some(tool => tool.name === "learn"),
			});
			const appendParts = [learningInstructions, memoryInstructions, autoLearnInstructions].filter(
				(part): part is string => !!part,
			);
			let appendPrompt: string | undefined = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
			if (serverInstructions && serverInstructions.size > 0) {
				const parts: string[] = [];
				if (appendPrompt) parts.push(appendPrompt);
				parts.push(
					"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
				);
				for (const [srvName, srvInstructions] of serverInstructions) {
					const truncated =
						srvInstructions.length > MAX_MCP_INSTRUCTIONS_LENGTH
							? `${srvInstructions.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH)}\n[truncated]`
							: srvInstructions;
					parts.push(`### ${srvName}\n${truncated}`);
				}
				appendPrompt = parts.join("\n\n");
			}
			// Owned/in-band tool dialects (non-native) require the catalog as `# Tool:`
			// sections; native tool calling lets the compact name list suffice.
			const nativeTools = resolveDialect(settings.get("tools.format"), agent?.state.model ?? model) === undefined;
			if (options.appendSystemPrompt) {
				appendPrompt = appendPrompt
					? `${appendPrompt}\n\n${options.appendSystemPrompt}`
					: options.appendSystemPrompt;
			}
			const defaultPrompt = await buildSystemPromptInternal({
				cwd: currentCwd,
				additionalWorkspaceRoots: sessionManager.getAdditionalDirectories(),
				xdevTools: context?.xdevTools ?? toolSession.xdevRegistry?.entries() ?? [],
				xdevDocs:
					context?.xdevDocs ??
					toolSession.xdevRegistry?.docsAll(
						settings.get("tools.xdevDocs"),
						settings.get("tools.xdevInlineDevices"),
					) ??
					"",
				autoQaEnabled: !restrictToolNames && isAutoQaEnabled(settings),
				resolvedCustomPrompt: options.customSystemPrompt,
				skills: [...(session?.skills ?? skills)],
				contextFiles: await promptContextFilesPromise,
				tools: promptTools,
				toolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				resolvedAppendSystemPrompt: appendPrompt,
				skillsSettings: session?.skillsSettings ?? skillsSettings,
				inlineToolDescriptors,
				nativeTools,
				intentField,
				mcpDiscoveryMode: hasDiscoverableTools,
				mcpDiscoveryServerSummaries: discoverableToolSummary.servers.map(formatDiscoverableToolServerSummary),
				nativeDiscoveryToolSummaries,
				eagerTasks,
				eagerTasksAlways,
				taskBatch: settings.get("task.batch"),
				taskMaxConcurrency: settings.get("task.maxConcurrency"),
				taskIrcEnabled: !restrictToolNames && isIrcEnabled(settings, options.taskDepth ?? 0),
				secretsEnabled,
				workspaceTree: promptWorkspaceTreePromise,
				includeWorkspaceTree,
				memoryRootEnabled: memoryBackend?.id === "local",
				workspaceRoots,
				model: getActiveModelString(),
				includeModelInPrompt: settings.get("includeModelInPrompt"),
				personality: agentKind === "sub" ? "none" : settings.get("personality"),
				renderMermaid: settings.get("tui.renderMermaid"),
				activeRepoContext,
			});

			const contextGcSystemPrompt = toolNames.includes("context_unload")
				? (appendContextGcSystemPrompt(defaultPrompt.systemPrompt) ?? defaultPrompt.systemPrompt)
				: defaultPrompt.systemPrompt;
			const defaultSystemPrompt = shouldAppendNativeSystemContextReminderPrompt
				? (appendSystemContextReminderPrompt(contextGcSystemPrompt) ?? contextGcSystemPrompt)
				: contextGcSystemPrompt;

			if (options.systemPrompt === undefined) {
				return { systemPrompt: defaultSystemPrompt };
			}
			const customPrompt =
				typeof options.systemPrompt === "function"
					? await options.systemPrompt(defaultSystemPrompt)
					: options.systemPrompt;
			return {
				systemPrompt: typeof customPrompt === "string" ? [customPrompt] : customPrompt,
			};
		};
		const rebuildSystemPrompt = (
			toolNames: string[],
			tools: Map<string, AgentTool>,
			context?: SystemPromptRebuildContext,
		): Promise<BuildSystemPromptResult> =>
			promptActiveToolNames.run(new Set(toolNames), () => rebuildSystemPromptUnscoped(toolNames, tools, context));

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const explicitlyRequestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
		// When `requireYieldTool` is set, the subagent's prompts and idle-reminders demand a
		// `yield` call to terminate. The tool registry already includes `yield` (see
		// `createTools`), but an explicit `toolNames` list would otherwise drop it from the
		// active set — leaving the model unable to satisfy the contract. Mirror the same
		// invariant `parseAgentFields` enforces on frontmatter `tools`.
		if (
			options.requireYieldTool === true &&
			explicitlyRequestedToolNames &&
			!explicitlyRequestedToolNames.includes("yield")
		) {
			explicitlyRequestedToolNames.push("yield");
		}
		const explicitToolNameAllows = (name: string): boolean =>
			explicitlyRequestedToolNames === undefined || explicitlyRequestedToolNames.includes(name.toLowerCase());
		const shouldAutoIncludeCustomTool = (name: string): boolean =>
			options.respectToolNamesForCustomTools !== true || explicitToolNameAllows(name);
		// Auto-learn builtins are force-included into the registry by `createTools`
		// for enabled top-level sessions (tools/index.ts), but — like `yield` above —
		// an explicit `toolNames` list would otherwise drop them from the ACTIVE set,
		// leaving the nudge/guidance pointing at tools the model cannot call. Activate
		// exactly the builtins createTools built (`builtInToolNames` — provenance, so a
		// same-named custom/extension tool is never force-activated when auto-learn is
		// off) to keep guidance, controller, and the active set consistent.
		if (!restrictToolNames && explicitlyRequestedToolNames) {
			for (const name of ["manage_skill", "learn"]) {
				if (builtinTools.some(tool => tool.name === name) && !explicitlyRequestedToolNames.includes(name)) {
					explicitlyRequestedToolNames.push(name);
				}
			}
		}
		const requestedToolNames = explicitlyRequestedToolNames ?? toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(
			name => toolRegistry.has(name) && (effectiveDiscoveryMode !== "off" || name !== "search_tool_bm25"),
		);
		const requestedToolNameSet = new Set(normalizedRequested);
		const defaultInactiveToolNames = new Set(
			registeredTools.filter(tool => tool.definition.defaultInactive).map(tool => tool.definition.name),
		);
		const requestedActiveToolNames = normalizedRequested.filter(name => name !== "goal");
		const explicitlyRequestedToolNameSet = explicitlyRequestedToolNames
			? new Set(explicitlyRequestedToolNames)
			: undefined;
		const xdevReadAvailable =
			builtInRegistryToolNames.has("read") &&
			(explicitlyRequestedToolNameSet === undefined || explicitlyRequestedToolNameSet.has("read"));
		const initialRequestedActiveToolNames = options.toolNames
			? requestedActiveToolNames
			: requestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
		const explicitlyRequestedMCPToolNames = options.toolNames
			? (explicitlyRequestedToolNames?.filter(isMCPToolName) ?? [])
			: [];
		const discoveryDefaultServers = new Set(
			(settings.get("mcp.discoveryDefaultServers") ?? []).map(serverName => serverName.trim()).filter(Boolean),
		);
		const discoveryDefaultServerToolNames = mcpDiscoveryEnabled
			? selectDiscoverableToolNamesByServer(
					filterBySource(collectDiscoverableTools(toolRegistry.values()), "mcp"),
					discoveryDefaultServers,
				).filter(explicitToolNameAllows)
			: [];
		const normalizeRenamedBuiltinToolName = normalizeToolName;
		let initialSelectedMCPToolNames: string[] = [];
		let defaultSelectedMCPToolNames: string[] = [];
		let initialToolNames = [...initialRequestedActiveToolNames];
		if (mcpDiscoveryEnabled) {
			const restoredSelectedMCPToolNames = existingSession.selectedMCPToolNames
				.map(normalizeRenamedBuiltinToolName)
				.filter(name => toolRegistry.has(name) && explicitToolNameAllows(name));
			defaultSelectedMCPToolNames = [
				...new Set([...discoveryDefaultServerToolNames, ...explicitlyRequestedMCPToolNames]),
			];
			initialSelectedMCPToolNames = existingSession.hasPersistedMCPToolSelection
				? restoredSelectedMCPToolNames
				: [...new Set([...restoredSelectedMCPToolNames, ...defaultSelectedMCPToolNames])];
			initialToolNames = [
				...new Set([
					...initialRequestedActiveToolNames.filter(name => !name.startsWith("mcp__")),
					...initialSelectedMCPToolNames,
				]),
			];
		} else if (deferMCPDiscoveryForUI && explicitlyRequestedMCPToolNames.length > 0) {
			// Keep not-yet-registered explicit tools as defaults. They become the
			// initial selection only after the deferred MCP connection exposes them.
			defaultSelectedMCPToolNames = explicitlyRequestedMCPToolNames;
		}

		// Custom tools and extension-registered tools are normally included regardless of toolNames filter.
		// Subagents opt into respecting explicit tool whitelists so restricted agents cannot regain
		// parent/extension capabilities through custom-tool registration.
		const alwaysInclude: string[] = [
			...sdkCustomTools.filter(tool => shouldAutoIncludeCustomTool(tool.name.toLowerCase())).map(tool => tool.name),
			...registeredTools
				.filter(
					tool =>
						!tool.definition.defaultInactive &&
						(!mcpDiscoveryEnabled || !isMCPToolName(tool.definition.name)) &&
						shouldAutoIncludeCustomTool(tool.definition.name),
				)
				.map(tool => tool.definition.name),
		];
		for (const name of alwaysInclude) {
			if (!toolRegistry.has(name)) continue;
			if (
				isMCPToolName(name) &&
				explicitlyRequestedToolNameSet?.has(name) === true &&
				!initialToolNames.includes(name)
			) {
				continue;
			}
			if (!isMCPToolName(name)) requestedToolNameSet.add(name);
			if (!initialToolNames.includes(name)) {
				initialToolNames.push(name);
			}
		}

		// When tools.discoveryMode === "all", hide non-essential built-in discoverable tools
		// from the initial set unless they were explicitly requested or restored from persistence.
		// The model finds them via search_tool_bm25 and activates them on demand.
		if (effectiveDiscoveryMode === "all") {
			// Tools a forced tool_choice will target must stay active, or the named
			// choice references a tool absent from the request (provider 400). Eager
			// todos force a named `todo` choice on the first turn. `task` is also kept
			// active under discovery-all when `task.eager` is enabled, so eager delegation is
			// possible and the Eager Tasks prompt section renders, even though nothing
			// forces a `task` tool_choice.
			const forceActive = new Set<string>();
			if (settings.get("todo.eager") !== "default" && settings.get("todo.enabled") && toolRegistry.has("todo")) {
				forceActive.add("todo");
			}
			if (settings.get("task.eager") !== "default" && toolRegistry.has("task")) {
				forceActive.add("task");
			}
			// irc is loadMode "discoverable" and non-essential, so discovery-all filtering would strip it
			// from the initial actives. But the agent-registry `ircEnabled` flag (~:2931) and the irc
			// sender gate (tools/irc.ts) are snapshotted from initialToolNames — stripping irc registers
			// the subagent as mute and permanently rejects DMs ("agent has no irc tool and cannot reply").
			// filterInitialToolsForDiscoveryAll is preserve-only, so this only KEEPS irc when it was
			// already registered (subagents, taskDepth>0); an agent whose explicit tools list omits irc is
			// unaffected because irc never enters initialToolNames.
			if (toolRegistry.has("irc")) {
				forceActive.add("irc");
			}
			initialToolNames = filterInitialToolsForDiscoveryAll(initialToolNames, {
				loadModeOf: name => (builtInRegistryToolNames.has(name) ? toolRegistry.get(name)?.loadMode : undefined),
				essentialNames: new Set(computeEssentialBuiltinNames(settings)),
				explicitlyRequested: new Set(options.toolNames ? normalizeToolNames(options.toolNames) : []),
				// Back-compat: persisted activations live under selectedMCPToolNames today (built-in
				// activation persistence is a follow-up). MCP names won't collide with built-in names.
				restored: new Set(existingSession.selectedMCPToolNames.map(normalizeRenamedBuiltinToolName)),
				forceActive,
			});
		}

		// The delegation reminder is shipped as a plugin package but loaded natively so bundled
		// omp can nudge the model mid-turn when it does heavy hands-on work without delegating.
		// Main interactive sessions only — subagents are meant to do hands-on work (§6) — gated on
		// the same initial tool-name list that `buildSystemPromptInternal` receives for the
		// Orchestrator Mode section (`{{#if eagerTasks}}{{#has tools "task"}}`).
		const isSubagentSession = taskDepth > 0 || options.parentTaskPrefix !== undefined;
		if (
			!minimalExtensionRuntime &&
			!isSubagentSession &&
			settings.get("delegation.reminder.enabled") &&
			settings.get("task.eager") !== "default" &&
			initialToolNames.includes("task") &&
			!extensionsResult.extensions.some(extension => extension.label === DELEGATION_REMINDER_LABEL)
		) {
			try {
				const loaded = await loadExtensionFromFactory(
					createDelegationReminderExtension({ threshold: settings.get("delegation.reminder.threshold") }),
					cwd,
					eventBus,
					extensionsResult.runtime,
					"<native-delegation-reminder>",
				);
				extensionsResult.extensions.push(loaded);
			} catch (error) {
				reportSoftCrash({
					label: "extension-load",
					error,
					context: { phase: "native-delegation-reminder" },
				});
				throw error;
			}
		}
		// Pre-register in the global agent registry BEFORE building the system prompt,
		// so that subagents launched in the same parallel batch can see each other in
		// their initial `# IRC Peers` block (rendered inside `rebuildSystemPrompt`).
		// The session reference is attached after construction below.
		const registrationInput = {
			id: resolvedAgentId,
			displayName: resolvedAgentDisplayName,
			kind: agentKind,
			parentId: options.parentAgentId,
			session: null,
			sessionFile: sessionManager.getSessionFile() ?? null,
			status: "running" as const,
			ircEnabled: initialToolNames.includes("irc"),
		};
		registeredAgentRef =
			options.expectedAgentRef === undefined
				? agentRegistry.register(registrationInput)
				: agentRegistry.registerIfAvailable(registrationInput, options.expectedAgentRef);
		if (!registeredAgentRef) {
			throw new Error(`Agent "${resolvedAgentId}" is already owned by another session generation.`);
		}
		// A reused parked ref remains parked until the new AgentSession is fully
		// constructed and attached. Startup failure therefore leaves it revivable.
		hasRegistered = options.expectedAgentRef === undefined || options.expectedAgentRef === null;

		// Partition the initial enabled set for the xd:// transport: ambient
		// discoverable tools become mounted devices, while explicitly requested
		// tools keep their top-level presentation. The registry already holds the
		// default-set built-in devices from createTools; this reconciles dynamic
		// mounts (image-gen, TTS, startup MCP, active extension tools).
		let initialMountedXdevToolNames: string[] = [];
		if (toolSession.xdevRegistry) {
			const topLevelToolNames: string[] = [];
			const mountedTools: Tool[] = [];
			for (const name of initialToolNames) {
				const tool = toolRegistry.get(name);
				const explicitlyRequested = explicitlyRequestedToolNameSet?.has(name) === true;
				if (tool && xdevReadAvailable && !explicitlyRequested && isMountableUnderXdev(tool))
					mountedTools.push(tool);
				else topLevelToolNames.push(name);
			}
			const writeTransportAvailable = mountedTools.length === 0 || (await ensureWriteRegistered());
			if (writeTransportAvailable) {
				toolSession.xdevRegistry.reconcile(mountedTools);
				initialMountedXdevToolNames = mountedTools.map(tool => tool.name);
				initialToolNames = topLevelToolNames;
				if (initialMountedXdevToolNames.length > 0 && !initialToolNames.includes("write"))
					initialToolNames.push("write");
			} else {
				toolSession.xdevRegistry.reconcile([]);
			}
		}

		setActiveToolNames(initialToolNames);
		const { systemPrompt } = await logger.time(
			"buildSystemPrompt",
			rebuildSystemPrompt,
			initialToolNames,
			toolRegistry,
		);

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

		// Keep image blocks off the wire when they'd be rejected: either the user
		// disabled images (`images.blockImages`) or the active model has no vision
		// support. The latter covers switching from a vision model to a text-only
		// one mid-session — historical image blocks would otherwise be replayed to
		// a provider that 400s on them (#5400). Read both dynamically so a `/model`
		// switch or setting change takes effect on the next turn.
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			if (settings.get("images.blockImages")) {
				return replaceLlmImagesWithText(converted, "Image reading is disabled.");
			}
			const activeModel = agent?.state.model ?? model;
			if (activeModel && !activeModel.input.includes("image")) {
				return replaceLlmImagesWithText(
					converted,
					"[image omitted: the active model does not support image input]",
				);
			}
			return converted;
		};

		// Final convertToLlm: live provider replay drops API-level refusal errors,
		// then applies secret obfuscation to the remaining outbound context.
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const converted = filterProviderReplayMessages(convertToLlmWithBlockImages(messages));
			if (!obfuscator?.hasSecrets()) return converted;
			return obfuscateMessages(obfuscator, converted);
		};

		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			const withContext = await extensionRunner.emitContext(messages);
			return wrapSteeringForModel(withContext);
		};
		// Per-request provider-context transforms. Obfuscate FIRST so secrets are
		// redacted from text before snapcompact rasterizes it into PNG frames, then
		// clamp images to the active provider budget before the request is sent.
		const snapcompactSystemPromptMode = settings.get("snapcompact.systemPrompt");
		const snapcompactInline =
			snapcompactSystemPromptMode !== "none" || settings.get("snapcompact.toolResults")
				? new SnapcompactInlineTransformer(
						{
							renderSystemPrompt: snapcompactSystemPromptMode,
							renderToolResults: settings.get("snapcompact.toolResults"),
							shape: settings.get("snapcompact.shape"),
						},
						// Journal the tokens each imaged tool result keeps off the wire
						// (frames never reach session.jsonl, so this is their only trace).
						createSnapcompactSavingsRecorder(() => sessionManager.getSessionFile() ?? null),
					)
				: undefined;
		const transformProviderContext = async (context: Context, transformModel: Model): Promise<Context> => {
			let transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
			if (snapcompactInline) transformed = await snapcompactInline.transform(transformed, transformModel);
			if (transformModel.provider === "openai-codex") {
				const maxPayloadBytes = getCodexSnapcompactProviderContextMaxBytes();
				const pruneStart = performance.now();
				const result = stripOversizedCompactionSummaryImagesForCodex(transformed, maxPayloadBytes);
				if (result.changed) {
					logger.debug("Codex provider context pruned oversized snapcompact frames", {
						provider: transformModel.provider,
						model: transformModel.id,
						durationMs: Math.round(performance.now() - pruneStart),
						maxPayloadBytes,
						originalBytes: result.originalBytes,
						strippedBytes: result.strippedBytes,
						strippedFrames: result.strippedFrames,
						retainedFrames: result.retainedFrames,
						strippedImageBytes: result.strippedImageBytes,
						withinBudget: result.strippedBytes <= maxPayloadBytes,
					});
					transformed = result.context;
				}
			}
			return clampProviderContextImages(transformed, transformModel);
		};
		const onPayload = async (payload: unknown, model?: Model) => {
			return await extensionRunner.emitBeforeProviderRequest(payload, model);
		};
		const onResponse: SimpleStreamOptions["onResponse"] = async (response, model) => {
			await extensionRunner.emitAfterProviderResponse(response, model);
		};

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);
		const autoLearnCaptureTools = initialTools.filter(tool => tool.name === "manage_skill" || tool.name === "learn");

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const initialServiceTierByFamily = hasServiceTierEntry
			? (existingSession.serviceTier ?? {})
			: buildServiceTierByFamily(
					settings.get("tier.openai"),
					settings.get("tier.anthropic"),
					settings.get("tier.google"),
				);

		// One-shot launch-latency marker: fired the first time the loop dispatches
		// a chat request to the provider transport. See onFirstChatDispatch.
		let notifyFirstChatDispatch = options.onFirstChatDispatch;
		// Shared, settings-aware stream wrapper used by the main agent, advisor,
		// and side-channel requests (`/btw`, `/omfg`, IRC auto-replies, handoff).
		// Keeps OpenRouter sticky-routing variants, antigravity endpoint routing,
		// in-flight caps, and the loop guard consistent across every provider call
		// the session drives. Wrapped in a per-provider concurrency limiter so
		// each LLM HTTP request — not the whole subagent lifecycle — holds the
		// slot, preventing nested-spawn deadlocks.
		const settingsAwareStreamFn = wrapStreamFnWithProviderConcurrency(
			settings,
			createSettingsAwareStreamFn(settings),
		);
		type CredentialUseLease = {
			released: boolean;
			release: () => void;
		};
		const credentialUseLeases: CredentialUseLease[] = [];
		const createCredentialUseLease = (provider: string): CredentialUseLease => {
			const lease: CredentialUseLease = {
				released: false,
				release: () => {
					if (lease.released) return;
					lease.released = true;
					modelRegistry.authStorage.releaseSessionCredentialUse(provider, agent.sessionId);
				},
			};
			credentialUseLeases.push(lease);
			return lease;
		};
		const createSessionCredentialResolver = (requestModel: Model): ApiKeyResolver => {
			const provider = requestModel.provider;
			const resolver = modelRegistry.resolver(requestModel, agent.sessionId);
			let lease: CredentialUseLease | undefined;
			return async ctx => {
				try {
					const key = await resolver(ctx);
					if (key !== undefined && !lease) lease = createCredentialUseLease(provider);
					return key;
				} catch (error) {
					lease?.release();
					throw error;
				}
			};
		};
		const thinkingDisplay = resolveThinkingDisplay(settings);
		const transformToolCallArguments = (args: Record<string, unknown>): Record<string, unknown> => {
			let result = args;
			const maxTimeout = settings.get("tools.maxTimeout");
			if (maxTimeout > 0 && typeof result.timeout === "number") {
				result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
			}
			if (obfuscator?.hasSecrets()) {
				result = deobfuscateToolArguments(obfuscator, result);
			}
			return result;
		};
		const kimiApiFormatSetting = settings.get("providers.kimiApiFormat");
		const kimiApiFormat = kimiApiFormatSetting === "auto" ? undefined : kimiApiFormatSetting;
		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(effectiveThinkingLevel),
				tools: initialTools,
			},
			cwd,
			// Live cwd: `/move` updates SessionManager (and process cwd) without
			// reconstructing the Agent, so a static cwd would strand GitLab Duo Agent
			// namespace/project discovery on the original repo's git remote. Re-read it
			// per turn from the SessionManager.
			cwdResolver: () => sessionManager.getCwd(),
			convertToLlm: convertToLlmFinal,
			onPayload,
			onResponse,
			sessionId: providerSessionId,
			promptCacheKey: providerPromptCacheKey,
			deadline: options.deadline,
			transformContext,
			transformProviderContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			interruptMode: settings.get("interruptMode") ?? "immediate",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
			topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
			topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
			minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
			presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
			repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
			serviceTier: model ? resolveModelServiceTier(initialServiceTierByFamily, model) : undefined,
			hideThinkingSummary: thinkingDisplay === "omitted",
			thinkingDisplay,
			kimiApiFormat,
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: createSessionCredentialResolver,
			streamFn: (streamModel, context, streamOptions) => {
				if (notifyFirstChatDispatch) {
					const cb = notifyFirstChatDispatch;
					notifyFirstChatDispatch = undefined;
					try {
						cb();
					} catch (err) {
						logger.warn("onFirstChatDispatch hook threw", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				const credentialUseLease = credentialUseLeases.shift();
				let detachAbortRelease: (() => void) | undefined;
				const releaseCredentialUse = (): void => {
					credentialUseLease?.release();
					detachAbortRelease?.();
					detachAbortRelease = undefined;
				};
				const signal = streamOptions?.signal;
				if (signal) {
					if (signal.aborted) {
						releaseCredentialUse();
					} else {
						signal.addEventListener("abort", releaseCredentialUse, { once: true });
						detachAbortRelease = () => signal.removeEventListener("abort", releaseCredentialUse);
					}
				}
				try {
					const response = settingsAwareStreamFn(streamModel, context, streamOptions);
					void Promise.resolve(response)
						.then(stream => stream.result())
						.finally(releaseCredentialUse)
						.catch(() => {});
					return response;
				} catch (error) {
					releaseCredentialUse();
					throw error;
				}
			},
			cursorExecHandlers,
			getCursorTools: () => [...(toolSession.xdevRegistry?.list() ?? [])],
			transformToolCallArguments,
			resolveFallbackTool: resolveDeviceTool,
			intentTracing: !!intentField,
			pruneToolDescriptions: inlineToolDescriptors,
			dialect: resolveDialect(settings.get("tools.format"), model),
			abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
			getToolChoice: () => session?.nextToolChoiceDirective(),
			telemetry: options.telemetry,
			appendOnlyContext: model
				? shouldEnableAppendOnlyContext(settings.get("provider.appendOnlyContext"), model)
					? new AppendOnlyContextManager()
					: undefined
				: undefined,
		});

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
		} else {
			// Save initial model, thinking level, service tier, and root prompt metadata for new sessions
			// so they can be restored or inspected from persisted session logs.
			if (model) {
				sessionManager.appendModelChange(`${model.provider}/${model.id}`);
			}
			if (!autoThinking) {
				// Do not write the `auto` selector before the first turn resolves; auto
				// classification persists its concrete effort once a real user turn runs.
				const persistedThinkingLevel =
					!hasExistingSession && thinkingLevel === Effort.Max && restoredSessionThinkingLevel === undefined
						? Effort.Max
						: effectiveThinkingLevel;
				sessionManager.appendThinkingLevelChange(persistedThinkingLevel);
			}
			if (Object.keys(initialServiceTierByFamily).length > 0) {
				sessionManager.appendServiceTierChange(initialServiceTierByFamily);
			}
			const isSubagent = (options.taskDepth ?? 0) > 0 || options.parentTaskPrefix !== undefined;
			if (!isSubagent && systemPrompt.length > 0) {
				sessionManager.appendSessionInit({
					systemPrompt: systemPrompt.join("\n\n"),
					task: "Root interactive session",
					tools: initialTools.map(tool => tool.name),
				});
			}
		}

		// Full toolset for the advisor, built unconditionally so it can be toggled at
		// runtime. Bound to a DISTINCT ToolSession (its own `-advisor` session id +
		// agent id) so the advisor's tool state — snapshot, seen-lines, conflict, and
		// summary caches, all keyed on session identity — stays isolated from the
		// primary, while edit/bash/write stay fully functional: the advisor is a full
		// agent and its config's `tools` selects which of these it actually gets
		// (defaulting to read/grep/glob).
		const advisorToolSession: ToolSession = {
			...toolSession,
			get cwd() {
				return sessionManager.getCwd();
			},
			hasEditTool: true,
			requireYieldTool: false,
			getSessionId: () => {
				const id = sessionManager.getSessionId?.();
				return id ? `${id}-advisor` : null;
			},
			getAgentId: () => "advisor",
		};
		const advisorToolBuilds: Array<Tool | null | Promise<Tool | null>> = [];
		for (const name in BUILTIN_TOOLS) {
			advisorToolBuilds.push(BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS](advisorToolSession));
		}
		const built = await Promise.all(advisorToolBuilds);
		const advisorTools: Tool[] = built
			.filter((tool): tool is Tool => tool != null)
			.map(wrapToolWithMetaNotice)
			.map(clampAdvisorToolOutput);

		const advisorWatchdogPrompts = [...watchdogFiles];
		if (activeRepoContext) {
			advisorWatchdogPrompts.push(formatActiveRepoWatchdogPrompt(activeRepoContext));
		}
		const advisorWatchdogPrompt = advisorWatchdogPrompts.length > 0 ? advisorWatchdogPrompts.join("\n\n") : undefined;
		// Hand the advisor the same project context files (AGENTS.md, etc.) the
		// primary agent gets in its system prompt, so the read-only reviewer judges
		// against the user's standing project rules instead of advising blind.
		const advisorContextPrompt = formatAdvisorContextPrompt(contextFiles);
		// Owned only when this session created the manager; subagents receive a
		// parent's manager via `options.mcpManager` and MUST NOT disconnect it.
		const ownedMcpManager = options.mcpManager ? undefined : mcpManager;
		session = new AgentSession({
			advisorWatchdogPrompt,
			advisorContextPrompt,
			advisorSharedInstructions: discoveredAdvisors.sharedInstructions,
			advisorConfigs: discoveredAdvisors.advisors,
			agent,
			pruneToolDescriptions: inlineToolDescriptors,
			thinkingLevel: autoThinking ? AUTO_THINKING : effectiveThinkingLevel,
			initialRetryFallback,
			prewalk: options.prewalk,
			planYolo: options.planYolo,
			reasoningSlide: options.reasoningSlide,
			serviceTierByFamily: initialServiceTierByFamily,
			sessionManager,
			settings,
			autoApprove: options.autoApprove,
			evalKernelOwnerId,
			// Defined only for top-level sessions (creation is gated above).
			// AgentSession uses this to decide whether it may dispose the global
			// AsyncJobManager on teardown; subagents inherit the parent's and
			// **MUST NOT** tear it down.
			ownedAsyncJobManager: asyncJobManager,
			asyncJobManager: scopedAsyncJobManager,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			workspaceRoots,
			extensionRunner,
			customCommands: customCommandsResult.commands,
			skills,
			skillWarnings,
			skillsReloadable: options.skills === undefined,
			skillsSettings,
			modelRegistry,
			toolRegistry,
			toolSession,
			memoryAgentDir: agentDir,
			memoryTaskDepth: taskDepth,
			createMemoryTools: restrictToolNames
				? undefined
				: async () => {
						const tools = await Promise.all(
							MEMORY_BACKEND_TOOL_NAMES.map(name => BUILTIN_TOOLS[name](toolSession)),
						);
						return tools.filter((tool): tool is AgentTool => tool !== null);
					},
			createComputerTool: restrictToolNames
				? undefined
				: async () => (await BUILTIN_TOOLS.computer(toolSession)) ?? null,
			createVibeTools:
				(options.taskDepth ?? 0) === 0 && !options.parentTaskPrefix
					? () => createVibeTools(toolSession)
					: undefined,
			builtInToolNames: builtInRegistryToolNames,
			transformContext,
			contextGcDbPath,
			transformProviderContext,
			onPayload,
			onResponse,
			sideStreamFn: settingsAwareStreamFn,
			advisorStreamFn: settingsAwareStreamFn,
			preferWebsockets: preferOpenAICodexWebsockets,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			reloadSshTool,
			requestedToolNames: requestedToolNameSet,
			explicitlyRequestedToolNames: explicitlyRequestedToolNameSet,
			getXdevToolEntries: () => toolSession.xdevRegistry?.entries() ?? [],
			xdevRegistry: toolSession.xdevRegistry,
			initialMountedXdevToolNames,
			presentationPinnedToolNames: explicitlyRequestedToolNameSet,
			setActiveToolNames,
			ensureWriteRegistered,
			getMcpServerInstructions: mcpManager
				? () => {
						const raw = mcpManager.getServerInstructions();
						if (!raw || raw.size === 0) return raw;
						const out = new Map<string, string>();
						for (const [name, text] of raw) {
							out.set(
								name,
								text.length > MAX_MCP_INSTRUCTIONS_LENGTH ? text.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH) : text,
							);
						}
						return out;
					}
				: undefined,
			disconnectOwnedMcpManager: ownedMcpManager ? () => ownedMcpManager.disconnectAll() : undefined,
			mcpDiscoveryEnabled,
			effectiveDiscoveryMode,
			mcpEnabled: enableMCP,
			initialSelectedMCPToolNames:
				deferMCPDiscoveryForUI && !existingSession.hasPersistedMCPToolSelection
					? undefined
					: initialSelectedMCPToolNames,
			defaultSelectedMCPToolNames,
			persistInitialMCPToolSelection: !hasExistingSession,
			defaultSelectedMCPServerNames: [...discoveryDefaultServers],
			ttsrManager,
			obfuscator,
			agentId: resolvedAgentId,
			agentKind,
			providerSessionId: options.providerSessionId,
			providerPromptCacheKeySource,
			parentEvalSessionId: options.parentEvalSessionId,
			advisorTools,
			titleSystemPrompt: options.titleSystemPrompt,
		});
		hasSession = true;
		const sessionAsyncJobManager = asyncJobManager;
		if (sessionAsyncJobManager) {
			session.yieldQueue.register<AsyncResultEntry>("async-result", {
				isStale: entry => sessionAsyncJobManager.isDeliverySuppressed(entry.jobId),
				build: buildAsyncResultBatchMessage,
			});
		}
		session.yieldQueue.register<McpNotificationEntry>("mcp-notification", {
			build: buildMcpNotificationBatchMessage,
		});
		session.yieldQueue.register<DeferredDiagnosticsEntry>(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, {
			isStale: entry => entry.isStale(),
			build: buildLateDiagnosticsBatchMessage,
		});
		session.yieldQueue.register<BrowserAnnotationEntry>(BROWSER_ANNOTATION_MESSAGE_TYPE, {
			build: buildBrowserAnnotationBatchMessage,
		});
		// Product-preview side-ask/comment/answer delivery — steering, not followUp.
		session.yieldQueue.register<PreviewFeedback>(PREVIEW_FEEDBACK_MESSAGE_TYPE, {
			build: buildPreviewFeedbackBatchMessage,
		});

		// Attach the live session to the pre-registered ref so peers can route IRC
		// messages here. Refresh sessionFile in case it was unavailable at pre-register
		// time. The dispose wrapper below unregisters on teardown (unless parked).
		if (
			!registeredAgentRef ||
			!agentRegistry.attachSession(
				resolvedAgentId,
				session,
				sessionManager.getSessionFile() ?? null,
				registeredAgentRef,
			) ||
			!agentRegistry.setStatus(resolvedAgentId, "running", registeredAgentRef)
		) {
			throw new Error(`Agent "${resolvedAgentId}" was replaced during session initialization.`);
		}
		hasRegistered = true;
		{
			const originalDispose = session.dispose.bind(session);
			session.dispose = async () => {
				try {
					// Reject new session work (eval starts) the moment disposal
					// begins — the lifecycle await below opens an async gap before
					// AgentSession.dispose() would otherwise set its guards.
					session.beginDispose();
					if (agentKind === "main") {
						// Top-level teardown owns the global agent lifecycle: park timers,
						// adopted subagent sessions, revivers. Tear it down while shared
						// resources (kernels, MCP, LSP) are still live. Subagent disposal
						// must NOT touch the global lifecycle.
						const vibeRegistry = VibeSessionRegistry.global();
						const vibeParentSession = {
							getAgentId: () => resolvedAgentId,
							getSessionId: () => sessionManager.getSessionId(),
							getSessionFile: () => sessionManager.getSessionFile() ?? null,
							sessionManager,
							asyncJobManager: scopedAsyncJobManager,
							settings,
							getActiveModelString,
						};
						await vibeRegistry.suspendScope(vibeRegistry.ownerScope(vibeParentSession), scopedAsyncJobManager);
						await AgentLifecycleManager.global().dispose();
					}
					await originalDispose();
				} finally {
					unregisterUnlessParked();
					unsubscribeCredentialDisabled?.();
				}
			};
		}

		if (model?.api === "openai-codex-responses") {
			// `.api` equality doesn't narrow the generic; the guard makes this cast sound.
			const codexModel = model as Model<"openai-codex-responses">;
			const codexTransport = getOpenAICodexTransportDetails(codexModel, {
				sessionId: providerSessionId,
				baseUrl: codexModel.baseUrl,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
			if (codexTransport.websocketPreferred) {
				void (async () => {
					try {
						const codexPrewarmApiKey = await modelRegistry.getApiKey(codexModel, providerSessionId);
						if (!codexPrewarmApiKey) return;
						await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, codexModel, {
							apiKey: codexPrewarmApiKey,
							sessionId: providerSessionId,
							preferWebsockets: preferOpenAICodexWebsockets,
							providerSessionState: session.providerSessionState,
							context: {
								systemPrompt,
								messages: [],
								tools: initialTools,
							},
							reasoning: toReasoningEffort(effectiveThinkingLevel),
							serviceTier: resolveModelServiceTier(initialServiceTierByFamily, codexModel),
							temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
							topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
							topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
							minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
							presencePenalty:
								settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
							repetitionPenalty:
								settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.debug("Codex websocket prewarm failed", {
							error: errorMessage,
							provider: codexModel.provider,
							model: codexModel.id,
						});
					}
				})();
			}
		}

		// Start LSP warmup in the background so startup does not block on language server initialization.
		// With `lsp.lazy` (the default) the warmup is skipped: recognized servers are still discovered and
		// surfaced in the UI as "available", but cold-start on first use — the lsp tool or an edit/write
		// touching a matching file type — through `getOrCreateClient`.
		// Print/script invocations (`hasUI=false`) skip it regardless: they don't render the warmup status
		// indicator AND typically finish before LSP servers would have stabilized — warming them just spends
		// CPU parsing big `initialize` responses concurrently with the LLM stream consumer, jittering
		// perceived latency.
		let lspServers: CreateAgentSessionResult["lspServers"];
		if (enableLsp && options.hasUI && settings.get("lsp.lazy")) {
			lspServers = discoverStartupLspServers(cwd, "available");
		} else if (enableLsp && options.hasUI) {
			lspServers = discoverStartupLspServers(cwd);
			if (lspServers.length > 0) {
				void (async () => {
					try {
						const result = await logger.time("warmupLspServers", warmupLspServers, cwd);
						const serversByName = new Map(result.servers.map(server => [server.name, server] as const));
						for (const server of lspServers ?? []) {
							const next = serversByName.get(server.name);
							if (!next) continue;
							server.status = next.status;
							server.fileTypes = next.fileTypes;
							server.error = next.error;
						}
						const event: LspStartupEvent = {
							type: "completed",
							servers: result.servers,
						};
						if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.warn("LSP server warmup failed", { cwd, error: errorMessage });
						for (const server of lspServers ?? []) {
							server.status = "error";
							server.error = errorMessage;
						}
						const event: LspStartupEvent = {
							type: "failed",
							error: errorMessage,
						};
						if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					}
				})();
			}
		}

		logger.time("startLearningStartupTask", () =>
			Promise.resolve(
				startLearningStartupTask({
					session,
					settings,
					modelRegistry,
					agentDir,
					taskDepth,
				}),
			),
		);
		const startMemoryBackend = async () => {
			const memoryBackend = await resolveMemoryBackend(settings);
			await memoryBackend.start({
				session,
				settings,
				modelRegistry,
				agentDir,
				taskDepth,
				parentHindsightSessionState: options.parentHindsightSessionState,
				parentMnemopiSessionState: options.parentMnemopiSessionState,
			});
		};

		const runAutoLearnCapture = createAutoLearnCaptureRunner({
			sourceAgent: agent,
			captureTools: autoLearnCaptureTools,
			onPayload,
			onResponse,
			createAgent: captureOptions => {
				const captureModel = captureOptions.initialState?.model;
				const captureSessionId = captureOptions.sessionId;
				if (!captureModel || !captureSessionId) throw new Error("Auto-learn capture identity is incomplete");
				return new Agent({
					...captureOptions,
					cwd: sessionManager.getCwd(),
					cwdResolver: () => sessionManager.getCwd(),
					convertToLlm: convertToLlmFinal,
					transformContext: async messages => wrapSteeringForModel(messages),
					transformProviderContext: async (context, transformModel) => {
						const transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
						return clampProviderContextImages(transformed, transformModel);
					},
					thinkingBudgets: agent.thinkingBudgets,
					temperature: agent.temperature,
					topP: agent.topP,
					topK: agent.topK,
					minP: agent.minP,
					presencePenalty: agent.presencePenalty,
					repetitionPenalty: agent.repetitionPenalty,
					serviceTierResolver: agent.serviceTierResolver,
					hideThinkingSummary: agent.hideThinkingSummary,
					maxRetryDelayMs: agent.maxRetryDelayMs,
					kimiApiFormat,
					preferWebsockets: preferOpenAICodexWebsockets,
					getToolContext: toolCall => toolContextStore.getContext(toolCall),
					streamFn: settingsAwareStreamFn,
					transformToolCallArguments,
					resolveFallbackTool: resolveDeviceTool,
					intentTracing: !!intentField,
					pruneToolDescriptions: inlineToolDescriptors,
					dialect: resolveDialect(settings.get("tools.format"), captureModel),
					abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
					appendOnlyContext: shouldEnableAppendOnlyContext(
						settings.get("provider.appendOnlyContext"),
						captureModel,
					)
						? new AppendOnlyContextManager()
						: undefined,
				});
			},
		});

		// Auto-learn can immediately trigger a private capture after the first real
		// stop. When a memory backend is selected, install that backend's
		// per-session state first so the capture turn's `learn` tool observes the
		// same initialized state as normal memory tools. Other sessions keep memory
		// startup in the background to preserve the existing startup profile.
		//
		// Gated on `autolearn.enabled` to match the tools: `createTools` builds the
		// `learn`/`manage_skill` registry ONCE at session start and no settings
		// change rebuilds it, so installing the controller while disabled would let a
		// mid-session enable fire a nudge pointing at tools the session never built.
		// Activation is therefore a session-start decision for BOTH the controller
		// and the tools; the fire-time re-check in `#onAgentEnd` still handles a
		// mid-session DISABLE. The subscription lives for the session's lifetime; the
		// reference is intentionally discarded (the listener retains it).
		if (!restrictToolNames) {
			if (settings.get("autolearn.enabled") && taskDepth === 0) {
				await logger.time("startMemoryStartupTask", startMemoryBackend);
				new AutoLearnController({
					session,
					settings,
					capture: content => session.runAutolearnCapture(signal => runAutoLearnCapture(content, signal)),
				});
			} else {
				void logger.time("startMemoryStartupTask", startMemoryBackend);
			}
		}

		// Wire MCP manager callbacks to session for reactive tool updates.
		// Skip when reusing a parent's manager — the parent owns the callbacks.
		if (mcpManager && !options.mcpManager) {
			mcpManager.setOnToolsChanged(tools => {
				void (async () => {
					try {
						let activateAll =
							deferMCPDiscoveryForUI && !mcpDiscoveryEnabled && explicitlyRequestedMCPToolNames.length === 0;
						if (activateAll && (await enableDeferredMCPDiscoveryForTools(session, tools))) {
							activateAll = false;
						}
						await session.refreshMCPTools(tools, activateAll ? { activateAll: true } : undefined);
						if (mcpDiscoveryEnabled) {
							await session.enableMCPDiscoveryWithSearchTool(effectiveDiscoveryMode);
						}
					} catch (error) {
						logger.warn("MCP tool refresh failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				})();
			});
			// Wire prompt refresh → rebuild MCP prompt slash commands
			mcpManager.setOnPromptsChanged(serverName => {
				const promptCommands = buildMCPPromptCommands(mcpManager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
			});
			const notificationDebounceTimers = new Map<string, Timer>();
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			mcpManager.setOnResourcesChanged((serverName, uri) => {
				logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
				if (!settings.get("mcp.notifications")) return;
				const debounceMs = settings.get("mcp.notificationDebounceMs");
				const key = `${serverName}:${uri}`;
				const existing = notificationDebounceTimers.get(key);
				if (existing) clearTimeout(existing);
				notificationDebounceTimers.set(
					key,
					setTimeout(() => {
						notificationDebounceTimers.delete(key);
						// Re-check: user may have disabled notifications during the debounce window
						if (!settings.get("mcp.notifications")) return;
						session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
					}, debounceMs),
				);
			});
		}

		startDeferredMCPDiscovery?.(session, {
			mcpDiscoveryEnabled,
			explicitlyRequestedMCPToolNames,
			activateAllMCPTools: !mcpDiscoveryEnabled && explicitlyRequestedMCPToolNames.length === 0,
		});

		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager,
			modelFallbackMessage,
			lspServers,
			eventBus,
		};
	} catch (error) {
		// Release the subscription if the throw happened after install but before the
		// dispose-wrap took ownership. Idempotent with dispose() — Set.delete is a no-op
		// for already-removed listeners.
		unsubscribeCredentialDisabled?.();
		try {
			if (hasSession) {
				await session.dispose();
				if (hasRegistered) unregisterUnlessParked();
			} else {
				if (hasRegistered) unregisterUnlessParked();
				if (asyncJobManager) {
					if (AsyncJobManager.instance() === asyncJobManager) {
						AsyncJobManager.setInstance(undefined);
					}
					await asyncJobManager.dispose({ timeoutMs: 3_000 });
				}
				await releaseComputerSessionsForOwner(evalKernelOwnerId);
				await disposeKernelSessionsByOwner(evalKernelOwnerId);
				await disposeRubyKernelSessionsByOwner(evalKernelOwnerId);
				await disposeJuliaKernelSessionsByOwner(evalKernelOwnerId);
				if (ownsAuthStorage) authStorage.close();
			}
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
}

/**
 * Best-effort preconnect to the model's API host. Bun's `fetch.preconnect`
 * primes DNS + TCP + TLS + H2 so the first real request reuses the warm
 * connection. Errors are swallowed: preconnect is an optimization, never a
 * hard dependency.
 */
function preconnectModelHost(baseUrl: string | undefined): void {
	if (!baseUrl) return;
	const preconnect = (globalThis.fetch as typeof fetch & { preconnect?: (url: string) => void }).preconnect;
	if (typeof preconnect !== "function") return;
	try {
		preconnect(baseUrl);
	} catch {
		// Best effort.
	}
}
