import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function smallContextModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock-small",
		name: "mock-small",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function basicTool(name: string, loadMode?: "essential" | "discoverable"): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		...(loadMode ? { loadMode } : {}),
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as AgentTool;
}

function mcpTool(name: string, server: string, toolName: string): AgentTool {
	return {
		name,
		label: `${server}/${toolName}`,
		description: `${toolName} tool`,
		parameters: type({ query: "string" }),
		strict: true,
		mcpServerName: server,
		mcpToolName: toolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as AgentTool;
}

describe("AgentSession tool-discovery mode reconcile", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	// ── Blocker 1: discovery resolved off must hide / block search_tool_bm25 ──

	it("hides search_tool_bm25 from the registry listing and blocks activation when discovery is off", async () => {
		const readTool = basicTool("read");
		const searchTool = basicTool("search_tool_bm25", "essential");
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[searchTool.name, searchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: smallContextModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"advisor.consult": false,
				"advisor.enabled": false,
				"tools.discoveryMode": "off",
			}),
			modelRegistry: {} as never,
			toolRegistry,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		expect(session.isToolDiscoveryEnabled()).toBe(false);
		// Public registry surface must not leak the discovery tool while off,
		// even though it stays registered for a later re-enable.
		expect(session.getAllToolNames()).toContain("read");
		expect(session.getAllToolNames()).not.toContain("search_tool_bm25");
		expect(session.getToolByName("search_tool_bm25")).toBeDefined();

		// Activation surface must refuse to activate it while off.
		await session.setActiveToolsByName(["read", "search_tool_bm25"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("exposes and activates search_tool_bm25 while discovery is on", async () => {
		const readTool = basicTool("read");
		const searchTool = basicTool("search_tool_bm25", "essential");
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[searchTool.name, searchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: smallContextModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"advisor.consult": false,
				"advisor.enabled": false,
				"tools.discoveryMode": "all",
			}),
			modelRegistry: {} as never,
			toolRegistry,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		expect(session.isToolDiscoveryEnabled()).toBe(true);
		expect(session.getAllToolNames()).toContain("search_tool_bm25");

		await session.setActiveToolsByName(["read", "search_tool_bm25"]);
		expect(session.getActiveToolNames()).toContain("search_tool_bm25");
	});

	// ── Blocker 2: leaving discovery for off restores allowed MCP tools ──

	describe("discovery setting all -> off", () => {
		let sharedDir: TempDir;
		let authStorage: AuthStorage;
		let registry: ModelRegistry;

		beforeAll(async () => {
			sharedDir = TempDir.createSync("@pi-discovery-reconcile-");
			authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
			authStorage.setRuntimeApiKey("openai", "test-key");
			registry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
		});

		afterAll(() => {
			authStorage.close();
			sharedDir.removeSync();
		});

		it("restores allowed MCP tools and drops search_tool_bm25 when discovery resolves to off", async () => {
			const smallModel = getBundledModel("openai", "gpt-4o-mini") as Model<Api>;
			expect(smallModel).toBeDefined();
			const settings = Settings.isolated({ "tools.discoveryMode": "all" });

			const readTool = basicTool("read");
			const searchTool = basicTool("search_tool_bm25", "essential");
			const docsTool = mcpTool("mcp__docs_search", "docs", "search");
			const slackTool = mcpTool("mcp__slack_send_message", "slack", "send_message");
			const toolRegistry = new Map([
				[readTool.name, readTool],
				[searchTool.name, searchTool],
				[docsTool.name, docsTool],
				[slackTool.name, slackTool],
			]);

			// Simulate an active "all"-mode set: builtin + discovery tool + the one
			// MCP tool the model selected via discovery (slack stays discoverable).
			const agent = new Agent({
				initialState: {
					model: smallModel,
					systemPrompt: ["initial"],
					tools: [readTool, searchTool, docsTool],
					messages: [],
				},
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: registry,
				toolRegistry,
				mcpDiscoveryEnabled: true,
				initialSelectedMCPToolNames: ["mcp__docs_search"],
				rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
			});
			sessions.push(session);

			expect(session.isToolDiscoveryEnabled()).toBe(true);

			settings.override("tools.discoveryMode", "off");
			await session.setModelTemporary(smallModel);

			expect(session.isToolDiscoveryEnabled()).toBe(false);
			// The discovery tool is stripped, but every allowed MCP tool is now
			// active (mirroring an initial discovery-off session). The previously
			// active MCP tool must not disappear.
			expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
			expect(session.getAllToolNames()).not.toContain("search_tool_bm25");
		});
	});
});
