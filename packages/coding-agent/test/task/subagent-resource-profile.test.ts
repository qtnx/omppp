import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { parseAgentFields } from "../../src/discovery/helpers";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { Skill } from "../../src/extensibility/skills";
import { MCPManager } from "../../src/mcp/manager";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { TaskTool } from "../../src/task";
import { getBundledAgent } from "../../src/task/agents";
import * as discoveryModule from "../../src/task/discovery";
import type { ExecutorOptions } from "../../src/task/executor";
import * as taskExecutor from "../../src/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { EventBus } from "../../src/utils/event-bus";

type CapturedCustomMessage = Parameters<AgentSession["sendCustomMessage"]>[0];

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

function createYieldingSession(onCustomMessage?: (message: CapturedCustomMessage) => void): AgentSession {
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
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		sendCustomMessage: async (message: CapturedCustomMessage) => {
			onCustomMessage?.(message);
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			state.messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
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

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function createModelRegistry(): ModelRegistry {
	return {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () => [],
		getApiKey: async () => null,
	} as unknown as ModelRegistry;
}

function createSkill(name: string): Skill {
	return {
		name,
		description: `${name} skill`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source: "user",
	};
}

function originalMcpToolName(toolName: string): string {
	const parts = toolName.split("__");
	return parts[parts.length - 1] ?? toolName;
}

function createMcpManager(toolNames: string[]): MCPManager {
	return {
		getTools: () =>
			toolNames.map(name => ({
				name,
				label: name,
				description: `${name} tool`,
				parameters: {},
				mcpServerName: "server",
				mcpToolName: originalMcpToolName(name),
			})),
	} as unknown as MCPManager;
}

function createResult(options: ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

function createToolSession(skills: Skill[], sessionFile: string | null = null, mcpManager?: MCPManager): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		enableLsp: false,
		skills,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
		}),
		modelRegistry: createModelRegistry(),
		getSessionFile: () => sessionFile,
		mcpManager,
		getSessionSpawns: () => "*",
		getCompactContext: () => "compact parent context",
	} as unknown as ToolSession;
}

