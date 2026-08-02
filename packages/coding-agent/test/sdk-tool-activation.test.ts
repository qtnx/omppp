import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import contextGcExtension from "@oh-my-pi/context-gc-plugin";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type CustomTool,
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { SYSTEM_CONTEXT_REMINDER_LABEL } from "@oh-my-pi/system-context-reminder-plugin";
import { type } from "arktype";
import { getBundledAgent } from "../src/task/agents";

const toolActivationExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "default_inactive_tool",
		label: "Default Inactive Tool",
		description: "Tool hidden from the initial active set unless explicitly requested.",
		parameters: type({}),
		defaultInactive: true,
		async execute() {
			return { content: [{ type: "text", text: "inactive" }] };
		},
	});
	pi.registerTool({
		name: "default_active_tool",
		label: "Default Active Tool",
		description: "Tool included in the initial active set.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "active" }] };
		},
	});
};

const systemContextReminderLabelOnlyExtension: ExtensionFactory = pi => {
	pi.setLabel(SYSTEM_CONTEXT_REMINDER_LABEL);
};
const sdkCustomTool = {
	name: "sdk_custom_tool",
	label: "SDK Custom Tool",
	description: "SDK-provided custom tool used to verify activation boundaries.",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text", text: "sdk custom" }] };
	},
} satisfies CustomTool;

