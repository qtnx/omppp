import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt, stringProperty, untilAborted } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../capability";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import type { Settings, SkillsSettings } from "../config/settings";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type { ExtensionRunner, SourceInfo, ToolInfo } from "../extensibility/extensions";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import { loadSkills, type Skill, type SkillWarning, setActiveSkills } from "../extensibility/skills";
import { type LocalProtocolOptions, XD_URL_PREFIX } from "../internal-urls";
import { KanbanTool } from "../kanban/tool";
import { deduplicateMCPToolsByName } from "../mcp/tool-bridge";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import { MEMORY_BACKEND_TOOL_NAMES } from "../memory-backend/tool-names";
import type { MemoryBackendStartOptions } from "../memory-backend/types";
import advisorSkillOversightPrompt from "../prompts/system/advisor-skill-oversight.md" with { type: "text" };
import orchestratorModeActivePrompt from "../prompts/system/orchestrator-mode-active.md" with { type: "text" };
import orchestratorModeOverlayTemplate from "../prompts/system/orchestrator-mode-overlay.md" with { type: "text" };
import xdevMountNoticePrompt from "../prompts/system/xdev-mount-notice.md" with { type: "text" };
import { usesCodexTaskPrompt } from "../task/prompt-policy";
import { countToolsForAutoDiscovery, type EffectiveToolDiscoveryMode } from "../tool-discovery/mode";
import {
	buildDiscoverableToolSearchIndex,
	collectDiscoverableTools,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	resolveEffectiveToolDiscoveryMode,
} from "../tool-discovery/tool-index";
import type { Tool, ToolSession } from "../tools";
import { isMCPToolName, normalizeToolNames } from "../tools/builtin-names";
import { computerExposureMode } from "../tools/computer/exposure";
import { ConsultTool } from "../tools/consult";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { supportsExternalThinking } from "../tools/think";
import { ToolAbortError, ToolError } from "../tools/tool-errors";
import {
	isMountableUnderXdev,
	listXdevTools,
	type XdevState,
	xdevDocsAll,
	xdevDocsFor,
	xdevEntries,
} from "../tools/xdev";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { type InspectImageMode, isInspectImageToolActive } from "../utils/inspect-image-mode";
import { formatLocalCalendarDate } from "../utils/local-date";
import {
	extractPermissionLocations,
	getPermissionIntent,
	PERMISSION_OPTIONS,
	PERMISSION_OPTIONS_BY_ID,
	PERMISSION_REQUIRED_TOOLS,
} from "./acp-permission-gate";
import type { ClientBridge, ClientBridgePermissionOutcome } from "./client-bridge";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Supplemental runtime context consumed by SDK system-prompt rebuilders. */
export interface SystemPromptRebuildContext {
	xdevTools: Array<{ name: string; summary: string }>;
	xdevDocs: string;
	xdevRouteSources: readonly MountedMCPToolRouteSource[];
}

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionToolsHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	extensionRunner(): ExtensionRunner | undefined;
	clientBridge(): ClientBridge | undefined;
	agentKind(): "main" | "sub";
	isDisposed(): boolean;
	isStreaming(): boolean;
	queuedMessageCount(): number;
	orchestratorModeEnabled(): boolean;
	planModeEnabled(): boolean;
	model(): Model | undefined;
	memoryBackendSession(): MemoryBackendStartOptions["session"];
	clearInheritedProviderPromptCacheKey(): void;
	clearMemoryPromotionSnapshot(): void;
	captureMemoryPromotionSnapshot(prompt: string[]): void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	notifyCommandMetadataChanged(): void;
	localProtocolOptions(): LocalProtocolOptions;
	/** Session-scoped `/vision` override; undefined means "follow the persisted setting". */
	getInspectImageModeOverride(): InspectImageMode | undefined;
	setInspectImageModeOverride(mode: InspectImageMode | undefined): void;
}

interface SessionToolsOptions {
	autoApprove?: boolean;
	toolRegistry?: Map<string, AgentTool>;
	toolSession?: ToolSession;
	createVibeTools?: () => AgentTool[];
	createComputerTool?: () => Promise<AgentTool | null>;
	/** Creates the private `think` scratchpad tool for runtime setting changes. */
	createThinkTool?: () => Promise<AgentTool | null>;
	/** Creates the built-in `inspect_image` tool for session-scoped runtime enablement (see {@link SessionTools.setInspectImageMode}). */
	createInspectImageTool?: () => Promise<AgentTool | null>;
	builtInToolNames?: Iterable<string>;
	presentationPinnedToolNames?: ReadonlySet<string>;
	/** MCP tool names whose current registry entries came from the manager snapshot. */
	mcpManagerToolNames?: Iterable<string>;
	ensureWriteRegistered?: () => Promise<boolean>;
	rebuildSystemPrompt?: (
		toolNames: string[],
		tools: Map<string, AgentTool>,
		context?: SystemPromptRebuildContext,
	) => Promise<{ systemPrompt: string[]; xdevCatalogNames?: readonly string[] }>;
	systemPromptOverlay?: (baseSystemPrompt: string[]) => string[];
	getPinnedRuntimeToolNames?: () => string[];
	getLocalCalendarDate?: () => string;
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	xdev?: XdevState;
	setActiveToolNames?: (names: Iterable<string>) => void;
	baseSystemPrompt: string[];
	skills?: Skill[];
	skillWarnings?: SkillWarning[];
	skillsSettings?: SkillsSettings;
	skillsReloadable?: boolean;
	reloadSshTool?: () => Promise<AgentTool | null>;
	requestedToolNames?: ReadonlySet<string>;
	/** Tool names explicitly supplied by the caller; only these restrict later discovery. */
	explicitlyRequestedToolNames?: ReadonlySet<string>;
	/** Resolved discovery mode after applying the auto policy. */
	effectiveDiscoveryMode?: EffectiveToolDiscoveryMode;
	mcpDiscoveryEnabled?: boolean;
	mcpEnabled?: boolean;
	defaultSelectedMCPServerNames?: string[];
	initialSelectedMCPToolNames?: string[];
	defaultSelectedMCPToolNames?: string[];
}

const SKILLS_AND_RULES_HEADING = "# Skills & Rules";
const INTERNAL_URLS_HEADING = "# Internal URLs";

function extractSkillsAndRulesSection(systemPromptBlock: string): string | undefined {
	const start = systemPromptBlock.indexOf(SKILLS_AND_RULES_HEADING);
	if (start < 0) return undefined;
	const nextSection = systemPromptBlock.indexOf(`\n${INTERNAL_URLS_HEADING}`, start);
	const end = nextSection < 0 ? systemPromptBlock.length : nextSection;
	const section = systemPromptBlock.slice(start, end).trim();
	return section.length > 0 ? section : undefined;
}

export function buildSystemPromptWithOrchestratorOverlay(baseSystemPrompt: string[]): string[] {
	const skillsAndRules = extractSkillsAndRulesSection(baseSystemPrompt[0] ?? "");
	if (!skillsAndRules) return [orchestratorModeActivePrompt, ...baseSystemPrompt.slice(1)];
	const orchestratorPrompt = prompt.render(orchestratorModeOverlayTemplate, {
		orchestratorMode: orchestratorModeActivePrompt,
		skillsAndRules,
	});
	return [orchestratorPrompt, ...baseSystemPrompt.slice(1)];
}

export function buildAdvisorSkillsAndRulesPrompt(baseSystemPrompt: string[]): string | undefined {
	const skillsAndRules = extractSkillsAndRulesSection(baseSystemPrompt[0] ?? "");
	if (!skillsAndRules) return undefined;
	return [skillsAndRules, advisorSkillOversightPrompt.trim()].join("\n\n");
}

export interface MountedMCPToolRouteSource {
	readonly name: string;
	readonly mcpServerName?: unknown;
	readonly mcpToolName?: unknown;
}

export interface MountedMCPToolRoute {
	readonly mcpServerName: string;
	readonly mcpToolName: string;
	readonly name: string;
}

export interface MCPXdevGuidanceMapping extends MountedMCPToolRoute {
	readonly label: string;
	readonly path: string;
}

export interface MCPXdevGuidanceProjection {
	readonly mappings: readonly MCPXdevGuidanceMapping[];
	readonly hasOmittedMappings: boolean;
}

const MAX_MCP_XDEV_GUIDANCE_MAPPING_DATA_LENGTH = 4000;
const MAX_MCP_XDEV_GUIDANCE_MAPPINGS = 64;

/** Yield exact mounted MCP ownership and route metadata. */
export function* collectMountedMCPToolRoutes(
	tools: Iterable<MountedMCPToolRouteSource>,
): Generator<MountedMCPToolRoute> {
	for (const tool of tools) {
		if (typeof tool.mcpServerName !== "string" || typeof tool.mcpToolName !== "string") continue;
		yield {
			mcpServerName: tool.mcpServerName,
			mcpToolName: tool.mcpToolName,
			name: tool.name,
		};
	}
}

