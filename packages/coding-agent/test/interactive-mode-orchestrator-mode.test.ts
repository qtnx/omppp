import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { ModelRegistry } from "../src/config/model-registry";
import type { Goal } from "../src/goals/state";
import { InteractiveMode } from "../src/modes/interactive-mode";
import type { OrchestratorModeState } from "../src/orchestrator-mode/state";
import orchestratorModeActivePrompt from "../src/prompts/system/orchestrator-mode-active.md" with { type: "text" };
import type { BuiltinToolLoadMode } from "../src/tools";
import { OrchestratorModeTool } from "../src/tools/orchestrator-mode";

function makeTool(name: string, loadMode?: BuiltinToolLoadMode): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		...(loadMode ? { loadMode } : {}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

const ORCHESTRATOR_CONTROL_TOOLS = ["orchestrator_mode"] as const;

const SAFE_ORCHESTRATOR_TOOLS = [
	"task",
	"todo",
	"workflow",
	"job",
	"irc",
	"read",
	"grep",
	"glob",
	"lsp",
	"web_search",
	"search_tool_bm25",
] as const;

const NON_ESSENTIAL_ORCHESTRATOR_TOOLS = ["job", "task", "workflow", "irc", "web_search", "grep", "lsp"] as const;

const MARKDOWN_WRITE_TOOLS = ["write", "edit"] as const;
const DIRECT_TOOLS = ["bash", "eval"] as const;

interface HarnessOptions {
	registryToolNames?: readonly string[];
	activeToolNames?: readonly string[];
	registryToolLoadModes?: Partial<Record<string, BuiltinToolLoadMode>>;
	autoQa?: boolean;
	systemPrompt?: readonly string[];
	initialContextWindow?: number;
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	const now = Date.now();
	return {
		id: "goal-1",
		objective: "orchestrate safely",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("InteractiveMode orchestrator mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-orchestrator-mode-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		authStorage = undefined as unknown as AuthStorage;
		tempDir = undefined as unknown as TempDir;
		resetSettingsForTest();
	});

	function modelOrThrow(registry: ModelRegistry, id: string): Model<Api> {
		const model = registry.find("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function writeSessionFile(name: string, entries: Array<Record<string, unknown>>): Promise<string> {
		const sessionFile = path.join(tempDir.path(), `${name}-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[{ type: "session", version: 3, id: `${name}-session`, timestamp, cwd: tempDir.path() }, ...entries]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return sessionFile;
	}

	async function writeGoalModeSession(
		name: string,
		modeName: "goal" | "goal_paused",
		goal: Goal,
		options: { orchestrator?: boolean } = {},
	): Promise<string> {
		const timestamp = "2026-06-01T00:00:00.000Z";
		return await writeSessionFile(name, [
			{
				type: "mode_change",
				id: `${name}-${modeName}`,
				parentId: null,
				timestamp,
				mode: modeName,
				data: { goal, orchestrator: options.orchestrator === true },
			},
		]);
	}

	function createHarnessWithManager(manager: SessionManager, options: HarnessOptions = {}): InteractiveMode {
		void OrchestratorModeTool;
		const _stateContract: OrchestratorModeState | undefined = undefined;
		void _stateContract;

		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
		const bundledInitialModel = modelOrThrow(registry, "claude-sonnet-4-5");
		const initialModel =
			options.initialContextWindow === undefined
				? bundledInitialModel
				: { ...bundledInitialModel, contextWindow: options.initialContextWindow };
		const registryToolNames = options.registryToolNames ?? ["read"];
		const activeToolNames = options.activeToolNames ?? ["read"];
		const toolsByName = new Map(
			registryToolNames.map(name => [name, makeTool(name, options.registryToolLoadModes?.[name])] as const),
		);
		for (const name of activeToolNames) {
			if (!toolsByName.has(name)) toolsByName.set(name, makeTool(name, options.registryToolLoadModes?.[name]));
		}
		const initialTools = activeToolNames.map(name => {
			const tool = toolsByName.get(name);
			if (!tool) throw new Error(`Missing active tool ${name}`);
			return tool;
		});
		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: options.systemPrompt ? [...options.systemPrompt] : ["Test"],
					tools: initialTools,
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "dev.autoqa": options.autoQa ?? false }),
			modelRegistry: registry,
			toolRegistry: toolsByName,
			builtInToolNames: Array.from(toolsByName.keys()),
		});
		session = createdSession;
		mode = new InteractiveMode(createdSession, "test");
		return mode;
	}

	function createHarness(options: HarnessOptions = {}): InteractiveMode {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		return createHarnessWithManager(manager, options);
	}

	async function createResumeHarness(sessionFile: string, options: HarnessOptions = {}): Promise<InteractiveMode> {
		const manager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"));
		return createHarnessWithManager(manager, options);
	}

	it("restores active goal and orchestrator together from a goal mode session with orchestrator data", async () => {
		const goal = makeGoal();
		const sessionFile = await writeGoalModeSession("active-goal-orchestrator", "goal", goal, { orchestrator: true });
		const created = await createResumeHarness(sessionFile, {
			registryToolNames: ["read", "goal", ...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
		});

		await created.init({ suppressWelcomeIntro: true });

		expect(created.goalModeEnabled).toBe(true);
		expect(created.goalModePaused).toBe(false);
		expect(created.orchestratorModeEnabled).toBe(true);
		expect(session?.getGoalModeState()).toMatchObject({
			enabled: true,
			goal: { id: goal.id, objective: goal.objective, status: "active" },
		});
		expect(session?.getOrchestratorModeState()).toEqual({ enabled: true });
		expect(session?.getActiveToolNames()).toEqual([
			...ORCHESTRATOR_CONTROL_TOOLS,
			...SAFE_ORCHESTRATOR_TOOLS,
			"goal",
		]);
	});

	it("keeps a paused goal paused without restoring orchestrator from orchestrator data", async () => {
		const goal = makeGoal({ status: "paused" });
		const sessionFile = await writeGoalModeSession("paused-goal-orchestrator", "goal_paused", goal, {
			orchestrator: true,
		});
		const created = await createResumeHarness(sessionFile, {
			registryToolNames: ["read", "goal", ...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
		});

		await created.init({ suppressWelcomeIntro: true });

		expect(created.goalModeEnabled).toBe(false);
		expect(created.goalModePaused).toBe(true);
		expect(created.orchestratorModeEnabled).toBe(false);
		expect(session?.getGoalModeState()).toMatchObject({
			enabled: false,
			goal: { id: goal.id, objective: goal.objective, status: "paused" },
		});
		expect(session?.getOrchestratorModeState()).toBeUndefined();
		expect(session?.getActiveToolNames()).toEqual(["read"]);
		expect(session?.getActiveToolNames()).not.toContain("goal");
	});

	it("enters orchestrator mode and persists enabled state", async () => {
		const created = createHarness({
			registryToolNames: ["read", ...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
		});

		await created.handleOrchestratorModeCommand();

		expect(session?.getOrchestratorModeState()).toEqual({ enabled: true });
	});

	it("switches to only registered safe orchestration tools and excludes direct tools", async () => {
		const allRegistryTools = [
			...ORCHESTRATOR_CONTROL_TOOLS,
			...SAFE_ORCHESTRATOR_TOOLS,
			...MARKDOWN_WRITE_TOOLS,
			...DIRECT_TOOLS,
			"unrelated",
		];
		const created = createHarness({
			registryToolNames: allRegistryTools,
			activeToolNames: ["read", "write", "bash"],
		});

		await created.handleOrchestratorModeCommand();

		expect(session?.getActiveToolNames()).toEqual([
			...ORCHESTRATOR_CONTROL_TOOLS,
			...SAFE_ORCHESTRATOR_TOOLS,
			...MARKDOWN_WRITE_TOOLS,
		]);
		for (const directTool of DIRECT_TOOLS) {
			expect(session?.getActiveToolNames()).not.toContain(directTool);
		}
	});

	it("activates registered context hygiene tools without enabling direct tools and restores previous tools", async () => {
		const created = createHarness({
			registryToolNames: [
				...ORCHESTRATOR_CONTROL_TOOLS,
				...SAFE_ORCHESTRATOR_TOOLS,
				"compact",
				"shake",
				"context_unload",
				...MARKDOWN_WRITE_TOOLS,
				...DIRECT_TOOLS,
			],
			activeToolNames: ["read"],
		});

		await created.handleOrchestratorModeCommand();

		expect(session?.getActiveToolNames()).toContain("compact");
		expect(session?.getActiveToolNames()).toContain("shake");
		expect(session?.getActiveToolNames()).toContain("context_unload");
		for (const directTool of DIRECT_TOOLS) {
			expect(session?.getActiveToolNames()).not.toContain(directTool);
		}

		await created.handleOrchestratorModeCommand();

		expect(session?.getActiveToolNames()).toEqual(["read"]);
	});

	it("activates only safe orchestration tools that exist in the registry", async () => {
		const created = createHarness({
			registryToolNames: ["orchestrator_mode", "read", "task", "grep", "write", "eval"],
			activeToolNames: ["read"],
		});

		await created.handleOrchestratorModeCommand();

		expect(session?.getActiveToolNames()).toEqual(["orchestrator_mode", "task", "read", "grep", "write"]);
		expect(session?.getActiveToolNames()).not.toContain("eval");
	});

	it("keeps orchestrator safe tools active when model switch changes discovery mode to all", async () => {
		const registryToolLoadModes: Partial<Record<string, BuiltinToolLoadMode>> = Object.fromEntries(
			SAFE_ORCHESTRATOR_TOOLS.map(name => [name, "discoverable"] as [string, BuiltinToolLoadMode]),
		);
		createHarness({
			registryToolNames: [...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
			activeToolNames: ["read"],
			registryToolLoadModes,
			initialContextWindow: 1_000_000,
		});
		if (!session) throw new Error("Expected session");

		await session.setOrchestratorModeState({ enabled: true });
		for (const toolName of ["job", "task", "workflow"] as const) {
			expect(session.getActiveToolNames()).toContain(toolName);
		}

		const smallerContextModel = {
			...session.agent.state.model,
			id: "claude-sonnet-4-5-smaller-context",
			contextWindow: 275_000,
		};
		await session.setModel(smallerContextModel);

		for (const toolName of NON_ESSENTIAL_ORCHESTRATOR_TOOLS) {
			expect(session.getActiveToolNames()).toContain(toolName);
		}
	});

	it("exits orchestrator mode and restores the previous active tools on second command", async () => {
		const previousTools = ["read", "write", "bash"];
		const created = createHarness({
			registryToolNames: [
				...ORCHESTRATOR_CONTROL_TOOLS,
				...SAFE_ORCHESTRATOR_TOOLS,
				...MARKDOWN_WRITE_TOOLS,
				...DIRECT_TOOLS,
			],
			activeToolNames: previousTools,
		});

		await created.handleOrchestratorModeCommand();
		expect(session?.getOrchestratorModeState()).toEqual({ enabled: true });
		expect(session?.getActiveToolNames()).toEqual([
			...ORCHESTRATOR_CONTROL_TOOLS,
			...SAFE_ORCHESTRATOR_TOOLS,
			...MARKDOWN_WRITE_TOOLS,
		]);

		await created.handleOrchestratorModeCommand();

		expect(session?.getOrchestratorModeState()).toBeUndefined();
		expect(session?.getActiveToolNames()).toEqual(previousTools);
	});

	it("enters orchestrator mode through the UI command while an active goal stays intact", async () => {
		const created = createHarness({
			registryToolNames: ["read", "goal", ...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
		});
		const showWarning = vi.spyOn(created, "showWarning").mockImplementation(() => {});

		await created.handleGoalModeCommand("orchestrate safely");
		const goalState = session?.getGoalModeState();
		if (!goalState) throw new Error("Expected active goal state");

		await created.handleOrchestratorModeCommand();

		expect(showWarning).not.toHaveBeenCalledWith("Exit goal mode first.");
		expect(created.goalModeEnabled).toBe(true);
		expect(created.goalModePaused).toBe(false);
		expect(session?.getGoalModeState()).toMatchObject({
			enabled: true,
			goal: { id: goalState.goal.id, objective: "orchestrate safely", status: "active" },
		});
		expect(created.orchestratorModeEnabled).toBe(true);
		expect(session?.getOrchestratorModeState()).toEqual({ enabled: true });
		expect(session?.getActiveToolNames()).toEqual([
			...ORCHESTRATOR_CONTROL_TOOLS,
			...SAFE_ORCHESTRATOR_TOOLS,
			"goal",
		]);
	});

	it("restores an empty previous toolset without auto-adding Auto QA", async () => {
		const created = createHarness({
			registryToolNames: [...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS, "report_tool_issue"],
			activeToolNames: [],
			autoQa: true,
		});

		await created.handleOrchestratorModeCommand();
		await created.handleOrchestratorModeCommand();

		expect(session?.getOrchestratorModeState()).toBeUndefined();
		expect(session?.getActiveToolNames()).toEqual([]);
	});

	it("clears orchestrator state during session reconciliation without restoring old tools", async () => {
		createHarness({
			registryToolNames: [...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS, ...DIRECT_TOOLS, "unrelated"],
			activeToolNames: ["read", "write"],
		});
		if (!session) throw new Error("Expected session");

		await session.setOrchestratorModeState({ enabled: true });
		await session.setActiveToolsByName(["glob", "unrelated"]);
		await session.setOrchestratorModeState(undefined, { persistModeChange: false });

		expect(session.getOrchestratorModeState()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["glob", "unrelated"]);
	});

	it("emits mode change events for agent-initiated orchestrator switches", async () => {
		createHarness({
			registryToolNames: ["read", ...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
		});
		if (!session) throw new Error("Expected session");
		const modes: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "mode_changed") modes.push(event.mode);
		});

		await session.setOrchestratorModeState({ enabled: true });
		await session.setOrchestratorModeState(undefined);
		unsubscribe();

		expect(modes).toEqual(["orchestrator", "none"]);
	});

	it("injects orchestrator context reminding the agent to use subagents instead of direct tools", async () => {
		const created = createHarness({
			registryToolNames: [
				...ORCHESTRATOR_CONTROL_TOOLS,
				...SAFE_ORCHESTRATOR_TOOLS,
				...MARKDOWN_WRITE_TOOLS,
				...DIRECT_TOOLS,
			],
			activeToolNames: ["read"],
		});

		await created.handleOrchestratorModeCommand();

		const modeContext = session?.systemPrompt.join("\n") ?? "";
		expect(modeContext).toMatch(/subagents/i);
		expect(modeContext).toMatch(/dispatched to subagents/i);
		for (const directTool of DIRECT_TOOLS) {
			expect(modeContext).toContain(directTool);
		}
	});

	it("requires verify-before-done skill before orchestrator completion claims", async () => {
		const created = createHarness({
			registryToolNames: [...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
			activeToolNames: ["read"],
		});

		await created.handleOrchestratorModeCommand();

		const modeContext = session?.systemPrompt.join("\n") ?? "";
		expect(modeContext).toContain("skill://verify-before-done");
		expect(modeContext).toMatch(
			/(?:MUST|REQUIRED)[\s\S]{0,240}skill:\/\/verify-before-done[\s\S]{0,240}(?:done|fixed|ready|complete|completion|claim)|(?:done|fixed|ready|complete|completion|claim)[\s\S]{0,240}skill:\/\/verify-before-done[\s\S]{0,240}(?:MUST|REQUIRED)/i,
		);
	});

	it("keeps orchestrator report guidance concise and human-facing", async () => {
		const created = createHarness({
			registryToolNames: [...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
			activeToolNames: ["read"],
		});

		await created.handleOrchestratorModeCommand();

		const modeContext = session?.systemPrompt.join("\n") ?? "";
		expect(modeContext).toContain("skill://verify-before-done");

		const reportOpenTags = modeContext.match(/^\s*<report>\s*$/gm) ?? [];
		const reportCloseTags = modeContext.match(/^\s*<\/report>\s*$/gm) ?? [];
		expect(reportOpenTags).toHaveLength(1);
		expect(reportCloseTags).toHaveLength(1);

		const reportSection = modeContext.match(/^\s*<report>\s*$([\s\S]*?)^\s*<\/report>\s*$/m)?.[1] ?? "";
		expect(reportSection).toMatch(/final reports?[\s\S]{0,120}(?:lead|start|begin)[\s\S]{0,120}outcome[\s\S]{0,120}1-3 sentences?/i);
		expect(reportSection).toMatch(/evidence bullets?[\s\S]{0,120}`command\/check -> decisive output`/i);
		expect(reportSection).toMatch(
			/(?:never|do not|don't|must not)[\s\S]{0,160}(?:internal )?skill\/rule\/tool\/prompt mechanics[\s\S]{0,160}unless the user asks/i,
		);
		expect(reportSection).not.toContain("skill://");
	});

	it("rejects prompt-template gates as phase 3 completion evidence for coding-agent behavior", async () => {
		const created = createHarness({
			registryToolNames: [...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
			activeToolNames: ["read"],
		});

		await created.handleOrchestratorModeCommand();

		const modeContext = session?.systemPrompt.join("\n") ?? "";
		const phase3Start = modeContext.indexOf("## Phase 3 - Verification & Completion");
		expect(phase3Start).toBeGreaterThan(-1);
		const phase3 = modeContext.slice(phase3Start, phase3Start + 1400);

		expect(phase3).toMatch(/prompt-template gates are NOT completion evidence/i);
		expect(phase3).toMatch(
			/Require a verification subagent[\s\S]{0,160}build\/install\/run installed `ompx`[\s\S]{0,160}changed-path scenario/i,
		);
		expect(phase3).not.toMatch(/prompt-template gates are completion evidence/i);
		expect(phase3).not.toMatch(
			/prompt-template gates (?:satisfy|replace|substitute for) (?:rung|entrypoint|completion) evidence/i,
		);
	});

	it("ties orchestrator mode skill references to delegation review and verification claims", async () => {
		const created = createHarness({
			registryToolNames: [...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
			activeToolNames: ["read"],
		});

		await created.handleOrchestratorModeCommand();

		const modeContext = session?.systemPrompt.join("\n") ?? "";
		const contracts: Array<[skillRef: string, tiedGuidance: RegExp]> = [
			["skill://subagents-development", /delegat|dispatch|subagents?/i],
			["skill://code-review-lens", /review|reviewer/i],
			["skill://codebase-recon", /codebase|recon|investigat|explor/i],
			["skill://writing-tests-that-matter", /tests?|test suite|coverage|verification/i],
			["skill://verify-before-done", /done|fixed|ready|complete|completion|claim|verification/i],
		];
		const missingSkillRefs = contracts
			.map(([skillRef]) => skillRef)
			.filter(skillRef => !modeContext.includes(skillRef));
		const untiedSkillRefs = contracts
			.filter(([skillRef, tiedGuidance]) => {
				const escapedRef = skillRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const windowAroundRef = modeContext.match(new RegExp(`.{0,260}${escapedRef}.{0,260}`, "is"))?.[0] ?? "";
				return windowAroundRef === "" || !tiedGuidance.test(windowAroundRef);
			})
			.map(([skillRef]) => skillRef);

		expect({ missingSkillRefs, untiedSkillRefs }).toEqual({
			missingSkillRefs: [],
			untiedSkillRefs: [],
		});
	});

	it("replaces the core system prompt block while preserving context blocks in orchestrator mode", async () => {
		const created = createHarness({
			registryToolNames: [...ORCHESTRATOR_CONTROL_TOOLS, ...SAFE_ORCHESTRATOR_TOOLS],
			systemPrompt: ["Test", "CTX"],
		});

		await created.handleOrchestratorModeCommand();

		const activePrompt = session?.systemPrompt ?? [];
		expect(activePrompt[0]).toBe(orchestratorModeActivePrompt);
		expect(activePrompt).not.toContain("Test");
		expect(activePrompt).toContain("CTX");

		await created.handleOrchestratorModeCommand();

		const restoredPrompt = session?.systemPrompt ?? [];
		expect(restoredPrompt).not.toContain(orchestratorModeActivePrompt);
		expect(restoredPrompt).toContain("Test");
	});
});