describe("createAgentSession defaultInactive tool activation", () => {
	const tempDirs: string[] = [];

	// Built once and shared by every session. `ModelRegistry` eagerly loads all
	// bundled + cached models and `discoverAuthStorage` opens the auth DB — the
	// dominant (~50ms) slice of a cold boot, and identical for every test here.
	// Injecting it drops each per-test boot to the ~4ms of activation-specific work
	// these tests vary, and skips the background model refresh the SDK would
	// otherwise start when it builds its own registry.
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	// Shared options for every session. `rules: []` and `workspaceTree` short-circuit
	// the two slow startup scans (rule discovery + native workspace walk, ~100ms each)
	// that are irrelevant to tool activation: these tests assert only which tools are
	// registered/active and that tool names appear in the system prompt. The shared
	// `modelRegistry` is injected here; each call still returns fresh
	// `settings`/`sessionManager` instances to keep tests isolated.
	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "advisor.enabled": false }),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}

		vi.restoreAllMocks();
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	it("activates Codex-style goal tools by default while keeping the legacy goal tool hidden", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession(baseOptions(tempDir));

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["goal", "get_goal", "create_goal", "update_goal"]),
			);
			expect(session.getActiveToolNames()).toContain("get_goal");
			expect(session.getActiveToolNames()).toContain("create_goal");
			expect(session.getActiveToolNames()).toContain("update_goal");
			expect(session.getActiveToolNames()).not.toContain("goal");
		} finally {
			await session.dispose();
		}
	});
	it("excludes defaultInactive extension tools from the initial active set unless explicitly requested", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
		});

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["default_active_tool", "default_inactive_tool"]),
			);
			// Discoverable extension tools mount as xd:// devices, not top-level active tools.
			const deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			expect(deviceNames).toContain("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_active_tool");
			expect(deviceNames).not.toContain("default_inactive_tool");
			expect(session.getActiveToolNames()).not.toContain("default_inactive_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_active_tool");
		} finally {
			await session.dispose();
		}
	});

	it("enforces explicit toolNames when runtime activation tries to enable extension tools", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-whitelist-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [toolActivationExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			respectToolNamesForCustomTools: true,
		});

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["read", "default_active_tool", "default_inactive_tool"]),
			);
			expect(session.getActiveToolNames()).toContain("read");
			expect(session.getAllToolNames()).toContain("create_goal");
			expect(session.getActiveToolNames()).not.toContain("create_goal");
			expect(session.getActiveToolNames()).not.toContain("default_active_tool");

			await session.setActiveToolsByName([...session.getActiveToolNames(), "default_active_tool"]);

			expect(session.getActiveToolNames()).toContain("read");
			expect(session.getActiveToolNames()).not.toContain("default_active_tool");
		} finally {
			await session.dispose();
		}
	});
	it("forwards built-in and external xd:// devices to Cursor provider contexts", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			model: cursorModel,
		});
		const externalMcpTool: CustomTool = {
			name: "mcp__fixture_report",
			label: "fixture/report",
			description: "Report a fixture result.",
			parameters: type({}),
			strict: true,
			mcpServerName: "fixture",
			mcpToolName: "report",
			async execute() {
				return { content: [{ type: "text", text: "reported" }] };
			},
		};

		try {
			await session.refreshMCPTools([externalMcpTool], { activateAll: true });
			const deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			expect(deviceNames).toEqual(expect.arrayContaining(["ast_edit", "mcp__fixture_report"]));
			expect(session.getActiveToolNames()).not.toContain("mcp__fixture_report");

			const context = await session.agent.buildSideRequestContext([]);
			const providerToolNames = context.tools?.map(tool => tool.name);
			expect(providerToolNames).toEqual(expect.arrayContaining(["ast_edit", "mcp__fixture_report"]));
		} finally {
			await session.dispose();
		}
	});

	it("skips extension/runtime loading for minimal tool-surface sessions", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-minimal-runtime-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session, extensionsResult } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			extensions: [toolActivationExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			respectToolNamesForCustomTools: true,
			minimalExtensionRuntime: true,
		});

		try {
			expect(extensionsResult.extensions).toHaveLength(0);
			expect(session.getAllToolNames()).toContain("read");
			expect(session.getAllToolNames()).not.toContain("default_active_tool");
			expect(session.getAllToolNames()).not.toContain("context_debug");
			expect(session.systemPrompt.join("\n\n")).not.toContain("## System Context Reminder");
		} finally {
			await session.dispose();
		}
	});

	it("keeps bundled explore sessions on the effective bounded tool surface", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-explore-tools-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		const explore = getBundledAgent("explore");
		if (!explore) throw new Error("Expected bundled explore agent");

		const { session, extensionsResult } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "advisor.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			extensions: [toolActivationExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: explore.tools,
			respectToolNamesForCustomTools: true,
			minimalExtensionRuntime: explore.resourceProfile === "minimal",
		});

		try {
			const expectedToolNames = ["read", "grep", "glob", "bash", "web_search", "irc", "yield"];
			const contextGcToolNames = [
				"context_debug",
				"context_global_stats",
				"context_inventory",
				"context_pin",
				"context_recall",
				"context_stats",
				"context_tree",
				"context_unload",
			];
			expect(session.getActiveToolNames()).toEqual(expectedToolNames);
			for (const toolName of ["default_active_tool", ...contextGcToolNames]) {
				expect(session.getAllToolNames()).not.toContain(toolName);
				expect(session.getActiveToolNames()).not.toContain(toolName);
			}
			expect(extensionsResult.extensions).toHaveLength(0);
		} finally {
			await session.dispose();
		}
	});

	it("does not restore persisted MCP selections outside explicit toolNames", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-whitelist-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMCPToolSelection(["mcp__docs_search"]);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			respectToolNamesForCustomTools: true,
			customTools: [
				{
					name: "mcp__docs_search",
					label: "docs/search",
					description: "Search internal docs",
					parameters: type({ query: "string" }),
					mcpServerName: "docs",
					mcpToolName: "search",
					async execute() {
						return { content: [{ type: "text" as const, text: "docs" }] };
					},
				},
			],
		});

		try {
			expect(session.getAllToolNames()).toContain("mcp__docs_search");
			expect(session.getActiveToolNames()).toContain("read");
			expect(session.getActiveToolNames()).not.toContain("mcp__docs_search");
			expect(session.systemPrompt.join("\n")).not.toContain("mcp__docs_search");
		} finally {
			await session.dispose();
		}
	});

	it("loads context GC tools as native bundled extensions without plugin discovery", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-context-gc-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		const previousContextGcDbPath = process.env.OMP_CONTEXT_GC_DB_PATH;

		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			const contextGcToolNames = [
				"context_debug",
				"context_global_stats",
				"context_inventory",
				"context_pin",
				"context_recall",
				"context_stats",
				"context_tree",
				"context_unload",
			];
			expect(result.session.getAllToolNames()).toEqual(expect.arrayContaining(contextGcToolNames));
			expect(result.session.getActiveToolNames()).toEqual(expect.arrayContaining(contextGcToolNames));
			expect(result.extensionsResult.extensions.filter(extension => extension.label === "Context GC")).toHaveLength(
				1,
			);
			expect(fs.existsSync(path.join(tempDir, "context-gc.sqlite"))).toBe(true);
			expect(process.env.OMP_CONTEXT_GC_DB_PATH).toBe(previousContextGcDbPath);
		} finally {
			await result?.session.dispose();
		}
	});

	it("creates fresh agentDir layout before loading native bundled extensions", async () => {
		const root = path.join(os.tmpdir(), `pi-sdk-fresh-agent-dir-${Snowflake.next()}`);
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		tempDirs.push(root);
		fs.mkdirSync(cwd, { recursive: true });

		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			expect(result.session.getToolByName("context_inventory")).toBeDefined();
			expect(fs.existsSync(path.join(agentDir, "context-gc.sqlite"))).toBe(true);
			expect(fs.existsSync(path.join(agentDir, "workflows"))).toBe(true);
		} finally {
			await result?.session.dispose();
		}
	});
	it("loads system context reminder as a native bundled extension without plugin discovery", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-system-reminder-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			expect(
				result.extensionsResult.extensions.filter(extension => extension.label === SYSTEM_CONTEXT_REMINDER_LABEL),
			).toHaveLength(1);
			expect(result.session.systemPrompt.join("\n\n")).toContain("## System Context Reminder");
		} finally {
			await result?.session.dispose();
		}
	});

	it("does not double-load native system context reminder when supplied inline", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-system-reminder-inline-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				extensions: [systemContextReminderLabelOnlyExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			expect(
				result.extensionsResult.extensions.filter(extension => extension.label === SYSTEM_CONTEXT_REMINDER_LABEL),
			).toHaveLength(1);
			expect(result.session.systemPrompt.join("\n\n")).not.toContain("## System Context Reminder");
			const beforeResult = await result.session.extensionRunner?.emitBeforeAgentStart(
				"continue",
				undefined,
				result.session.systemPrompt,
			);
			expect((beforeResult?.systemPrompt ?? []).join("\n\n")).not.toContain("## System Context Reminder");
		} finally {
			await result?.session.dispose();
		}
	});

	it("does not double-load native context GC when supplied inline", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-context-gc-inline-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				extensions: [pi => contextGcExtension(pi)],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			expect(result.extensionsResult.extensions.filter(extension => extension.label === "Context GC")).toHaveLength(
				1,
			);
			expect(fs.existsSync(path.join(tempDir, "context-gc.sqlite"))).toBe(true);
		} finally {
			await result?.session.dispose();
		}
	});

	it("applies agentDir DB override before loading configured context GC extensions", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-context-gc-configured-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const configuredContextGcPath = path.resolve(import.meta.dir, "../../context-gc-plugin/src/extension.ts");
		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [configuredContextGcPath],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			expect(result.extensionsResult.extensions.filter(extension => extension.label === "Context GC")).toHaveLength(
				1,
			);
			expect(fs.existsSync(path.join(tempDir, "context-gc.sqlite"))).toBe(true);
		} finally {
			await result?.session.dispose();
		}
	});

	it("keeps context GC DB paths isolated across concurrent session creation", async () => {
		const root = path.join(os.tmpdir(), `pi-sdk-context-gc-concurrent-${Snowflake.next()}`);
		const agentDirA = path.join(root, "agent-a");
		const agentDirB = path.join(root, "agent-b");
		const cwdA = path.join(root, "cwd-a");
		const cwdB = path.join(root, "cwd-b");
		tempDirs.push(root);
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		const configuredContextGcPath = path.resolve(import.meta.dir, "../../context-gc-plugin/src/extension.ts");
		const previousContextGcDbPath = process.env.OMP_CONTEXT_GC_DB_PATH;

		const create = async (cwd: string, agentDir: string, agentId: string): Promise<CreateAgentSessionResult> =>
			await createAgentSession({
				agentId,
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [configuredContextGcPath],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

		let resultA: CreateAgentSessionResult | undefined;
		let resultB: CreateAgentSessionResult | undefined;
		try {
			[resultA, resultB] = await Promise.all([
				create(cwdA, agentDirA, "context-gc-a"),
				create(cwdB, agentDirB, "context-gc-b"),
			]);

			expect(fs.existsSync(path.join(agentDirA, "context-gc.sqlite"))).toBe(true);
			expect(fs.existsSync(path.join(agentDirB, "context-gc.sqlite"))).toBe(true);
			expect(process.env.OMP_CONTEXT_GC_DB_PATH).toBe(previousContextGcDbPath);
		} finally {
			await resultA?.session.dispose();
			await resultB?.session.dispose();
		}
	}, 20000);

	it("keeps sessions usable when native context GC storage cannot open", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-context-gc-bad-db-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(path.join(tempDir, "context-gc.sqlite"), { recursive: true });

		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			expect(result.session.getToolByName("read")).toBeDefined();
			expect(result.session.getToolByName("context_inventory")).toBeUndefined();
		} finally {
			await result?.session.dispose();
		}
	});
	it("allows explicitly requested defaultInactive extension tools into the initial active set", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
			toolNames: ["read", "default_inactive_tool"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "default_inactive_tool", "write"]),
			);
			expect(session.getActiveToolNames()).not.toContain("default_active_tool");
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("default_active_tool");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain("default_inactive_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("activates the yield tool when requireYieldTool is set and toolNames is explicit", async () => {
		// Regression for #1408: plan-mode subagents pass an explicit `toolNames` list
		// (e.g. `["read", "grep", "glob", "lsp", "web_search"]`). Without this
		// invariant, `yield` ended up registered but not active, and the model
		// could not satisfy the idle-reminder contract that demands a `yield` call.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			requireYieldTool: true,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("yield");
		} finally {
			await session.dispose();
		}
	});

	it("normalizes legacy builtin toolNames before selecting the active SDK tools", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "search", "find"],
		});

		try {
			const activeToolNames = session.getActiveToolNames();

			expect(activeToolNames).toContain("read");
			expect(activeToolNames).toContain("grep");
			expect(activeToolNames).toContain("glob");
			expect(activeToolNames).not.toContain("search");
			expect(activeToolNames).not.toContain("find");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the write tool registered for plan mode even when no deferrable tool is requested", async () => {
		// Regression for #1428 (adapted to the xd://propose device): plan mode
		// submits its finalized plan by writing the chosen slug/title to
		// xd://propose, dispatched through the plan-proposal handler
		// (interactive-mode.ts: `setPlanProposalHandler`). With an explicit
		// read-only `toolNames` (e.g. `read`, `search`, `find`, `web_search`)
		// the registry has no `write` and no `deferrable` tool; dropping it would
		// silently activate plan mode with no way to submit the plan.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("write")).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not force write into the registry when neither a deferrable tool nor plan mode needs it", async () => {
		const tempDir = makeTempDir();

		const settings = Settings.isolated();
		settings.set("plan.enabled", false);

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("write")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not activate write merely because plan mode is available", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read"],
		});

		try {
			await session.setActiveToolsByName(["read"]);
			expect(session.getActiveToolNames()).not.toContain("write");
		} finally {
			await session.dispose();
		}
	});

	it("preserves write explicitly selected by a runtime caller", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read"],
		});

		try {
			await session.setActiveToolsByName(["read", "write"]);
			await session.refreshMCPTools([]);
			expect(session.getActiveToolNames()).toContain("write");
		} finally {
			await session.dispose();
		}
	});
	it("registers vibe tools only during explicit vibe activation", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));
		const previousActiveToolNames = session.getActiveToolNames();

		try {
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}

			await session.activateVibeTools(["read"]);
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeDefined();
				expect(session.getActiveToolNames()).toContain(name);
			}

			await session.deactivateVibeTools(previousActiveToolNames);
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}
			expect(session.getActiveToolNames()).toEqual(previousActiveToolNames);
		} finally {
			await session.dispose();
		}
	});

	it("does not register the xAI TTS tool unless enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
		});

		try {
			expect(session.getToolByName("tts")).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("registers the xAI TTS tool when enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "speechgen.enabled": true }),
		});

		try {
			expect(session.getToolByName("tts")).toBeDefined();
			// tts is a discoverable custom tool → mounted as an xd:// device, not top-level.
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	// `generate_image` is a custom tool gated only by its setting and the tool
	// whitelist — never by the session's provider/model family. Non-OpenAI
	// sessions must still register and activate it.
	for (const [provider, modelId] of [
		["anthropic", "claude-sonnet-4-5"],
		["google", "gemini-2.5-pro"],
	] as const) {
		it(`registers generate_image on a non-OpenAI session model (${provider}/${modelId})`, async () => {
			const model = getBundledModel(provider, modelId);
			expect(model).toBeDefined();

			const { session } = await createAgentSession({
				...baseOptions(makeTempDir()),
				model,
				settings: Settings.isolated({ "advisor.enabled": false, "generate_image.enabled": true }),
				toolNames: ["read", "generate_image"],
			});

			try {
				expect(session.getToolByName("generate_image")).toBeDefined();
				expect(session.getActiveToolNames()).toContain("generate_image");
			} finally {
				await session.dispose();
			}
		});
	}

	it("keeps restricted host tool lists isolated from configured custom capabilities", async () => {
		const restrictedDir = makeTempDir();
		const normalDir = makeTempDir();
		const configuredSettings = () =>
			Settings.isolated({
				"providers.imageOrder": ["openai"],
				"generate_image.enabled": true,
				"speechgen.enabled": true,
				"memory.backend": "hindsight",
				"autolearn.enabled": true,
			});

		const inheritedManager = {
			getServerInstructions: () => new Map([["private-server", "must not reach restricted child"]]),
		} as unknown as MCPManager;

		const { session: restricted } = await createAgentSession({
			...baseOptions(restrictedDir),
			settings: configuredSettings(),
			extensions: [toolActivationExtension],
			customTools: [sdkCustomTool],
			toolNames: ["read", "lsp", "hub"],
			requireYieldTool: true,
			restrictToolNames: true,
			enableMCP: true,
			mcpManager: inheritedManager,
			enableLsp: true,
			enableIrc: true,
		});

		try {
			expect(restricted.getAllToolNames()).toEqual(["read", "lsp", "hub", "yield"]);
			expect(restricted.getActiveToolNames()).toEqual(["read", "lsp", "hub", "yield"]);
			for (const name of [
				"generate_image",
				"tts",
				"recall",
				"retain",
				"reflect",
				"learn",
				"manage_skill",
				"default_active_tool",
				"default_inactive_tool",
				"sdk_custom_tool",
				"consult",
			]) {
				expect(restricted.getToolByName(name)).toBeUndefined();
			}
			expect(restricted.getXdevToolEntries()).toEqual([]);
			expect(restricted.systemPrompt.join("\n")).not.toContain("private-server");
			expect(restricted.systemPrompt.join("\n")).not.toContain("MCP Server Instructions");
		} finally {
			await restricted.dispose();
		}

		const { session: normal } = await createAgentSession({
			...baseOptions(normalDir),
			settings: configuredSettings(),
			extensions: [toolActivationExtension],
			customTools: [sdkCustomTool],
			toolNames: ["read", "generate_image"],
			requireYieldTool: true,
			restrictToolNames: false,
		});

		try {
			const activeToolNames = normal.getActiveToolNames();
			expect(activeToolNames).toEqual(
				expect.arrayContaining(["read", "yield", "generate_image", "learn", "manage_skill", "write"]),
			);
			for (const name of ["tts", "default_active_tool", "sdk_custom_tool"]) {
				expect(activeToolNames).not.toContain(name);
			}
			expect(normal.getXdevToolEntries().map(entry => entry.name)).toEqual(
				expect.arrayContaining(["tts", "default_active_tool", "sdk_custom_tool"]),
			);
			expect(normal.getAllToolNames()).toEqual(
				expect.arrayContaining([
					"generate_image",
					"read",
					"yield",
					"tts",
					"default_active_tool",
					"sdk_custom_tool",
					"recall",
					"retain",
					"reflect",
				]),
			);
		} finally {
			await normal.dispose();
		}
	});

	it("ignores an inherited MCP manager when MCP is disabled", async () => {
		const tempDir = makeTempDir();
		const inheritedManager = {
			getServerInstructions: () => new Map([["private-server", "must not reach restricted child"]]),
		} as unknown as MCPManager;

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			enableMCP: false,
			mcpManager: inheritedManager,
		});

		try {
			expect(session.systemPrompt.join("\n")).not.toContain("private-server");
			expect(session.systemPrompt.join("\n")).not.toContain("MCP Server Instructions");
		} finally {
			await session.dispose();
		}
	});
});