function formatMCPXdevGuidanceLabel(label: string): string {
	return (JSON.stringify(label) ?? '""')
		.replaceAll("`", "\\u0060")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

/**
 * Project exact live MCP routes into the bounded, Markdown-safe mapping data
 * rendered by the static MCP guidance prompt.
 */
export function projectMountedMCPXdevGuidance(routes: Iterable<MountedMCPToolRoute>): MCPXdevGuidanceProjection {
	const mappings: MCPXdevGuidanceMapping[] = [];
	let remainingMappingDataLength = MAX_MCP_XDEV_GUIDANCE_MAPPING_DATA_LENGTH;
	let hasOmittedMappings = false;
	for (const route of routes) {
		const rawMappingDataLength = route.mcpToolName.length + XD_URL_PREFIX.length + route.name.length;
		if (mappings.length >= MAX_MCP_XDEV_GUIDANCE_MAPPINGS || rawMappingDataLength > remainingMappingDataLength) {
			hasOmittedMappings = true;
			continue;
		}
		const label = formatMCPXdevGuidanceLabel(route.mcpToolName);
		const path = `${XD_URL_PREFIX}${route.name}`;
		const mappingDataLength = label.length + path.length;
		if (mappingDataLength > remainingMappingDataLength) {
			hasOmittedMappings = true;
			continue;
		}
		mappings.push({ ...route, label, path });
		remainingMappingDataLength -= mappingDataLength;
	}
	return { mappings, hasOmittedMappings };
}

const XDEV_MOUNT_NOTICE_MESSAGE_TYPE = "xdev-mount-notice";

/**
 * Structured payload persisted on each {@link XDEV_MOUNT_NOTICE_MESSAGE_TYPE}
 * custom message. Lets a resumed session reconstruct which dynamic devices the
 * model has already been told about, so reconnecting hosts do not re-announce
 * (and re-splice a redundant developer message that busts the provider
 * prompt-cache prefix).
 */
interface XdevMountNoticeDetails {
	added: string[];
	removed: string[];
}

/** Owns tool registration, presentation, prompt rebuilding, skills, and permissions. */
export class SessionTools {
	readonly #host: SessionToolsHost;
	#autoApprove: boolean;
	#toolRegistry: Map<string, AgentTool>;
	#createVibeTools: (() => AgentTool[]) | undefined;
	#toolSession: ToolSession | undefined;
	#createComputerTool: SessionToolsOptions["createComputerTool"];
	#createThinkTool: SessionToolsOptions["createThinkTool"];
	#createInspectImageTool: SessionToolsOptions["createInspectImageTool"];
	#installedVibeToolNames = new Set<string>();
	#builtInToolNames: Set<string>;
	#rpcHostToolNames = new Set<string>();
	#mcpManagerToolNames = new Set<string>();
	#extensionMcpTools = new Map<string, AgentTool>();
	#xdev: XdevState | undefined;
	#pendingXdevMountDelta: { added: Set<string>; removed: Set<string> } | undefined;
	/**
	 * Dynamic (`xd://`) devices the model has already been told are mounted.
	 * Seeded lazily from persisted history on resume (see
	 * {@link #ensureAnnouncedMountsSeeded}) and updated as notices are emitted, so
	 * a host reconnect that re-mounts the same device does not re-announce it.
	 */
	#announcedMounts = new Set<string>();
	#announcedMountsSeeded = false;
	#presentationPinnedToolNames: ReadonlySet<string> | undefined;
	#runtimeSelectedToolNames: ReadonlySet<string> | undefined;
	#baseSystemPrompt: string[];
	/**
	 * Per-turn system prompt returned by a `before_agent_start` extension hook
	 * ("replace the system prompt for this turn"). While set, base-prompt
	 * rebuilds keep this override on the agent instead of the rebuilt base, so a
	 * rebuild landing in the prompt window (compaction/promotion, memory
	 * promotion, MCP/RPC tool refresh, hindsight MM-TTL refresh) cannot silently
	 * drop it before the request. Cleared when the turn ends.
	 */
	#turnSystemPromptOverride: string[] | undefined;
	#lastAppliedToolSignature: string | undefined;
	/**
	 * `xd://` device names the current base system prompt renders in its catalog
	 * (the last rebuild's {@link BuildSystemPromptResult.xdevCatalogNames}). Consulted
	 * when a pending mount notice is delivered: a device the outgoing prompt already
	 * lists is recorded as announced without a redundant notice line. Empty when the
	 * prompt carries no catalog (no mounts, or a custom prompt that omits the section).
	 */
	#basePromptXdevNames: ReadonlySet<string> = new Set();
	#toolRegistryMutationScope = new AsyncLocalStorage<boolean>();
	#toolRegistryMutationTail: Promise<void> = Promise.resolve();
	#promptModelKey: string | undefined;
	#rebuildSystemPrompt: SessionToolsOptions["rebuildSystemPrompt"];
	#systemPromptOverlay: SessionToolsOptions["systemPromptOverlay"];
	#getPinnedRuntimeToolNames: SessionToolsOptions["getPinnedRuntimeToolNames"];
	#getLocalCalendarDate: () => string;
	#getMcpServerInstructions: SessionToolsOptions["getMcpServerInstructions"];
	#setActiveToolNames: SessionToolsOptions["setActiveToolNames"];
	#ensureWriteRegistered: SessionToolsOptions["ensureWriteRegistered"];
	#skills: Skill[];
	#skillWarnings: SkillWarning[];
	#skillsSettings: SkillsSettings | undefined;
	#skillsReloadable: boolean;
	#acpPermissionDecisions = new Map<string, "allow_always" | "reject_always">();
	#reloadSshTool: SessionToolsOptions["reloadSshTool"];
	#explicitlyRequestedToolNames: ReadonlySet<string> | undefined;
	#hasExplicitlyRequestedMCPTools: boolean;
	#effectiveDiscoveryMode: EffectiveToolDiscoveryMode;
	#mcpDiscoveryEnabled: boolean;
	#mcpEnabled: boolean;
	#selectedMCPToolNames: Set<string>;
	#defaultSelectedMCPToolNames: Set<string>;
	#defaultSelectedMCPServerNames: Set<string>;
	#hasExplicitMCPToolSelection: boolean;
	#mcpToolMutationTail: Promise<void> = Promise.resolve();
	#mcpDiscoveryEnabling = false;
	#sessionDefaultSelectedMCPToolNames = new Map<string, string[]>();
	#selectedDiscoveredToolNames = new Set<string>();
	#discoverableToolSearchIndex: DiscoverableToolSearchIndex | undefined;

	constructor(host: SessionToolsHost, options: SessionToolsOptions) {
		this.#host = host;
		this.#autoApprove = options.autoApprove === true;
		this.#toolRegistry = options.toolRegistry ?? new Map();
		this.#toolSession = options.toolSession;
		this.#createVibeTools = options.createVibeTools;
		this.#createComputerTool = options.createComputerTool;
		this.#createThinkTool = options.createThinkTool;
		this.#createInspectImageTool = options.createInspectImageTool;
		this.#builtInToolNames = new Set(options.builtInToolNames ?? []);
		this.#mcpManagerToolNames = new Set(options.mcpManagerToolNames ?? []);
		if (options.mcpManagerToolNames === undefined) {
			for (const name of this.#toolRegistry.keys()) {
				if (isMCPToolName(name)) this.#mcpManagerToolNames.add(name);
			}
		}
		for (const [name, tool] of this.#toolRegistry) {
			if (isMCPToolName(name) && !this.#mcpManagerToolNames.has(name)) {
				this.#extensionMcpTools.set(name, tool);
			}
		}
		this.#presentationPinnedToolNames = options.presentationPinnedToolNames;
		this.#ensureWriteRegistered = options.ensureWriteRegistered;
		this.#rebuildSystemPrompt = options.rebuildSystemPrompt;
		this.#systemPromptOverlay = options.systemPromptOverlay;
		this.#getPinnedRuntimeToolNames = options.getPinnedRuntimeToolNames;
		this.#getLocalCalendarDate = options.getLocalCalendarDate ?? formatLocalCalendarDate;
		this.#getMcpServerInstructions = options.getMcpServerInstructions;
		this.#xdev = options.xdev;
		if (this.#xdev && this.#xdev.tools !== this.#toolRegistry) {
			throw new Error("xd:// state must reference the canonical session tool map");
		}
		if (this.#xdev) this.#xdev.decorateExecution = tool => this.#wrapToolForAcpPermission(tool);
		this.#setActiveToolNames = options.setActiveToolNames;
		this.#baseSystemPrompt = options.baseSystemPrompt;
		this.#skills = options.skills ?? [];
		this.#skillWarnings = options.skillWarnings ?? [];
		this.#skillsSettings = options.skillsSettings;
		this.#skillsReloadable = options.skillsReloadable ?? true;
		this.#reloadSshTool = options.reloadSshTool;
		this.#explicitlyRequestedToolNames = options.explicitlyRequestedToolNames;
		this.#hasExplicitlyRequestedMCPTools =
			options.explicitlyRequestedToolNames !== undefined &&
			Array.from(options.explicitlyRequestedToolNames).some(isMCPToolName);
		this.#effectiveDiscoveryMode =
			options.effectiveDiscoveryMode ??
			resolveEffectiveToolDiscoveryMode(
				host.settings,
				{ contextWindow: host.model()?.contextWindow ?? undefined },
				countToolsForAutoDiscovery([...this.#toolRegistry.keys()].filter(isMCPToolName)),
			);
		this.#mcpDiscoveryEnabled = options.mcpDiscoveryEnabled === true;
		this.#mcpEnabled = options.mcpEnabled === true;
		this.#defaultSelectedMCPToolNames = new Set(options.defaultSelectedMCPToolNames ?? []);
		this.#defaultSelectedMCPServerNames = new Set(options.defaultSelectedMCPServerNames ?? []);
		const hasInitialMCPToolCatalog = Array.from(this.#toolRegistry.keys()).some(isMCPToolName);
		this.#selectedMCPToolNames = new Set(
			(options.initialSelectedMCPToolNames ?? options.defaultSelectedMCPToolNames ?? []).filter(
				name => isMCPToolName(name) && (!hasInitialMCPToolCatalog || this.#toolRegistry.has(name)),
			),
		);
		this.#hasExplicitMCPToolSelection = options.initialSelectedMCPToolNames !== undefined;
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.#host.sessionManager.getSessionFile(),
			this.#defaultMCPToolNames(this.#toolRegistry.values()),
		);
		this.#promptModelKey = this.#currentPromptModelKey();
	}

	#isRequestedToolAllowed(name: string): boolean {
		if (this.#explicitlyRequestedToolNames === undefined) return true;
		if (isMCPToolName(name) && !this.#hasExplicitlyRequestedMCPTools) return true;
		return this.#explicitlyRequestedToolNames.has(name);
	}

	/** Mutable registry shared with controller hosts that inspect available tools. */
	get registry(): Map<string, AgentTool> {
		return this.#toolRegistry;
	}

	/** Current stable base system prompt. */
	get baseSystemPrompt(): string[] {
		return this.#baseSystemPrompt;
	}

	/** Replaces the stable base prompt and applies the current runtime overlay. */
	setBaseSystemPrompt(prompt: string[]): void {
		this.#baseSystemPrompt = prompt;
		this.#applyAgentSystemPrompt(prompt);
	}

	/** Replaces the runtime overlay and reapplies the stable base prompt. */
	setSystemPromptOverlay(overlay: SessionToolsOptions["systemPromptOverlay"]): void {
		this.#systemPromptOverlay = overlay;
		this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
	}

	/**
	 * Pushes `base` to the agent as the effective system prompt, unless an active
	 * per-turn {@link #turnSystemPromptOverride} takes precedence. Every base
	 * rebuild applies its result through here so a mid-turn rebuild preserves the
	 * override.
	 */
	#applyAgentSystemPrompt(base: string[]): void {
		this.#host.agent.setSystemPrompt(this.#turnSystemPromptOverride ?? this.#applySystemPromptOverlay(base));
	}

	/**
	 * Registers the per-turn `before_agent_start` system-prompt override and
	 * applies it to the agent. Base rebuilds during the turn preserve it until
	 * {@link clearTurnSystemPromptOverride}.
	 */
	setTurnSystemPromptOverride(prompt: string[]): void {
		this.#turnSystemPromptOverride = prompt;
		this.#host.agent.setSystemPrompt(prompt);
	}

	/** Drops the active per-turn override; later rebuilds fall back to the base prompt. */
	clearTurnSystemPromptOverride(): void {
		this.#turnSystemPromptOverride = undefined;
	}

	/** Re-runs the overlay after its inputs changed, without touching the base. */
	reapplySystemPromptOverlay(): void {
		this.#host.agent.setSystemPrompt(this.#applySystemPromptOverlay(this.#baseSystemPrompt));
	}

	/** Skills currently rendered into the system prompt. */
	get skills(): Skill[] {
		return this.#skills;
	}

	/** Diagnostics produced while loading the current skills. */
	get skillWarnings(): SkillWarning[] {
		return this.#skillWarnings;
	}

	/** Settings snapshot used for the current skill discovery. */
	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	/** Drops cached per-session ACP `allow_always`/`reject_always` decisions. */
	clearAcpPermissionDecisions(): void {
		this.#acpPermissionDecisions.clear();
	}

	/** Drops cached ACP decisions and re-wraps active tools after the client changes. */
	refreshAcpPermissionGates(): void {
		this.#acpPermissionDecisions.clear();
		const activeTools = this.getActiveToolNames()
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			.map(tool => this.#wrapToolForAcpPermission(tool));
		this.#host.agent.setTools(activeTools);
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getEnabledToolNames().filter(name => !isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/** Names of tools currently exposed at the top level. */
	getActiveToolNames(): string[] {
		return this.#host.agent.state.tools.map(t => t.name);
	}

	/** Enabled top-level and discoverable tool names. */
	getEnabledToolNames(): string[] {
		const mountedNames = this.#xdev?.mountedNames;
		if (!mountedNames || mountedNames.size === 0) return this.getActiveToolNames();
		return [...this.getActiveToolNames(), ...mountedNames];
	}

	/** Names currently presented as `xd://` devices. */
	getMountedXdevToolNames(): string[] {
		return [...(this.#xdev?.mountedNames ?? [])];
	}

	/** Whether the edit tool is registered. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	/** Looks up a registered tool by name. */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	/** Whether a registry entry came from a built-in factory. */
	hasBuiltInTool(name: string): boolean {
		return this.#builtInToolNames.has(name);
	}

	/** Updates source provenance when a live registry entry is replaced or restored. */
	setToolBuiltIn(name: string, builtIn: boolean): void {
		if (builtIn) {
			this.#builtInToolNames.add(name);
		} else {
			this.#builtInToolNames.delete(name);
		}
	}

	/** Whether the live registry entry is owned by the RPC host. */
	hasRpcHostTool(name: string): boolean {
		return this.#rpcHostToolNames.has(name);
	}

	/** Whether the current MCP entry came from the manager snapshot. */
	hasMCPManagerTool(name: string): boolean {
		return this.#mcpManagerToolNames.has(name);
	}

	/** Restores manager ownership after a lifecycle registration rollback. */
	setMCPManagerTool(name: string, managerOwned: boolean): void {
		if (managerOwned) {
			this.#mcpManagerToolNames.add(name);
		} else {
			this.#mcpManagerToolNames.delete(name);
		}
	}

	/** Current extension-owned MCP entry retained across manager refreshes. */
	getExtensionMCPTool(name: string): AgentTool | undefined {
		return this.#extensionMcpTools.get(name);
	}

	/** Updates extension ownership when a lifecycle registration commits or rolls back. */
	setExtensionMCPTool(name: string, tool: AgentTool | undefined): void {
		if (!isMCPToolName(name)) return;
		if (tool) {
			this.#extensionMcpTools.set(name, tool);
			this.#mcpManagerToolNames.delete(name);
		} else {
			this.#extensionMcpTools.delete(name);
		}
	}

	/** Serializes every registry and presentation mutation for this session. */
	runToolRegistryMutation<T>(mutation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.#toolRegistryMutationScope.getStore()) return untilAborted(signal, mutation);
		const serialized = this.#toolRegistryMutationTail.then(() => {
			signal?.throwIfAborted();
			return this.#toolRegistryMutationScope.run(true, mutation);
		});
		const operation = untilAborted(signal, serialized);
		this.#toolRegistryMutationTail = serialized.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** Names of every registered tool. */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys()).filter(
			name => name !== "search_tool_bm25" || this.isToolDiscoveryEnabled(),
		);
	}

	/**
	 * Full metadata for every registered tool, including source provenance.
	 *
	 * Backs the `getAllTools()` ExtensionAPI method. Returns {@link ToolInfo}
	 * objects (not bare names) so extensions authored against upstream
	 * `@earendil-works/pi-coding-agent` — which promises `ToolInfo[]` — can read
	 * `sourceInfo.source` unchanged.
	 */
	getAllToolInfos(): ToolInfo[] {
		return Array.from(this.#toolRegistry, ([name, tool]) => {
			const source = this.#builtInToolNames.has(name)
				? "builtin"
				: isMCPToolName(name)
					? "mcp"
					: this.#rpcHostToolNames.has(name)
						? "sdk"
						: "extension";
			const sourceInfo: SourceInfo = {
				path: `<${source}:${name}>`,
				source,
				scope: "temporary",
				origin: "top-level",
			};
			return { name, description: tool.description, parameters: tool.parameters, sourceInfo };
		});
	}

	#wrapRuntimeTool(tool: AgentTool): AgentTool {
		const wrapped = wrapToolWithMetaNotice(tool);
		const extensionRunner = this.#host.extensionRunner();
		return extensionRunner ? new ExtensionToolWrapper(wrapped, extensionRunner) : wrapped;
	}

	/** Registers and activates `consult` when an advisor attaches after the initial tool build. */
	async ensureConsultToolAvailable(): Promise<boolean> {
		if (this.#toolSession?.restrictToolNames === true || this.#host.settings.get("advisor.consult") === false) {
			return false;
		}
		if (!this.#toolRegistry.has("consult")) {
			const toolSession = this.#toolSession;
			if (!toolSession) return false;
			const consultTool = this.#wrapRuntimeTool(new ConsultTool(toolSession));
			this.#toolRegistry.set(consultTool.name, consultTool);
			this.#builtInToolNames.add(consultTool.name);
		}
		if (!this.getActiveToolNames().includes("consult")) {
			await this.applyActiveToolsByName([...this.getEnabledToolNames(), "consult"]);
		}
		return true;
	}

	/** Installs and activates the ephemeral vibe tool set. */
	activateVibeTools(baseToolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const createVibeTools = this.#createVibeTools;
			if (!createVibeTools) {
				throw new Error("Vibe tools are unavailable in this session.");
			}

			const tools = createVibeTools();
			const vibeToolNames = tools.map(tool => tool.name);
			if (new Set(vibeToolNames).size !== vibeToolNames.length) {
				throw new Error("Vibe tool names must be unique.");
			}

			for (const tool of tools) {
				if (this.#toolRegistry.has(tool.name)) continue;
				this.#toolRegistry.set(tool.name, this.#wrapRuntimeTool(tool));
				this.#builtInToolNames.add(tool.name);
				this.#installedVibeToolNames.add(tool.name);
			}

			await this.#applyActiveToolsByName([...new Set([...baseToolNames, ...vibeToolNames])]);
		});
	}

	/** Uninstalls vibe tools and activates the replacement set. */
	deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			this.#uninstallVibeTools();
			await this.#applyActiveToolsByName(nextToolNames);
		});
	}

	/** Removes vibe tools without restoring a source-session snapshot. */
	removeVibeToolsPreservingActive(): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const removed = new Set(this.#installedVibeToolNames);
			this.#uninstallVibeTools();
			const nextActive = this.getActiveToolNames().filter(name => !removed.has(name));
			await this.#applyActiveToolsByName(nextActive);
		});
	}

	#uninstallVibeTools(): void {
		for (const name of this.#installedVibeToolNames) {
			this.#toolRegistry.delete(name);
			this.#builtInToolNames.delete(name);
		}
		this.#installedVibeToolNames.clear();
	}

	#getEditModeSession() {
		return {
			settings: this.#host.settings,
			getActiveModelString: () => {
				const model = this.#host.model();
				return model ? formatModelString(model) : undefined;
			},
		} as const;
	}

	/** Resolves the edit mode for the active model and settings. */
	resolveActiveEditMode(): EditMode {
		return resolveEditMode(this.#getEditModeSession());
	}

	/** Whether MCP tools are currently selected through the discovery surface. */
	isMCPDiscoveryEnabled(): boolean {
		return this.#mcpDiscoveryEnabled;
	}

	/** Enables discovery and its search tool without exposing dormant MCP tools. */
	async enableMCPDiscoveryWithSearchTool(mode?: EffectiveToolDiscoveryMode): Promise<void> {
		await this.#runMCPToolMutation(async () => {
			const nextMode = mode ?? this.#effectiveDiscoveryMode;
			const nextEnabled = nextMode !== "off";
			if (!nextEnabled || !this.#toolRegistry.has("search_tool_bm25")) {
				this.#effectiveDiscoveryMode = nextMode;
				this.#mcpDiscoveryEnabled = false;
				return;
			}
			if (this.#mcpDiscoveryEnabled && this.getActiveToolNames().includes("search_tool_bm25")) {
				if (this.#effectiveDiscoveryMode !== nextMode) {
					this.#discoverableToolSearchIndex = undefined;
				}
				this.#effectiveDiscoveryMode = nextMode;
				return;
			}

			this.#mcpDiscoveryEnabling = true;
			try {
				await this.applyActiveToolsByName([...this.getEnabledToolNames(), "search_tool_bm25"]);
				this.#effectiveDiscoveryMode = nextMode;
				this.#mcpDiscoveryEnabled = true;
				this.#discoverableToolSearchIndex = undefined;
			} finally {
				this.#mcpDiscoveryEnabling = false;
			}
		});
	}

	/** MCP tools selected for this session, including active tools restored before discovery. */
	getSelectedMCPToolNames(): string[] {
		const active = this.getEnabledToolNames().filter(
			name => isMCPToolName(name) && this.#isRequestedToolAllowed(name),
		);
		return [...new Set([...active, ...this.#selectedMCPToolNames])].filter(name => this.#toolRegistry.has(name));
	}

	async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
		const activated = toolNames.filter(
			name => isMCPToolName(name) && this.#toolRegistry.has(name) && this.#isRequestedToolAllowed(name),
		);
		if (activated.length === 0) return [];
		const previousSelection = this.#selectedMCPToolNames;
		const previousHasExplicitSelection = this.#hasExplicitMCPToolSelection;
		this.#selectedMCPToolNames = new Set([...this.#selectedMCPToolNames, ...activated]);
		this.#hasExplicitMCPToolSelection = true;
		try {
			await this.applyActiveToolsByName([...this.getEnabledToolNames(), ...activated]);
		} catch (error) {
			this.#selectedMCPToolNames = previousSelection;
			this.#hasExplicitMCPToolSelection = previousHasExplicitSelection;
			throw error;
		}
		this.#host.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames());
		this.#discoverableToolSearchIndex = undefined;
		return [...new Set(activated)];
	}

	isToolDiscoveryEnabled(): boolean {
		return this.#mcpDiscoveryEnabled || (!this.#mcpDiscoveryEnabling && this.#effectiveDiscoveryMode !== "off");
	}

	/** Returns inactive registry tools eligible for the generic discovery index. */
	getDiscoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
		const active = new Set(this.getActiveToolNames());
		const includeMcp =
			this.#effectiveDiscoveryMode === "all" ||
			this.#effectiveDiscoveryMode === "mcp-only" ||
			this.#mcpDiscoveryEnabled;
		const includeBuiltin = this.#effectiveDiscoveryMode === "all";
		const tools = Array.from(this.#toolRegistry.values()).filter(tool => {
			if (active.has(tool.name)) return false;
			if ((tool as AgentTool & { defaultInactive?: boolean }).defaultInactive === true) return false;
			const isMcp = isMCPToolName(tool.name);
			const allowed = this.#isRequestedToolAllowed(tool.name) || (isMcp && !this.#hasExplicitlyRequestedMCPTools);
			return allowed && (isMcp ? includeMcp : includeBuiltin && tool.loadMode === "discoverable");
		});
		const discovered = [
			...collectDiscoverableTools(
				tools.filter(tool => isMCPToolName(tool.name)),
				{ source: "mcp" },
			),
			...collectDiscoverableTools(
				tools.filter(tool => !isMCPToolName(tool.name)),
				{ source: "builtin" },
			),
		];
		return filter?.source ? discovered.filter(tool => tool.source === filter.source) : discovered;
	}

	getDiscoverableToolSearchIndex(): DiscoverableToolSearchIndex {
		this.#discoverableToolSearchIndex ??= buildDiscoverableToolSearchIndex(this.getDiscoverableTools());
		return this.#discoverableToolSearchIndex;
	}

	getSelectedDiscoveredToolNames(): string[] {
		const active = new Set(this.getActiveToolNames());
		return [...new Set([...this.getSelectedMCPToolNames(), ...this.#selectedDiscoveredToolNames])].filter(name =>
			active.has(name),
		);
	}

	/** Activates built-in or MCP tools selected from the generic discovery index. */
	async activateDiscoveredTools(toolNames: string[]): Promise<string[]> {
		const mcp = await this.activateDiscoveredMCPTools(toolNames.filter(isMCPToolName));
		const active = new Set(this.getActiveToolNames());
		const regular = toolNames.filter(
			name =>
				!isMCPToolName(name) &&
				this.#toolRegistry.has(name) &&
				!active.has(name) &&
				this.#isRequestedToolAllowed(name),
		);
		if (regular.length > 0) {
			for (const name of regular) this.#selectedDiscoveredToolNames.add(name);
			await this.applyActiveToolsByName([...this.getEnabledToolNames(), ...regular]);
		}
		this.#discoverableToolSearchIndex = undefined;
		return [...new Set([...mcp, ...regular])];
	}
	#currentPromptModelKey(): string | undefined {
		const activeModel = this.#host.model();
		const model = activeModel ? formatModelString(activeModel) : undefined;
		if (!model || this.#host.settings.get("includeModelInPrompt")) return model;
		return usesCodexTaskPrompt(model) ? "task-policy:gpt-5.6" : "task-policy:default";
	}

	/** Reconciles the model-dependent discovery surface after a model change. */
	#logComputerState(message: string, enabled: boolean): void {
		const model = this.#host.model();
		logger.debug(message, {
			enabled,
			active: this.getEnabledToolNames().includes("computer"),
			model: model ? formatModelString(model) : undefined,
			exposure: computerExposureMode(model),
		});
	}

	/** Rebuilds model-dependent tool prompts after a model change. */
	async syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const previousMode = this.#effectiveDiscoveryMode;
		const nextMode = resolveEffectiveToolDiscoveryMode(
			this.#host.settings,
			{ contextWindow: this.#host.model()?.contextWindow ?? undefined },
			countToolsForAutoDiscovery([...this.#toolRegistry.keys()].filter(isMCPToolName)),
		);
		if (nextMode !== previousMode) {
			await this.#reconcileDiscoveryMode(nextMode);
		}
		const currentEditMode = this.resolveActiveEditMode();
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit");
		// The system prompt selects model-specific policy even when it does not display the model id.
		const modelChanged = this.#currentPromptModelKey() !== this.#promptModelKey;
		if (editModeChanged || modelChanged) {
			await this.refreshBaseSystemPrompt();
		}
		const computerExpected = this.#host.settings.get("computer.enabled");
		const computerActive = this.getEnabledToolNames().includes("computer");
		if (computerExpected && !computerActive) {
			const model = this.#host.model();
			const modelName = model ? formatModelString(model) : "the current model";
			logger.warn("Enabled computer tool missing after model change", { model: modelName });
			this.#host.emitNotice(
				"warning",
				`Computer use remains enabled, but the computer tool is unavailable to ${modelName}.`,
				"computer",
			);
		} else if (computerExpected) {
			this.#logComputerState("Computer tool retained after model change", true);
		}

		// inspect_image auto mode keys off model image capability, so a model
		// switch can flip the tool either way.
		await this.reconcileInspectImageAfterModelChange();
	}

	#defaultMCPToolNames(mcpTools: Iterable<{ name: string; mcpServerName?: string }>): string[] {
		return Array.from(mcpTools)
			.filter(
				tool =>
					this.#defaultSelectedMCPToolNames.has(tool.name) ||
					this.#defaultSelectedMCPServerNames.has(tool.mcpServerName ?? ""),
			)
			.map(tool => tool.name);
	}

	#rememberSessionDefaultSelectedMCPToolNames(
		sessionFile: string | null | undefined,
		toolNames: Iterable<string>,
	): void {
		if (!sessionFile) return;
		this.#sessionDefaultSelectedMCPToolNames.set(
			path.resolve(sessionFile),
			Array.from(toolNames).filter(name => this.#toolRegistry.has(name)),
		);
	}

	#getSessionDefaultSelectedMCPToolNames(sessionFile: string | null | undefined): string[] {
		if (!sessionFile) return [];
		return this.#sessionDefaultSelectedMCPToolNames.get(path.resolve(sessionFile)) ?? [];
	}

	async #runMCPToolMutation(operation: () => Promise<void>): Promise<void> {
		const previousMutation = this.#mcpToolMutationTail;
		const mutationGate = Promise.withResolvers<void>();
		this.#mcpToolMutationTail = mutationGate.promise;
		await previousMutation;
		try {
			await operation();
		} finally {
			mutationGate.resolve();
		}
	}

	async #reconcileDiscoveryMode(nextMode: EffectiveToolDiscoveryMode): Promise<void> {
		const previousMode = this.#effectiveDiscoveryMode;
		const previousMcpDiscoveryEnabled = this.#mcpDiscoveryEnabled;
		this.#effectiveDiscoveryMode = nextMode;
		this.#mcpDiscoveryEnabled = nextMode !== "off";
		const active = this.getEnabledToolNames();
		const activeNonMcp = active.filter(name => !isMCPToolName(name) && name !== "search_tool_bm25");
		const selectedMcp = this.#selectedMCPToolNames;
		const mcpTools = Array.from(this.#toolRegistry.values()).filter(tool => isMCPToolName(tool.name));
		let nextNonMcp = activeNonMcp;
		if (nextMode === "all" && !this.#host.orchestratorModeEnabled()) {
			nextNonMcp = activeNonMcp.filter(
				name =>
					this.#toolRegistry.get(name)?.loadMode !== "discoverable" || this.#selectedDiscoveredToolNames.has(name),
			);
		}
		const nextMcp =
			nextMode === "off"
				? mcpTools.filter(tool => this.#isRequestedToolAllowed(tool.name)).map(tool => tool.name)
				: mcpTools
						.filter(tool => selectedMcp.has(tool.name) && this.#isRequestedToolAllowed(tool.name))
						.map(tool => tool.name);
		const nextActive = [
			...nextNonMcp,
			...(nextMode === "off" ? [] : this.#toolRegistry.has("search_tool_bm25") ? ["search_tool_bm25"] : []),
			...nextMcp,
		];
		try {
			await this.applyActiveToolsByName(nextActive);
		} catch (error) {
			this.#effectiveDiscoveryMode = previousMode;
			this.#mcpDiscoveryEnabled = previousMcpDiscoveryEnabled;
			throw error;
		}
		this.#discoverableToolSearchIndex = undefined;
	}

	/**
	 * Wrap a tool with a permission-gate proxy when an ACP client is connected.
	 * Only wraps tools whose name is in PERMISSION_REQUIRED_TOOLS and only when
	 * the bridge exposes `requestPermission`. No-ops for all other cases.
	 *
	 * When the user has explicitly opted into `yolo` / auto-approve behavior (via
	 * the SDK/CLI `autoApprove` flag or a configured `tools.approvalMode: yolo`),
	 * skips the gate unless the per-tool policy explicitly requires a prompt or
	 * deny. The schema default is also `yolo`, so an explicit configuration or
	 * explicit session flag is required: default-config ACP sessions keep the
	 * client-side permission gate.
	 */
	#wrapToolForAcpPermission<T extends AgentTool>(tool: T): T {
		const bridge = this.#host.clientBridge();
		// Match the capability+method gating pattern used by read/write/bash.
		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool;
		if (PERMISSION_REQUIRED_TOOLS[tool.name] !== true) return tool;
		// Skip the gate only on explicit yolo opt-in; honour per-tool policies
		// that require a prompt or deny (matching the normal approval wrapper).
		if (this.#isExplicitAutoApproveMode()) {
			const userPolicies = (this.#host.settings.get("tools.approval") ?? {}) as Record<string, unknown>;
			const toolPolicy = userPolicies[tool.name];
			if (!toolPolicy || toolPolicy === "allow") return tool;
		}
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return target[prop as keyof T];
				return async (
					toolCallId: string,
					args: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					ctx: never,
				) => {
					const permissionIntent = getPermissionIntent(target.name, args);
					if (!permissionIntent) {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					const command =
						target.name === "bash" && args && typeof args === "object" && !Array.isArray(args)
							? stringProperty(args, "command")
							: undefined;
					const commandContent = command
						? [{ type: "content" as const, content: { type: "text" as const, text: `$ ${command}` } }]
						: undefined;
					// Short-circuit on persisted decisions.
					const persisted = this.#acpPermissionDecisions.get(permissionIntent.cacheKey);
					if (persisted === "allow_always") {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					if (persisted === "reject_always") {
						throw new ToolError(`Tool call rejected by user (preference)`);
					}
					if (signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					type PermissionRaceResult =
						| { kind: "permission"; outcome: ClientBridgePermissionOutcome }
						| { kind: "aborted" };
					const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>();
					const onAbort = () => resolveAbort({ kind: "aborted" });
					signal?.addEventListener("abort", onAbort, { once: true });
					let raced: PermissionRaceResult;
					try {
						const permissionPromise = bridge.requestPermission!(
							{
								toolCallId,
								toolName: target.name,
								title: permissionIntent.title,
								...(target.name === "bash" ? { kind: "execute" } : {}),
								status: "pending",
								rawInput: args,
								...(commandContent ? { content: commandContent } : {}),
								locations: extractPermissionLocations(
									args,
									this.#host.sessionManager.getCwd(),
									permissionIntent.paths,
								),
							},
							PERMISSION_OPTIONS,
							signal,
						).then(outcome => ({ kind: "permission" as const, outcome }));
						raced = await Promise.race([permissionPromise, abortPromise]);
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
					if (raced.kind === "aborted" || signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					const outcome = raced.outcome;
					if (outcome.outcome === "cancelled") {
						throw new ToolAbortError("Permission request cancelled");
					}
					const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId);
					if (!selectedOption) {
						throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`);
					}
					if (selectedOption.kind === "allow_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "allow_always");
					} else if (selectedOption.kind === "reject_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "reject_always");
					}
					if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
						throw new ToolError(`Tool call rejected by user (${target.name})`);
					}
					return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
				};
			},
		}) as T;
	}

	#isExplicitAutoApproveMode(): boolean {
		return (
			this.#autoApprove ||
			(this.#host.settings.isConfigured("tools.approvalMode") &&
				this.#host.settings.get("tools.approvalMode") === "yolo")
		);
	}
	/**
	 * Inactive extension tools opted out with `defaultInactive` are registered so
	 * extensions can activate them later, but are not agent capabilities yet.
	 * Keep them out of prompt catalogues and discovery summaries until enabled.
	 */
	#promptToolRegistryFor(enabledToolNames: Iterable<string>): Map<string, AgentTool> {
		const enabled = new Set(enabledToolNames);
		return new Map(
			Array.from(this.#toolRegistry, ([name, tool]) => {
				const defaultInactive = (tool as AgentTool & { defaultInactive?: boolean }).defaultInactive === true;
				return !defaultInactive || enabled.has(name) ? [[name, tool] as const] : [];
			}).flat(),
		);
	}


	/** Applies an enabled tool set and reconciles its `xd://` partition. */
	applyActiveToolsByName(toolNames: string[], forcePromptRefresh = false, signal?: AbortSignal): Promise<void> {
		return this.runToolRegistryMutation(
			() => this.#applyActiveToolsByName(toolNames, forcePromptRefresh, signal),
			signal,
		);
	}

	async #applyActiveToolsByName(toolNames: string[], forcePromptRefresh = false, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const previousActiveToolNames = this.getEnabledToolNames();
		// A newly enabled extension can be mounted under xd:// and therefore leave
		// the active top-level names unchanged. Its registration must still rebuild
		// the prompt: the extension's systemPrompt hook is the transactional
		// boundary that either publishes the capability or rolls the registration
		// back and reports the failure.
		forcePromptRefresh ||= toolNames.some(name => !previousActiveToolNames.includes(name));
		toolNames = normalizeToolNames([...toolNames, ...(this.#getPinnedRuntimeToolNames?.() ?? [])]);
		let builtInWriteAvailable = this.#builtInToolNames.has("write");
		if (toolNames.includes("write") && !builtInWriteAvailable) {
			const writeRegistration = this.#ensureWriteRegistered?.();
			builtInWriteAvailable = writeRegistration ? (await untilAborted(signal, writeRegistration)) === true : false;
			if (builtInWriteAvailable) this.#builtInToolNames.add("write");
		}
		const selectedTools = toolNames.flatMap(name => {
			const tool = this.#toolRegistry.get(name);
			return tool ? [{ name, tool }] : [];
		});
		const xdevReadAvailable = this.#builtInToolNames.has("read") && selectedTools.some(({ name }) => name === "read");
		const xdevWriteAvailable = builtInWriteAvailable && selectedTools.some(({ name }) => name === "write");
		const isPresentationPinned = (name: string): boolean =>
			this.#presentationPinnedToolNames?.has(name) === true || this.#runtimeSelectedToolNames?.has(name) === true;
		const mountCandidates = selectedTools.filter(
			({ name, tool }) =>
				this.#xdev !== undefined &&
				xdevReadAvailable &&
				xdevWriteAvailable &&
				!isPresentationPinned(name) &&
				isMountableUnderXdev(tool),
		);
		const mountNames = new Set(mountCandidates.map(({ name }) => name));
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const { name, tool } of selectedTools) {
			if (mountNames.has(name)) continue;
			tools.push(this.#wrapToolForAcpPermission(tool));
			validToolNames.push(name);
		}

		const pinnedWrite = isPresentationPinned("write");
		const writeSelected = selectedTools.some(({ name }) => name === "write");
		const activeDeferrableTool = tools.some(tool => tool.deferrable === true);
		const transportNeeded =
			writeSelected && (mountNames.size > 0 || activeDeferrableTool || this.#host.planModeEnabled());
		if (transportNeeded && !builtInWriteAvailable) {
			const writeRegistration = this.#ensureWriteRegistered?.();
			builtInWriteAvailable = writeRegistration ? (await untilAborted(signal, writeRegistration)) === true : false;
			if (builtInWriteAvailable) this.#builtInToolNames.add("write");
		}
		if (transportNeeded && builtInWriteAvailable) {
			const write = this.#toolRegistry.get("write");
			if (write && !validToolNames.includes("write")) {
				tools.push(this.#wrapToolForAcpPermission(write));
				validToolNames.push("write");
			}
		} else if (
			!pinnedWrite &&
			(this.#presentationPinnedToolNames !== undefined || this.#runtimeSelectedToolNames !== undefined)
		) {
			const writeNameIndex = validToolNames.indexOf("write");
			if (writeNameIndex >= 0 && this.#builtInToolNames.has("write")) validToolNames.splice(writeNameIndex, 1);
			const writeToolIndex = tools.findIndex(tool => tool.name === "write" && this.#builtInToolNames.has("write"));
			if (writeToolIndex >= 0) tools.splice(writeToolIndex, 1);
		}

		const previousMounted = new Set(this.#xdev?.mountedNames ?? []);
		const promptXdev = this.#xdev ? { ...this.#xdev, mountedNames: mountNames } : undefined;
		const promptXdevRouteSources = promptXdev ? listXdevTools(promptXdev) : [];

		let rebuiltSystemPrompt: string[] | undefined;
		let rebuiltSignature: string | undefined;
		let rebuiltXdevCatalogNames: readonly string[] | undefined;
		try {
			if (this.#rebuildSystemPrompt) {
				const signature = this.#computeAppliedToolSignature(validToolNames, tools, promptXdevRouteSources);
				if (forcePromptRefresh || signature !== this.#lastAppliedToolSignature) {
					const built = await untilAborted(
						signal,
						this.#rebuildSystemPrompt(validToolNames, this.#promptToolRegistryFor(toolNames), {
							xdevTools: promptXdev ? xdevEntries(promptXdev) : [],
							xdevDocs: promptXdev
								? xdevDocsAll(
										promptXdev,
										this.#host.settings.get("tools.xdevDocs"),
										this.#host.settings.get("tools.xdevInlineDevices"),
									)
								: "",
							xdevRouteSources: promptXdevRouteSources,
						}),
					);
					rebuiltSystemPrompt = built.systemPrompt;
					rebuiltSignature = signature;
					rebuiltXdevCatalogNames = built.xdevCatalogNames;
				}
			}
			signal?.throwIfAborted();
		} catch (error) {
			this.#setMountedNames(previousMounted);
			this.#setActiveToolNames?.(previousActiveToolNames);
			throw error;
		}

		if (this.#host.isDisposed()) return;

		this.#setMountedNames(mountNames);
		this.#host.agent.setTools(tools);
		this.#setActiveToolNames?.(validToolNames);
		if (rebuiltSystemPrompt && rebuiltSignature) {
			if (this.#lastAppliedToolSignature !== undefined) this.#host.clearInheritedProviderPromptCacheKey();
			this.#baseSystemPrompt = rebuiltSystemPrompt;
			this.#host.clearMemoryPromotionSnapshot();
			this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
			this.#lastAppliedToolSignature = rebuiltSignature;
			this.#promptModelKey = this.#currentPromptModelKey();
			this.#basePromptXdevNames = new Set(rebuiltXdevCatalogNames);
		}
		this.#notifyXdevMountDelta(previousMounted);
	}

	#setMountedNames(names: Iterable<string>): void {
		const mountedNames = this.#xdev?.mountedNames;
		if (!mountedNames) return;
		mountedNames.clear();
		for (const name of names) mountedNames.add(name);
	}

	/**
	 * Record a mid-session `xd://` mount delta for the model. Non-MCP mount
	 * churn remains notice-only, leaving the system prompt and provider cache
	 * prefix byte-stable; mounted MCP route changes additionally rebuild the
	 * global route guidance through the applied-tool signature. The delta is NOT
	 * steered immediately — a steered notice landing at a run's stop boundary
	 * (or while the session is idle) forces an unsolicited extra assistant turn
	 * — so it is coalesced into {@link #pendingXdevMountDelta} and rides along
	 * with the next prompt (docs + schema stay one `read xd://<tool>` away).
	 * Full docs join the system prompt opportunistically on a rebuild.
	 */
	#notifyXdevMountDelta(previousMounted: ReadonlySet<string>): void {
		const current = this.#xdev?.mountedNames;
		if (!current) return;
		const addedNames = [...current].filter(name => !previousMounted.has(name));
		const removedNames = [...previousMounted].filter(name => !current.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return;
		// Coalesce against the unannounced delta: an unmount cancels a pending
		// mount the model never learned about, and a remount cancels a pending
		// unmount.
		const pending = this.#pendingXdevMountDelta ?? { added: new Set<string>(), removed: new Set<string>() };
		for (const name of addedNames) {
			if (!pending.removed.delete(name)) pending.added.add(name);
		}
		for (const name of removedNames) {
			if (!pending.added.delete(name)) pending.removed.add(name);
		}
		this.#pendingXdevMountDelta = pending.added.size > 0 || pending.removed.size > 0 ? pending : undefined;
		if (this.#host.settings.get("startup.quiet")) return;
		const parts: string[] = [];

		if (addedNames.length > 0) parts.push(`mounted ${addedNames.join(", ")}`);
		if (removedNames.length > 0) parts.push(`unmounted ${removedNames.join(", ")}`);
		this.#host.emitNotice("info", `xd://: ${parts.join("; ")}`, "xdev");
	}

	/**
	 * Forget the announced-mount baseline for a replaced transcript. Called when
	 * session history is swapped wholesale (`/new`, `switchSession`, `branch`): the
	 * previous transcript's persisted notices no longer apply, so the next notice
	 * re-seeds from the new history and a device reconnecting into it announces
	 * again.
	 *
	 * The pending delta is deliberately preserved: it holds mounts that are still
	 * live but not yet delivered to the model, and `branch()` does not rebuild the
	 * base system prompt, so dropping it would leave the branched transcript
	 * unaware of a still-mounted device that no later refresh would re-queue.
	 */
	resetAnnouncedMounts(): void {
		this.#announcedMounts.clear();
		this.#announcedMountsSeeded = false;
	}

	/**
	 * Seed {@link #announcedMounts} from persisted mount notices the first time a
	 * notice is consumed. On resume the in-memory mount set is rebuilt from
	 * scratch, so without replaying history every already-announced dynamic device
	 * would look freshly mounted and re-announce.
	 */
	#ensureAnnouncedMountsSeeded(): void {
		if (this.#announcedMountsSeeded) return;
		this.#announcedMountsSeeded = true;
		for (const message of this.#host.agent.state.messages) {
			if (message.role !== "custom" || message.customType !== XDEV_MOUNT_NOTICE_MESSAGE_TYPE) continue;
			const details = message.details;
			if (
				isRecord(details) &&
				Array.isArray(details.added) &&
				details.added.every(name => typeof name === "string") &&
				Array.isArray(details.removed) &&
				details.removed.every(name => typeof name === "string")
			) {
				for (const name of details.added) this.#announcedMounts.add(name);
				for (const name of details.removed) this.#announcedMounts.delete(name);
				continue;
			}

			// Releases before structured notice details persisted only the rendered
			// prompt. Replay its two stable inventory sections so the first resume
			// after upgrading does not re-announce every dynamic device once.
			if (typeof message.content !== "string") continue;
			let section: "added" | "removed" | undefined;
			for (const line of message.content.split("\n")) {
				if (line === "These tools became available:") {
					section = "added";
					continue;
				}
				if (line.startsWith("No longer mounted")) {
					section = "removed";
					continue;
				}
				if (line === "Configured inline device docs:" || line === "</system-notice>") break;
				if (line.startsWith("Read `xd://<tool>`")) {
					section = undefined;
					continue;
				}
				if (!section) continue;
				const match = /^- xd:\/\/(\S+?)(?:\s+—|$)/.exec(line);
				const name = match?.[1];
				if (!name) continue;
				if (section === "added") this.#announcedMounts.add(name);
				else this.#announcedMounts.delete(name);
			}
		}
	}

	/** Consumes the hidden notice for unannounced `xd://` mount changes. */
	takePendingXdevMountNotice(baseCatalogDelivered: boolean): CustomMessage<XdevMountNoticeDetails> | undefined {
		const pending = this.#pendingXdevMountDelta;
		if (!pending) return undefined;
		this.#pendingXdevMountDelta = undefined;
		this.#ensureAnnouncedMountsSeeded();
		// A pending add for a device the outgoing base prompt already lists in its
		// catalog needs no notice line — but only when the final provider prompt
		// still carries that base catalog. A `before_agent_start` replacement drops
		// it, so its additions must remain in the notice. Record prompt-carried
		// devices announced here, after the final prompt is known and immediately
		// before delivery. The pending delta remains untouched by rebuilds, letting
		// {@link #notifyXdevMountDelta} cancel a mount followed by an unmount before
		// any request is sent (issue #7139 reviews).
		if (baseCatalogDelivered) {
			for (const name of pending.added) {
				if (this.#basePromptXdevNames.has(name)) this.#announcedMounts.add(name);
			}
		}
		// Only announce a net change relative to what the model already knows (from
		// this session and persisted history): a re-mount of an already-announced
		// device — the common resume/reconnect case — and an unmount for a device
		// it was never told about are both suppressed, keeping the provider prompt
		// cache prefix byte-stable across resumes.
		const addedNames = [...pending.added].filter(name => !this.#announcedMounts.has(name));
		const removedNames = [...pending.removed].filter(name => this.#announcedMounts.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return undefined;
		const summaries = new Map(this.#xdev ? xdevEntries(this.#xdev).map(entry => [entry.name, entry.summary]) : []);
		const added = addedNames.map(name => ({ name, summary: summaries.get(name) ?? "" }));
		const removed = removedNames.map(name => ({ name }));
		const docs = this.#xdev
			? xdevDocsFor(
					this.#xdev,
					new Set(addedNames),
					this.#host.settings.get("tools.xdevDocs"),
					this.#host.settings.get("tools.xdevInlineDevices"),
				)
			: "";
		for (const name of addedNames) this.#announcedMounts.add(name);
		for (const name of removedNames) this.#announcedMounts.delete(name);
		return {
			role: "custom",
			customType: XDEV_MOUNT_NOTICE_MESSAGE_TYPE,
			content: prompt.render(xdevMountNoticePrompt, { added, removed, docs }),
			details: { added: addedNames, removed: removedNames },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/** Rediscovers reloadable skills and refreshes prompt metadata. */
	async refreshSkills(): Promise<void> {
		resetCapabilities();
		if (this.#skillsReloadable) {
			const skillsSettings = this.#host.settings.getGroup("skills");
			const discovered = await loadSkills({
				...skillsSettings,
				cwd: this.#host.sessionManager.getCwd(),
				disabledExtensions: this.#host.settings.get("disabledExtensions") ?? [],
			});
			this.#skills = discovered.skills;
			this.#skillWarnings = discovered.warnings;
			this.#skillsSettings = skillsSettings;

			if (this.#host.agentKind() === "main") {
				setActiveSkills(this.#skills);
			}
		}
		await this.refreshBaseSystemPrompt();
		this.#host.notifyCommandMetadataChanged();
	}
	/** Rebuilds the capability-derived SSH tool and reconciles its active selection. */
	async refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void> {
		resetCapabilities();
		if (!this.#reloadSshTool) return;
		const hadSsh = this.getEnabledToolNames().includes("ssh");
		const refreshed = await this.#reloadSshTool();
		if (refreshed) this.#toolRegistry.set(refreshed.name, refreshed);
		else this.#toolRegistry.delete("ssh");
		const next = this.getEnabledToolNames().filter(name => name !== "ssh" && this.#toolRegistry.has(name));
		if (refreshed && this.#isRequestedToolAllowed("ssh") && (hadSsh || options?.activateIfAvailable)) {
			next.push(refreshed.name);
		}
		await this.applyActiveToolsByName(next);
		this.#discoverableToolSearchIndex = undefined;
	}

	/** Reconciles the session-scoped Kanban tool after board runtime availability changes. */
	async refreshKanbanTool(): Promise<void> {
		const toolSession = this.#toolSession;
		if (!toolSession) return;

		const kanbanTool = KanbanTool.createIf(toolSession);
		if (kanbanTool) {
			const wrappedKanbanTool = this.#wrapRuntimeTool(kanbanTool as Tool);
			this.#toolRegistry.set(wrappedKanbanTool.name, wrappedKanbanTool);
			this.#builtInToolNames.add(wrappedKanbanTool.name);
		} else {
			this.#toolRegistry.delete("kanban");
			this.#builtInToolNames.delete("kanban");
		}

		const nextToolNames = this.getEnabledToolNames().filter(
			name => name !== "kanban" && this.#toolRegistry.has(name),
		);
		if (kanbanTool && this.#isRequestedToolAllowed(kanbanTool.name)) nextToolNames.push(kanbanTool.name);
		await this.applyActiveToolsByName(nextToolNames);
		this.#discoverableToolSearchIndex = undefined;
	}

	/** Replaces SDK-provided skill snapshots after an external rediscovery. */
	setSkills(skills: readonly Skill[], warnings: readonly SkillWarning[], settings?: SkillsSettings): void {
		this.#skills = [...skills];
		this.#skillWarnings = [...warnings];
		this.#skillsSettings = settings;
		if (this.#host.agentKind() === "main") setActiveSkills(this.#skills);
		this.#host.notifyCommandMetadataChanged();
	}

	/** Selects enabled tools, ignoring names absent from the registry. */
	setActiveToolsByName(toolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const normalized = this.#normalizeSelectableToolNames(toolNames);
			// Transport-write eligibility keys off the *current* active set: an ordinary
			// selection change should not demote `write` unless it is already active.
			await this.#applyToolPresentation(
				normalized,
				this.#xdev?.mountedNames ?? new Set(),
				this.getActiveToolNames().includes("write"),
			);
			this.#setMCPToolSelection(normalized);
		});
	}

	/** Replaces a temporary mode surface without changing the saved MCP selection. */
	async setActiveToolsByNamePreservingMCPSelection(toolNames: string[]): Promise<void> {
		const normalized = this.#normalizeSelectableToolNames(toolNames);
		await this.#applyToolPresentation(
			normalized,
			this.#xdev?.mountedNames ?? new Set(),
			this.getActiveToolNames().includes("write"),
		);
		this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
	}

	#normalizeSelectableToolNames(toolNames: string[]): string[] {
		const mountedNames = this.#xdev?.mountedNames;
		const activeToolNames = new Set(this.getActiveToolNames());
		return normalizeToolNames(toolNames).filter(
			name =>
				this.#toolRegistry.has(name) &&
				(this.#explicitlyRequestedToolNames === undefined ||
					this.#builtInToolNames.has(name) ||
					this.#explicitlyRequestedToolNames.has(name) ||
					activeToolNames.has(name) ||
					mountedNames?.has(name) === true) &&
				(name !== "search_tool_bm25" ||
					this.isToolDiscoveryEnabled() ||
					this.#mcpDiscoveryEnabling ||
					this.#host.orchestratorModeEnabled()),
		);
	}

	/**
	 * Restore an enabled tool set with its exact top-level versus `xd://` partition.
	 *
	 * Both inputs are required because {@link setActiveToolsByName} only receives the
	 * enabled name list and classifies mounts from the current presentation set.
	 * Rollback/restore callers must pass the snapshotted mounted subset so names that
	 * were top-level stay pinned (`#runtimeSelectedToolNames`) and names that were under
	 * `xd://` remain mount-eligible, even when the live mount set has drifted.
	 *
	 * Names outside `mountedToolNames` are pinned top-level for this application;
	 * names in the mounted subset remain eligible for xdev mounting. Set
	 * `forcePromptRefresh` when an enabled tool's schema or prompt-visible metadata
	 * changed without changing its name or presentation.
	 *
	 * Delegates the actual apply through {@link applyActiveToolsByName} and restores
	 * the prior runtime selection if that apply throws.
	 */
	setActiveToolPresentation(
		toolNames: string[],
		mountedToolNames: string[],
		forcePromptRefresh = false,
		signal?: AbortSignal,
	): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const normalized = normalizeToolNames(toolNames);
			// Restoration targets a snapshot, so write eligibility comes from the
			// *target* set rather than whatever happens to be active mid-rollback.
			await this.#applyToolPresentation(
				normalized,
				new Set(normalizeToolNames(mountedToolNames)),
				normalized.includes("write"),
				forcePromptRefresh,
				signal,
			);
		}, signal);
	}

	/** Reconciles persisted branch/session MCP selection without rewriting session history. */
	async restoreMCPToolSelection(
		toolNames: string[],
		hasPersistedSelection: boolean,
		useDefaultSelection = true,
	): Promise<void> {
		// Direct MCP sessions have no persisted selection; preserve their live surface
		// across a transcript replacement so reconnecting devices remain available.
		const fallbackSelection =
			useDefaultSelection && !this.#mcpDiscoveryEnabled
				? this.getEnabledToolNames().filter(isMCPToolName)
				: useDefaultSelection
					? this.#defaultSelectedMCPToolNames
					: this.#getSessionDefaultSelectedMCPToolNames(this.#host.sessionManager.getSessionFile());
		const nextSelection = new Set(hasPersistedSelection ? toolNames.filter(isMCPToolName) : fallbackSelection);
		const defaultMCPToolNames = new Set(this.#defaultMCPToolNames(this.#toolRegistry.values()));
		const selectedMcp = Array.from(this.#toolRegistry.values())
			.filter(
				tool =>
					isMCPToolName(tool.name) &&
					this.#isRequestedToolAllowed(tool.name) &&
					(nextSelection.has(tool.name) ||
						(!hasPersistedSelection && useDefaultSelection && defaultMCPToolNames.has(tool.name))),
			)
			.map(tool => tool.name);
		await this.applyActiveToolsByName([...this.#getActiveNonMCPToolNames(), ...selectedMcp]);
		this.#selectedMCPToolNames = nextSelection;
		this.#hasExplicitMCPToolSelection = hasPersistedSelection;
		this.#discoverableToolSearchIndex = undefined;
		this.#rememberSessionDefaultSelectedMCPToolNames(this.#host.sessionManager.getSessionFile(), selectedMcp);
	}

	#setMCPToolSelection(toolNames: readonly string[]): void {
		this.#selectedMCPToolNames = new Set(
			toolNames.filter(name => isMCPToolName(name) && this.#isRequestedToolAllowed(name)),
		);
		this.#hasExplicitMCPToolSelection = true;
		if (this.#mcpDiscoveryEnabled) {
			this.#host.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames());
		}
		this.#discoverableToolSearchIndex = undefined;
	}

	/**
	 * Shared body for {@link setActiveToolsByName} and {@link setActiveToolPresentation}:
	 * pins non-mounted names as the runtime selection (holding `write` back when it is
	 * transport-only) and applies the set, rolling the selection back if apply throws.
	 */
	async #applyToolPresentation(
		normalized: string[],
		mounted: ReadonlySet<string>,
		writeSelected: boolean,
		forcePromptRefresh = false,
		signal?: AbortSignal,
	): Promise<void> {
		const transportWriteActive =
			writeSelected &&
			this.#builtInToolNames.has("write") &&
			this.#presentationPinnedToolNames?.has("write") !== true &&
			this.#runtimeSelectedToolNames?.has("write") !== true &&
			(mounted.size > 0 || this.#host.planModeEnabled());
		const previousRuntimeSelectedToolNames = this.#runtimeSelectedToolNames;
		this.#runtimeSelectedToolNames = new Set(
			normalized.filter(name => !mounted.has(name) && !(name === "write" && transportWriteActive)),
		);
		try {
			await this.#applyActiveToolsByName(normalized, forcePromptRefresh, signal);
		} catch (error) {
			this.#runtimeSelectedToolNames = previousRuntimeSelectedToolNames;
			throw error;
		}
	}

	/** Replaces memory-backend tools while preserving unrelated selections. */
	replaceMemoryTools(tools: AgentTool[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const removed = new Set<string>(MEMORY_BACKEND_TOOL_NAMES.filter(name => this.#builtInToolNames.has(name)));
			const nextActive = this.getEnabledToolNames().filter(name => !removed.has(name));
			for (const name of removed) {
				this.#toolRegistry.delete(name);
				this.#builtInToolNames.delete(name);
			}

			for (const tool of tools) {
				if (!MEMORY_BACKEND_TOOL_NAMES.some(name => name === tool.name) || this.#toolRegistry.has(tool.name)) {
					continue;
				}
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
				nextActive.push(wrapped.name);
			}
			await this.#applyActiveToolsByName([...new Set(nextActive)]);
		});
	}

	/**
	 * Session-scoped enable/disable for the settings-gated `computer` tool.
	 *
	 * `createTools` derives the built-in slate once at session start, so a runtime
	 * `computer.enabled` override alone never changes the active tools. Enabling
	 * builds the tool through the config factory on first use (later toggles reuse
	 * the registry entry, so only one desktop controller is ever registered) and
	 * activates it; disabling drops it from the active set while keeping the
	 * registry entry. Takes effect before the next model call.
	 *
	 * @returns false when enabling was requested but this session cannot build the
	 * tool (e.g. restricted child sessions have no factory).
	 */
	setComputerToolEnabled(enabled: boolean): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			const logState = (): void => this.#logComputerState("Computer tool state changed", enabled);
			const active = this.getEnabledToolNames();
			if (!enabled) {
				if (active.includes("computer")) {
					await this.#applyActiveToolsByName(active.filter(name => name !== "computer"));
				}
				logState();
				return true;
			}
			if (!this.#toolRegistry.has("computer")) {
				const tool = await this.#createComputerTool?.();
				if (tool?.name !== "computer") {
					const model = this.#host.model();
					logger.warn("Computer tool could not be created", {
						model: model ? formatModelString(model) : undefined,
					});
					return false;
				}
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
			}
			if (!active.includes("computer")) {
				await this.#applyActiveToolsByName([...active, "computer"]);
			}
			logState();
			return true;
		});
	}

	/**
	 * Session-scoped enable/disable for the private `think` scratchpad tool.
	 *
	 * Enabling constructs the tool once and refreshes the model's tool contract;
	 * disabling removes it from the active set while preserving its registry entry.
	 *
	 * @returns false when enabling was requested but this session cannot build the tool.
	 */
	setThinkToolEnabled(enabled: boolean): Promise<boolean> {
		return this.#setThinkToolActive(enabled && supportsExternalThinking(this.#host.model()));
	}

	/** Reconciles the external scratchpad after the active model changes. */
	reconcileThinkTool(): Promise<boolean> {
		return this.#setThinkToolActive(
			this.#host.settings.get("externalThinking") && supportsExternalThinking(this.#host.model()),
		);
	}

	#setThinkToolActive(enabled: boolean): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			const active = this.getEnabledToolNames();
			if (!enabled) {
				if (active.includes("think")) {
					await this.#applyActiveToolsByName(active.filter(name => name !== "think"));
				}
				return true;
			}
			if (!this.#toolRegistry.has("think")) {
				const tool = await this.#createThinkTool?.();
				if (tool?.name !== "think") return false;
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
			}
			if (!active.includes("think")) {
				await this.#applyActiveToolsByName([...active, "think"]);
			}
			return true;
		});
	}

	/** Current effective inspect_image state for `/vision status`. */
	inspectImageState(): { mode: InspectImageMode; active: boolean; model: string | undefined } {
		const model = this.#host.model();
		return {
			mode: this.#host.getInspectImageModeOverride() ?? this.#host.settings.get("inspect_image.mode"),
			active: this.getEnabledToolNames().includes("inspect_image"),
			model: model ? formatModelString(model) : undefined,
		};
	}

	/**
	 * Brings the active tool set in line with the effective inspect_image state
	 * (mode setting, `/vision` override, active-model image capability).
	 * Mirrors {@link setComputerToolEnabled}: enabling builds the tool through
	 * the config factory on first use and reuses the registry entry afterwards.
	 * Idempotent — safe to call from every model/settings change path.
	 *
	 * @returns false when the tool should be active but this session cannot
	 *   build it (e.g. restricted child sessions have no factory).
	 */
	reconcileInspectImageTool(): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			const expected = isInspectImageToolActive({
				settings: this.#host.settings,
				getActiveModel: () => this.#host.model(),
				getInspectImageModeOverride: () => this.#host.getInspectImageModeOverride(),
			});
			// Keep the read tool's advertised description in sync BEFORE any prompt
			// rebuild below, passing the post-change availability so the prompt never
			// lags a flip in either direction. Per-read lazy sync is the backstop.
			const syncReadDescription = (available: boolean): void => {
				const readTool = this.#toolRegistry.get("read") as
					| { syncInspectImageState?: (available?: boolean) => boolean }
					| undefined;
				readTool?.syncInspectImageState?.(available);
			};
			const active = this.getEnabledToolNames();
			const isActive = active.includes("inspect_image");
			if (expected === isActive) {
				syncReadDescription(isActive);
				return true;
			}
			if (!expected) {
				syncReadDescription(false);
				await this.#applyActiveToolsByName(active.filter(name => name !== "inspect_image"));
				return true;
			}
			if (!this.#toolRegistry.has("inspect_image")) {
				const tool = await this.#createInspectImageTool?.();
				if (tool?.name !== "inspect_image") {
					logger.warn("inspect_image tool could not be created", {
						model: this.#host.model()?.id,
					});
					syncReadDescription(false);
					return false;
				}
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
			}
			syncReadDescription(true);
			await this.#applyActiveToolsByName([...active, "inspect_image"]);
			return true;
		});
	}

	/**
	 * Reconciles inspect_image after a model change and surfaces a notice when
	 * the visible tool set actually flipped. Called from every model-change
	 * path — including retry-fallback switches that bypass
	 * {@link syncAfterModelChange}.
	 */
	reconcileInspectImageAfterModelChange(): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const before = this.getEnabledToolNames().includes("inspect_image");
			const reconciled = await this.reconcileInspectImageTool();
			const after = this.getEnabledToolNames().includes("inspect_image");
			if (!reconciled || before === after) return;
			const model = this.#host.model();
			const modelName = model ? formatModelString(model) : "the current model";
			this.#host.emitNotice(
				"info",
				after
					? `inspect_image is now available: ${modelName} has no native image input.`
					: `inspect_image is now hidden: ${modelName} supports image input natively. Override with /vision on.`,
				"vision",
			);
		});
	}

	/**
	 * Session-scoped `/vision` override. `auto` clears the override so the
	 * persisted `inspect_image.mode` setting (itself possibly `auto`) decides;
	 * `on`/`off` force the tool for this session only. Takes effect before the
	 * next model call.
	 *
	 * @returns false when `on` was requested but the tool cannot be built here.
	 */
	setInspectImageMode(mode: InspectImageMode): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			this.#host.setInspectImageModeOverride(mode === "auto" ? undefined : mode);
			const applied = await this.reconcileInspectImageTool();
			const { active, model } = this.inspectImageState();
			logger.debug("inspect_image mode changed", { mode, active, model });
			return applied;
		});
	}

	/** Rebuilds the stable base prompt for the current tools and model. */
	refreshBaseSystemPrompt(): Promise<void> {
		return this.runToolRegistryMutation(() => this.#refreshBaseSystemPrompt());
	}

	async #refreshBaseSystemPrompt(): Promise<void> {
		if (this.#host.isDisposed()) return;
		if (!this.#rebuildSystemPrompt) {
			this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
			return;
		}
		const activeToolNames = this.getActiveToolNames();
		this.#setActiveToolNames?.(activeToolNames);
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const built = await this.#rebuildSystemPrompt(activeToolNames, this.#promptToolRegistryFor(activeToolNames));
		if (this.#host.isDisposed()) return;
		this.#baseSystemPrompt = built.systemPrompt;
		this.#basePromptXdevNames = new Set(built.xdevCatalogNames);
		this.#host.clearMemoryPromotionSnapshot();
		if (
			previousBaseSystemPrompt.length !== this.#baseSystemPrompt.length ||
			previousBaseSystemPrompt.some((part, index) => part !== this.#baseSystemPrompt[index])
		) {
			this.#host.clearInheritedProviderPromptCacheKey();
		}
		this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
		this.#promptModelKey = this.#currentPromptModelKey();
		// Refresh the cached signature so a subsequent `applyActiveToolsByName` with
		// the same tool set does not re-rebuild on top of the explicit refresh we
		// just performed (and conversely, a different set forces a fresh rebuild).
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(activeToolNames, activeTools);
	}

	/** Applies one-turn memory prompt injection before an agent run. */
	async buildSystemPromptForAgentStart(promptText: string): Promise<string[]> {
		const backend = await resolveMemoryBackend(this.#host.settings);
		if (!backend.beforeAgentStartPrompt) return this.#applySystemPromptOverlay(this.#baseSystemPrompt);

		try {
			const injected = await backend.beforeAgentStartPrompt(this.#host.memoryBackendSession(), promptText);
			if (!injected) return this.#applySystemPromptOverlay(this.#baseSystemPrompt);

			const previousBaseSystemPrompt = this.#baseSystemPrompt;
			try {
				await this.refreshBaseSystemPrompt();
			} catch (refreshErr) {
				logger.debug("Memory backend prompt refresh after beforeAgentStartPrompt failed", {
					backend: backend.id,
					error: String(refreshErr),
				});
			}

			if (
				this.#baseSystemPrompt.length !== previousBaseSystemPrompt.length ||
				this.#baseSystemPrompt.some((part, index) => part !== previousBaseSystemPrompt[index])
			) {
				return this.#applySystemPromptOverlay(this.#baseSystemPrompt);
			}

			this.#host.captureMemoryPromotionSnapshot(previousBaseSystemPrompt);
			const stablePrompt = [...previousBaseSystemPrompt, injected];
			this.#baseSystemPrompt = stablePrompt;
			this.#applyAgentSystemPrompt(stablePrompt);
			return this.#applySystemPromptOverlay(stablePrompt);
		} catch (err) {
			logger.debug("Memory backend beforeAgentStartPrompt failed", {
				backend: backend.id,
				error: String(err),
			});
			return this.#applySystemPromptOverlay(this.#baseSystemPrompt);
		}
	}

	#applySystemPromptOverlay(baseSystemPrompt: string[]): string[] {
		return this.#systemPromptOverlay?.(baseSystemPrompt) ?? baseSystemPrompt;
	}

	/**
	 * Compose a stable signature for the inputs that `rebuildSystemPrompt` reads.
	 * Two calls producing identical signatures are guaranteed to produce identical
	 * system prompt bytes, so the rebuild can be skipped.
	 *
	 * The signature covers:
	 *   1. Active tool names in order (the prompt renders them in this order).
	 *   2. Active tool labels, descriptions, and wire-visible names — all are
	 *      rendered into the prompt body (see `system-prompt.md` `{{label}}: \`{{name}}\``
	 *      and `toolPromptNames` in `buildSystemPrompt`). The wire name comes from
	 *      `tool.customWireName` and overrides the internal name on the model wire
	 *      (e.g. `edit` exposes itself as `apply_patch` to GPT-5 in apply_patch mode);
	 *      a stale wire name would desync prompt guidance from actual tool routing.
	 *   3. The bounded mounted-MCP projection: escaped original-name labels,
	 *      actual `xd://` paths, and the omission flag in catalog order. These are
	 *      the exact values rendered by the global transport guidance; catalog
	 *      churn wholly behind the fallback does not change the prompt.
	 *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
	 *      embeds these in the appended prompt under "## MCP Server Instructions".
	 *      A server upgrade can change instructions while keeping tools identical.
	 *
	 * Settings-driven tool metadata is covered automatically: built-in tools that
	 * depend on settings expose `description`/`label` via getters (see `TaskTool`,
	 * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
	 * call - so a settings flip that mutates the rendered string differs the signature
	 * the next time {@link applyActiveToolsByName} runs. Do not refactor `describeTool`
	 * to cache per-tool strings without preserving this property.
	 *
	 * Inputs NOT covered: tool input schemas; memory instructions read from disk;
	 * and SDK-init-time closure constants in `sdk.ts` (`inlineToolDescriptors`,
	 * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`, `secretsEnabled`). The
	 * closure-captured ones cannot change at runtime regardless of skip behavior.
	 * For everything else, callers must explicitly call {@link refreshBaseSystemPrompt}
	 * after side-effecting changes; see the memory hooks and {@link syncAfterModelChange}.
	 *
	 * The current calendar date IS covered (appended as a segment) because
	 * `buildSystemPrompt` injects it into the prompt body (`Today is '{{date}}'`).
	 * Without this, a session spanning midnight with only tool-stable MCP
	 * reconnects would keep yesterday's date indefinitely.
	 */
	#computeAppliedToolSignature(
		toolNames: string[],
		tools: AgentTool[],
		xdevRouteSources: readonly MountedMCPToolRouteSource[] = this.#xdev ? listXdevTools(this.#xdev) : [],
	): string {
		// Order-preserving join: any reorder must produce a different signature so
		// the rebuild fires and the new tool list reaches the API.
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		const mountedMCPProjection = projectMountedMCPXdevGuidance(collectMountedMCPToolRoutes(xdevRouteSources));
		const mountedMCPRouteSegment =
			JSON.stringify({
				mappings: mountedMCPProjection.mappings.map(mapping => [mapping.label, mapping.path] as const),
				hasOmittedMappings: mountedMCPProjection.hasOmittedMappings,
			}) ?? "{}";
		const serverInstructions = this.#getMcpServerInstructions?.();
		let instructionsSegment = "";
		if (serverInstructions && serverInstructions.size > 0) {
			// Sort by server name so transport flap order does not perturb the signature.
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			entries.sort();
			instructionsSegment = entries.join("\u0006");
		}
		// The non-MCP remainder of the xd:// inventory is deliberately NOT part
		// of the signature: its mount/unmount announces itself through
		// `#notifyXdevMountDelta` rather than rewriting the system prompt, keeping
		// the provider cache prefix byte-stable. Mounted MCP routes are the narrow
		// exception above, bounded to the exact projection rendered in the global
		// route guidance so churn wholly behind its fallback does not rebuild.
		const date = this.#getLocalCalendarDate();
		return `${nameSegment}\u0003${descriptionSegment}\u0007${instructionsSegment}\u0008${mountedMCPRouteSegment}|${date}`;
	}

	/**
	 * Replace MCP tools in the registry. When discovery is active, retain only
	 * the session's selected MCP tools; otherwise expose every connected tool.
	 * Refreshes are serialized so an older asynchronous prompt rebuild cannot
	 * commit after a newer catalog snapshot.
	 */
	refreshMCPTools(mcpTools: CustomTool[], options?: { activateAll?: boolean }): Promise<void> {
		const snapshot = [...mcpTools];
		return this.runToolRegistryMutation(() =>
			this.#host.isDisposed() ? Promise.resolve() : this.#applyMCPToolRefresh(snapshot, options),
		);
	}

	async #applyMCPToolRefresh(mcpTools: CustomTool[], options?: { activateAll?: boolean }): Promise<void> {
		await this.#runMCPToolMutation(async () => {
			const existingNames = Array.from(this.#toolRegistry.keys());
			const previousMcpTools = new Map(
				existingNames.flatMap(name => {
					const tool = this.#toolRegistry.get(name);
					return isMCPToolName(name) && tool ? [[name, tool] as const] : [];
				}),
			);
			const previousEnabledMCPToolNames = new Set(this.getEnabledToolNames().filter(isMCPToolName));
			const previouslyAllEnabled =
				previousMcpTools.size > 0
					? [...previousMcpTools.keys()].every(name => previousEnabledMCPToolNames.has(name))
					: !this.#hasExplicitMCPToolSelection;
			const previousMcpManagerToolNames = new Set(this.#mcpManagerToolNames);
			const restorePreviousMcpTools = () => {
				for (const name of this.#toolRegistry.keys()) {
					if (isMCPToolName(name)) this.#toolRegistry.delete(name);
				}
				for (const [name, tool] of previousMcpTools) this.#toolRegistry.set(name, tool);
				this.#mcpManagerToolNames = previousMcpManagerToolNames;
			};

			const getCustomToolContext = (): CustomToolContext => ({
				sessionManager: this.#host.sessionManager,
				modelRegistry: this.#host.modelRegistry,
				model: this.#host.model(),
				isIdle: () => !this.#host.isStreaming(),
				hasQueuedMessages: () => this.#host.queuedMessageCount() > 0,
				abort: () => {
					this.#host.agent.abort();
				},
				settings: this.#host.settings,
				localProtocolOptions: this.#host.localProtocolOptions(),
			});

			const extensionRunner = this.#host.extensionRunner();
			const uniqueMcpTools = deduplicateMCPToolsByName(mcpTools);
			const managerTools = uniqueMcpTools.map(customTool => {
				const wrapped = wrapToolWithMetaNotice(
					CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool,
				);
				return (extensionRunner ? new ExtensionToolWrapper(wrapped, extensionRunner) : wrapped) as AgentTool;
			});
			const managerToolSet = new Set(managerTools);
			const reconciledTools = deduplicateMCPToolsByName([...this.#extensionMcpTools.values(), ...managerTools]);

			for (const name of this.#toolRegistry.keys()) {
				if (isMCPToolName(name)) this.#toolRegistry.delete(name);
			}
			this.#mcpManagerToolNames.clear();
			for (const tool of reconciledTools) {
				this.#toolRegistry.set(tool.name, tool);
				if (managerToolSet.has(tool)) this.#mcpManagerToolNames.add(tool.name);
			}
			const availableMcpToolNames = new Set(
				reconciledTools.filter(tool => this.#isRequestedToolAllowed(tool.name)).map(tool => tool.name),
			);
			const priorSelection = new Set(
				[...this.#selectedMCPToolNames].filter(name => availableMcpToolNames.has(name)),
			);
			// Explicit non-discovery allowlists are applied directly to the agent
			// and therefore may not have populated #selectedMCPToolNames yet.
			// Keep manager tools that were active across the catalog replacement.
			const priorActiveManagerSelection = new Set(
				[...previousEnabledMCPToolNames].filter(
					name => previousMcpManagerToolNames.has(name) && availableMcpToolNames.has(name),
				),
			);
			const defaultMcpToolNames = this.#defaultMCPToolNames(reconciledTools).filter(name =>
				availableMcpToolNames.has(name),
			);
			// A manager refresh replaces the catalog, not the user's selection.
			// Newly connected tools become discoverable; they are activated only by
			// an explicit selection, configured default, or the caller's activateAll
			// contract (ACP/direct non-discovery sessions).
			const nextSelection = this.#hasExplicitMCPToolSelection
				? new Set([...priorSelection, ...priorActiveManagerSelection])
				: new Set([...priorSelection, ...priorActiveManagerSelection, ...defaultMcpToolNames]);
			const activateAll =
				options?.activateAll ??
				((!this.#mcpDiscoveryEnabled && previouslyAllEnabled) || (previousMcpTools.size === 0 && !this.#mcpEnabled));
			const retainedActiveExtensionToolNames = [...previousEnabledMCPToolNames].filter(
				name => this.#extensionMcpTools.has(name) && this.#toolRegistry.has(name),
			);
			const nextMCPToolNames = activateAll
				? [...availableMcpToolNames]
				: reconciledTools
						.filter(tool => availableMcpToolNames.has(tool.name) && nextSelection.has(tool.name))
						.map(tool => tool.name);
			const nextActive = [
				...new Set([...this.#getActiveNonMCPToolNames(), ...nextMCPToolNames, ...retainedActiveExtensionToolNames]),
			];
			const nextHasExplicitSelection =
				this.#hasExplicitMCPToolSelection || activateAll || defaultMcpToolNames.length > 0;
			const previousHasExplicitSelection = this.#hasExplicitMCPToolSelection;
			const committedSelection = activateAll ? new Set(nextMCPToolNames) : nextSelection;
			try {
				await this.#applyActiveToolsByName(nextActive);
				if (this.#host.isDisposed()) {
					restorePreviousMcpTools();
					return;
				}
			} catch (error) {
				restorePreviousMcpTools();
				throw error;
			}

			this.#selectedMCPToolNames = committedSelection;
			this.#hasExplicitMCPToolSelection = nextHasExplicitSelection;
			if (this.#mcpDiscoveryEnabled && (previousHasExplicitSelection || this.#hasExplicitMCPToolSelection)) {
				this.#host.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames());
			}
			this.#discoverableToolSearchIndex = undefined;
			this.#rememberSessionDefaultSelectedMCPToolNames(this.#host.sessionManager.getSessionFile(), nextMCPToolNames);
		});
	}

	/** Replaces RPC host-owned tools and refreshes the active set before the next model call. */
	refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const snapshot = [...rpcTools];
		return this.runToolRegistryMutation(() => this.#applyRpcHostToolRefresh(snapshot));
	}

	async #applyRpcHostToolRefresh(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getEnabledToolNames();
		const previousRpcHostTools = new Map(
			[...previousRpcHostToolNames].flatMap(name => {
				const tool = this.#toolRegistry.get(name);
				return tool ? [[name, tool] as const] : [];
			}),
		);
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		const extensionRunner = this.#host.extensionRunner();
		for (const tool of rpcTools) {
			const metaWrapped = wrapToolWithMetaNotice(tool);
			const finalTool = (
				extensionRunner ? new ExtensionToolWrapper(metaWrapped, extensionRunner) : metaWrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		try {
			await this.#applyActiveToolsByName(
				Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
			);
		} catch (error) {
			for (const name of this.#rpcHostToolNames) this.#toolRegistry.delete(name);
			this.#rpcHostToolNames = previousRpcHostToolNames;
			for (const [name, tool] of previousRpcHostTools) this.#toolRegistry.set(name, tool);
			throw error;
		}
	}
}