describe("subagent resource profile", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		MCPManager.resetForTests();
	});

	it("does not inject IRC into restricted subagents unless the agent requests it", async () => {
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions = options;
			return createSessionResult(createYieldingSession());
		});

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: {
				name: "explore",
				description: "Read-only scout",
				systemPrompt: "Investigate read-only.",
				tools: ["read", "search"],
				resourceProfile: "minimal",
				source: "bundled",
			},
			task: "inspect",
			index: 0,
			id: "Explore",
			settings: Settings.isolated({ "irc.enabled": true }),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
		});

		expect(capturedOptions?.toolNames).toEqual(["read", "search"]);
	});

	it("runs the bundled explore agent on a bounded tool surface without Context GC", async () => {
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions = options;
			return createSessionResult(createYieldingSession());
		});

		const explore = getBundledAgent("explore");
		if (!explore) throw new Error("Expected bundled explore agent");

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: explore,
			task: "inspect",
			index: 0,
			id: "Explore",
			settings: Settings.isolated(),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
			mcpManager: createMcpManager(["mcp__server__context_debug"]),
		});

		expect(capturedOptions?.toolNames).toEqual(["read", "search", "find", "bash", "yield"]);
		expect(capturedOptions?.toolNames).not.toContain("web_search");
		expect(capturedOptions?.toolNames).not.toContain("context_debug");
		expect(capturedOptions?.minimalExtensionRuntime).toBe(true);
		expect(capturedOptions?.respectToolNamesForCustomTools).toBe(true);
		expect(capturedOptions?.enableMCP).toBe(false);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools ?? []).toEqual([]);
	});

	it("preserves IRC for unrestricted and explicit-IRC subagents", async () => {
		const capturedToolNames: Array<string[] | undefined> = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedToolNames.push(options.toolNames);
			return createSessionResult(createYieldingSession());
		});

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: {
				name: "general",
				description: "General agent",
				systemPrompt: "Use normal tools.",
				source: "bundled",
			},
			task: "inspect",
			index: 0,
			id: "General",
			settings: Settings.isolated({ "irc.enabled": true }),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
		});

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: {
				name: "coordinator",
				description: "Coordinator agent",
				systemPrompt: "Coordinate when useful.",
				tools: ["read", "irc"],
				source: "bundled",
			},
			task: "inspect",
			index: 1,
			id: "Coordinator",
			settings: Settings.isolated({ "irc.enabled": true }),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
		});

		expect(capturedToolNames).toEqual([undefined, ["read", "irc"]]);
	});

	it("does not use the minimal extension runtime for normal explicit-tool agents", async () => {
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions = options;
			return createSessionResult(createYieldingSession());
		});

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: {
				name: "reviewer",
				description: "General reviewer with explicit builtin tools",
				systemPrompt: "Review with normal agent runtime.",
				tools: ["read", "search", "report_finding"],
				source: "bundled",
			},
			task: "inspect",
			index: 0,
			id: "Reviewer",
			settings: Settings.isolated(),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
		});

		expect(capturedOptions?.minimalExtensionRuntime).toBe(false);
	});

	it("keeps agents without explicit tools on the default full tool surface", async () => {
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions = options;
			return createSessionResult(createYieldingSession());
		});
		const mcpManager = createMcpManager(["mcp__server__default"]);

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: {
				name: "default",
				description: "Default agent without explicit tools",
				systemPrompt: "This agent should inherit default tools.",
				resourceProfile: "minimal",
				source: "bundled",
			},
			task: "inspect",
			index: 0,
			id: "Default",
			settings: Settings.isolated({ "irc.enabled": true }),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
			mcpManager,
		});

		expect(capturedOptions?.toolNames).toBeUndefined();
		expect(capturedOptions?.minimalExtensionRuntime).toBe(false);
		expect(capturedOptions?.mcpManager).toBe(mcpManager);
		expect(
			capturedOptions?.customTools?.map(tool => ({
				name: tool.name,
				server: tool.mcpServerName,
				tool: tool.mcpToolName,
			})),
		).toEqual([{ name: "mcp__server__default", server: "server", tool: "default" }]);
	});

	it("does not treat an explicit empty tool list as the default full tool surface", async () => {
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions = options;
			return createSessionResult(createYieldingSession());
		});
		const parsedAgent = parseAgentFields({
			name: "empty-tools",
			description: "Explicit empty tools agent",
			tools: [],
			spawns: "*",
			resourceProfile: "minimal",
		});
		expect(parsedAgent?.tools).toEqual([]);

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: {
				...parsedAgent!,
				systemPrompt: "Do not inherit default tools.",
				source: "bundled",
			},
			task: "inspect",
			index: 0,
			id: "EmptyTools",
			settings: Settings.isolated({ "irc.enabled": true }),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
			mcpManager: createMcpManager(["mcp__server__default"]),
		});

		expect(capturedOptions?.toolNames).toEqual(["yield"]);
		expect(capturedOptions?.minimalExtensionRuntime).toBe(true);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools ?? []).toEqual([]);
	});

	it("keeps the subagent skill catalog limited to autoloaded skills", async () => {
		const runtimeSkill = createSkill("runtime-debugging");
		const unrelatedSkill = createSkill("unrelated-heavy-skill");
		const agent: AgentDefinition = {
			name: "explore",
			description: "Read-only scout",
			systemPrompt: "Investigate read-only.",
			tools: ["read"],
			autoloadSkills: [runtimeSkill.name],
			resourceProfile: "minimal",
			source: "bundled",
		};
		const params: TaskParams = {
			agent: agent.name,
			tasks: [{ id: "InspectRuntime", description: "Inspect runtime", assignment: "Find the issue." }],
		};

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => createResult(options));

		const tool = await TaskTool.create(createToolSession([runtimeSkill, unrelatedSkill]));
		await tool.execute("task-call", params);

		const options = runSpy.mock.calls[0]?.[0];
		expect(options?.skills?.map(skill => skill.name)).toEqual([runtimeSkill.name]);
		expect(options?.autoloadSkills?.map(skill => skill.name)).toEqual([runtimeSkill.name]);
		expect(options?.contextFiles?.[0]?.path).toBeString();
	});

	it("autoloads only filtered minimal-profile skills into the child session", async () => {
		using tempDir = TempDir.createSync("@omp-subagent-skills-");
		const runtimeSkillPath = path.join(tempDir.path(), "runtime-debugging", "SKILL.md");
		const unrelatedSkillPath = path.join(tempDir.path(), "unrelated-heavy-skill", "SKILL.md");
		await Bun.write(runtimeSkillPath, "---\nname: runtime-debugging\n---\nRuntime debugging instructions.");
		await Bun.write(unrelatedSkillPath, "---\nname: unrelated-heavy-skill\n---\nUnrelated heavy instructions.");
		const runtimeSkill: Skill = {
			...createSkill("runtime-debugging"),
			filePath: runtimeSkillPath,
			baseDir: path.dirname(runtimeSkillPath),
		};
		const unrelatedSkill: Skill = {
			...createSkill("unrelated-heavy-skill"),
			filePath: unrelatedSkillPath,
			baseDir: path.dirname(unrelatedSkillPath),
		};
		const agent: AgentDefinition = {
			name: "explore",
			description: "Read-only scout",
			systemPrompt: "Investigate read-only.",
			tools: ["read"],
			autoloadSkills: [runtimeSkill.name],
			resourceProfile: "minimal",
			source: "bundled",
		};
		const params: TaskParams = {
			agent: agent.name,
			tasks: [{ id: "InspectRuntime", description: "Inspect runtime", assignment: "Find the issue." }],
		};
		const customMessages: CapturedCustomMessage[] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions = options;
			return createSessionResult(createYieldingSession(message => customMessages.push(message)));
		});

		const tool = await TaskTool.create(createToolSession([runtimeSkill, unrelatedSkill]));
		await tool.execute("task-call", params);

		expect(capturedOptions?.skills?.map(skill => skill.name)).toEqual([runtimeSkill.name]);
		expect(customMessages.map(message => message.details)).toEqual([
			expect.objectContaining({ name: runtimeSkill.name, path: runtimeSkillPath }),
		]);
		expect(customMessages.map(message => message.content)).toEqual([
			expect.stringContaining("Runtime debugging instructions."),
		]);
	});

	it("preserves the parent skill catalog for unrestricted subagents", async () => {
		const runtimeSkill = createSkill("runtime-debugging");
		const planningSkill = createSkill("planning");
		const agent: AgentDefinition = {
			name: "general",
			description: "General scout",
			systemPrompt: "Investigate with normal tools.",
			source: "bundled",
		};
		const params: TaskParams = {
			agent: agent.name,
			tasks: [{ id: "InspectRuntime", description: "Inspect runtime", assignment: "Find the issue." }],
		};

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => createResult(options));

		const tool = await TaskTool.create(createToolSession([runtimeSkill, planningSkill]));
		await tool.execute("task-call", params);

		const options = runSpy.mock.calls[0]?.[0];
		expect(options?.skills?.map(skill => skill.name)).toEqual([runtimeSkill.name, planningSkill.name]);
		expect(options?.autoloadSkills).toEqual([]);
	});

	it("preserves the parent skill catalog for minimal-profile agents without explicit tools", async () => {
		const runtimeSkill = createSkill("runtime-debugging");
		const planningSkill = createSkill("planning");
		const agent: AgentDefinition = {
			name: "default",
			description: "Default agent",
			systemPrompt: "Use normal tools.",
			autoloadSkills: [runtimeSkill.name],
			resourceProfile: "minimal",
			source: "bundled",
		};
		const params: TaskParams = {
			agent: agent.name,
			tasks: [{ id: "InspectRuntime", description: "Inspect runtime", assignment: "Find the issue." }],
		};

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => createResult(options));

		const tool = await TaskTool.create(createToolSession([runtimeSkill, planningSkill]));
		await tool.execute("task-call", params);

		const options = runSpy.mock.calls[0]?.[0];
		expect(options?.skills?.map(skill => skill.name)).toEqual([runtimeSkill.name, planningSkill.name]);
		expect(options?.autoloadSkills?.map(skill => skill.name)).toEqual([runtimeSkill.name]);
	});

	it("filters the skill catalog for minimal-profile agents with explicit empty tools", async () => {
		const runtimeSkill = createSkill("runtime-debugging");
		const planningSkill = createSkill("planning");
		const agent: AgentDefinition = {
			name: "empty-tools",
			description: "Explicit empty tools agent",
			systemPrompt: "Do not inherit default tools.",
			tools: [],
			autoloadSkills: [runtimeSkill.name],
			resourceProfile: "minimal",
			source: "bundled",
		};
		const params: TaskParams = {
			agent: agent.name,
			tasks: [{ id: "InspectRuntime", description: "Inspect runtime", assignment: "Find the issue." }],
		};

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => createResult(options));

		const tool = await TaskTool.create(createToolSession([runtimeSkill, planningSkill]));
		await tool.execute("task-call", params);

		const options = runSpy.mock.calls[0]?.[0];
		expect(options?.skills?.map(skill => skill.name)).toEqual([runtimeSkill.name]);
		expect(options?.autoloadSkills?.map(skill => skill.name)).toEqual([runtimeSkill.name]);
	});

	it("preserves skills and extension runtime for explicit-tool agents without a minimal profile", async () => {
		const runtimeSkill = createSkill("runtime-debugging");
		const planningSkill = createSkill("planning");
		const agent: AgentDefinition = {
			name: "reviewer",
			description: "General reviewer with explicit builtin tools",
			systemPrompt: "Review with normal agent runtime.",
			tools: ["read", "search", "report_finding"],
			autoloadSkills: [runtimeSkill.name],
			source: "bundled",
		};
		const params: TaskParams = {
			agent: agent.name,
			tasks: [{ id: "ReviewRuntime", description: "Review runtime", assignment: "Review the issue." }],
		};

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => createResult(options));

		const tool = await TaskTool.create(createToolSession([runtimeSkill, planningSkill]));
		await tool.execute("task-call", params);

		const options = runSpy.mock.calls[0]?.[0];
		expect(options?.skills?.map(skill => skill.name)).toEqual([runtimeSkill.name, planningSkill.name]);
		expect(options?.autoloadSkills?.map(skill => skill.name)).toEqual([runtimeSkill.name]);
	});

	it("forwards the session-scoped MCP manager on the non-isolated task path", async () => {
		const mcpManager = { sentinel: "session-mcp" } as unknown as MCPManager;
		const agent: AgentDefinition = {
			name: "explore",
			description: "Read-only scout",
			systemPrompt: "Investigate read-only.",
			tools: ["read"],
			source: "bundled",
		};
		const params: TaskParams = {
			agent: agent.name,
			tasks: [{ id: "InspectRuntime", description: "Inspect runtime", assignment: "Find the issue." }],
		};

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => createResult(options));

		const tool = await TaskTool.create(createToolSession([], null, mcpManager));
		await tool.execute("task-call", params);

		expect(runSpy.mock.calls[0]?.[0].mcpManager).toBe(mcpManager);
	});

	it("does not fall back to a process-global MCP manager for subagents", async () => {
		const globalMcpManager = createMcpManager(["mcp__global__tool"]);
		MCPManager.setInstance(globalMcpManager);
		const agent: AgentDefinition = {
			name: "explore",
			description: "Read-only scout",
			systemPrompt: "Investigate read-only.",
			tools: ["read"],
			source: "bundled",
		};
		const params: TaskParams = {
			agent: agent.name,
			tasks: [{ id: "InspectRuntime", description: "Inspect runtime", assignment: "Find the issue." }],
		};

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => createResult(options));

		const tool = await TaskTool.create(createToolSession([]));
		await tool.execute("task-call", params);

		expect(runSpy.mock.calls[0]?.[0].mcpManager).toBeUndefined();
	});

	it("filters parent MCP proxy tools by the subagent tool whitelist", async () => {
		const capturedOptions: CreateAgentSessionOptions[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions.push(options);
			return createSessionResult(createYieldingSession());
		});
		const mcpManager = createMcpManager(["mcp__server__ipc", "mcp__server__allowed"]);

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: {
				name: "restricted",
				description: "Restricted scout",
				systemPrompt: "Investigate read-only.",
				tools: ["read"],
				resourceProfile: "minimal",
				source: "bundled",
			},
			task: "inspect",
			index: 0,
			id: "Restricted",
			settings: Settings.isolated(),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
			mcpManager,
		});

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: {
				name: "explicit",
				description: "Explicit MCP scout",
				systemPrompt: "Use one MCP tool.",
				tools: ["read", "mcp__server__allowed"],
				resourceProfile: "minimal",
				source: "bundled",
			},
			task: "inspect",
			index: 1,
			id: "Explicit",
			settings: Settings.isolated(),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
			mcpManager,
		});

		const restricted = capturedOptions[0];
		const explicit = capturedOptions[1];
		expect(restricted?.enableMCP).toBe(false);
		expect(restricted?.mcpManager).toBeUndefined();
		expect(restricted?.customTools?.map(tool => tool.name) ?? []).toEqual([]);
		expect(restricted?.respectToolNamesForCustomTools).toBe(true);
		expect(restricted?.minimalExtensionRuntime).toBe(true);
		expect(explicit?.enableMCP).toBe(false);
		expect(explicit?.mcpManager).toBeUndefined();
		expect(explicit?.customTools?.map(tool => tool.name)).toEqual(["mcp__server__allowed"]);
		expect(
			explicit?.customTools?.map(tool => ({ name: tool.name, server: tool.mcpServerName, tool: tool.mcpToolName })),
		).toEqual([{ name: "mcp__server__allowed", server: "server", tool: "allowed" }]);
		expect(explicit?.respectToolNamesForCustomTools).toBe(true);
		expect(explicit?.minimalExtensionRuntime).toBe(true);
	});

	it("reuses the parent MCP manager for unrestricted subagents without rediscovery", async () => {
		const capturedOptions: CreateAgentSessionOptions[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions.push(options);
			return createSessionResult(createYieldingSession());
		});
		const mcpManager = createMcpManager(["mcp__server__one", "mcp__server__two"]);

		await taskExecutor.runSubprocess({
			cwd: "/tmp",
			agent: {
				name: "general",
				description: "Unrestricted agent",
				systemPrompt: "Use normal tools.",
				source: "bundled",
			},
			task: "inspect",
			index: 0,
			id: "General",
			settings: Settings.isolated(),
			modelRegistry: createModelRegistry(),
			enableLsp: false,
			mcpManager,
		});

		const options = capturedOptions[0];
		expect(options?.enableMCP).toBe(false);
		expect(options?.mcpManager).toBe(mcpManager);
		expect(
			options?.customTools?.map(tool => ({ name: tool.name, server: tool.mcpServerName, tool: tool.mcpToolName })),
		).toEqual([
			{ name: "mcp__server__one", server: "server", tool: "one" },
			{ name: "mcp__server__two", server: "server", tool: "two" },
		]);
		expect(options?.respectToolNamesForCustomTools).toBe(true);
		expect(options?.minimalExtensionRuntime).toBe(false);
	});

	it("writes a distinct compact context file for each subagent in a batch", async () => {
		using tempDir = TempDir.createSync("@omp-subagent-context-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const agent: AgentDefinition = {
			name: "explore",
			description: "Read-only scout",
			systemPrompt: "Investigate read-only.",
			tools: ["read"],
			resourceProfile: "minimal",
			source: "bundled",
		};
		const params: TaskParams = {
			agent: agent.name,
			tasks: [
				{ id: "InspectRuntime", description: "Inspect runtime", assignment: "Find the runtime issue." },
				{ id: "InspectGateway", description: "Inspect gateway", assignment: "Find the gateway issue." },
			],
		};
		const contextFiles: string[] = [];

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			if (options.contextFiles?.[0]) contextFiles.push(options.contextFiles[0].path);
			return createResult(options);
		});

		const tool = await TaskTool.create(createToolSession([], sessionFile));
		await tool.execute("task-call", params);

		expect(contextFiles).toHaveLength(2);
		expect(new Set(contextFiles).size).toBe(2);
		for (const contextFile of contextFiles) {
			expect(await Bun.file(contextFile).text()).toBe("compact parent context");
		}
	});
});
