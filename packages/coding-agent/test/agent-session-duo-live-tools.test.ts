import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AdvisorConsultResult } from "../src/advisor/runtime";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES } from "../src/orchestrator-mode/state";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

describe("AgentSession live duo/advisor tool availability", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];
	const tempDirs: TempDir[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-duo-live-tools-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const tempDir of tempDirs.splice(0)) {
			try {
				tempDir.removeSync();
			} catch {}
		}
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		authStorage.close();
		try {
			sharedDir.removeSync();
		} catch {}
	});

	function modelOrThrow(registry: ModelRegistry, id: string): Model {
		const model = registry.find("anthropic", id);
		if (!model) throw new Error(`Expected bundled anthropic model ${id} to exist`);
		return model;
	}

	function createHarness(
		options: {
			duoMode?: "auto" | "on" | "off";
			advisorEnabled?: boolean;
			initialModelId?: string;
			registryToolNames?: readonly string[];
			activeToolNames?: readonly string[];
		} = {},
	): AgentSession {
		const tempDir = TempDir.createSync("@pi-duo-live-tools-");
		tempDirs.push(tempDir);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const planner = modelOrThrow(modelRegistry, "claude-fable-5");
		const executor = modelOrThrow(modelRegistry, "claude-opus-4-5");
		const initialModel = modelOrThrow(modelRegistry, options.initialModelId ?? executor.id);
		const availableModels = [planner, executor, initialModel].filter(
			(model, index, models) =>
				models.findIndex(candidate => candidate.provider === model.provider && candidate.id === model.id) === index,
		);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(availableModels);
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(true);
		const settings = Settings.isolated({
			"advisor.enabled": options.advisorEnabled ?? false,
			"compaction.enabled": false,
			"duo.executorModel": `${executor.provider}/${executor.id}`,
			"duo.mode": options.duoMode ?? "auto",
			"duo.orchestrator": "auto",
			"duo.plannerModel": `${planner.provider}/${planner.id}`,
		});
		settings.setModelRole("advisor", `${planner.provider}/${planner.id}`);

		const registryToolNames = options.registryToolNames ?? [
			...ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES,
			"duo_handoff",
			"duo_escalate",
		];
		const activeToolNames = options.activeToolNames ?? ["read"];
		const toolsByName = new Map(registryToolNames.map(name => [name, makeTool(name)] as const));
		for (const name of activeToolNames) {
			if (!toolsByName.has(name)) toolsByName.set(name, makeTool(name));
		}
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "session.jsonl"));
		let session: AgentSession | undefined;
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
			authStorage,
			modelRegistry,
			getToolByName: name => session?.getToolByName(name),
			consultAdvisor: (question, signal) =>
				session?.consultAdvisor(question, signal) ??
				Promise.resolve({ status: "unavailable", attempts: [] } satisfies AdvisorConsultResult),
			isAdvisorActive: () => session?.isAdvisorActive() ?? false,
			duoHandoffToExecutor: (resolution, scope) =>
				session?.duoHandoffToExecutor(resolution, scope) ?? Promise.resolve("no-controller"),
			duoEscalateToPlanner: reason => session?.duoEscalateToPlanner(reason) ?? Promise.resolve("unavailable"),
			getPlanModeState: () => session?.getPlanModeState(),
			getOrchestratorModeState: () => session?.getOrchestratorModeState(),
			setOrchestratorModeState: (state, setOptions) => session?.setOrchestratorModeState(state, setOptions),
			getPlanReferencePath: () => session?.getPlanReferencePath() ?? "local://PLAN.md",
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
			getUsageStatistics: () => sessionManager.getUsageStatistics(),
			getTurnBudget: () => sessionManager.getTurnBudget(),
		};

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test"],
					tools: activeToolNames.map(name => {
						const tool = toolsByName.get(name);
						if (!tool) throw new Error(`Missing active test tool ${name}`);
						return tool;
					}),
					messages: [],
				},
			}),
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: toolsByName,
			toolSession,
			builtInToolNames: Array.from(toolsByName.keys()),
			advisorTools: [],
		});
		sessions.push(session);
		return session;
	}

	async function startExecutingDuoWithAdvisorInOrchestrator(session: AgentSession): Promise<void> {
		session.settings.override("duo.mode", "off");
		await session.setOrchestratorModeState({ enabled: true });
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		session.settings.clearOverride("duo.mode");
		await session.setDuoEnabled(true);
		expect(session.getDuoStatus()?.phase).toBe("planning");
		expect(session.isAdvisorActive()).toBe(true);

		const result = await session.duoHandoffToExecutor("plan locked", "multi");
		expect(result).toBe("ok");
		expect(session.getDuoStatus()?.phase).toBe("executing");
		expect(session.isAdvisorActive()).toBe(true);
	}

	function expectLiveTools(session: AgentSession): void {
		const active = session.getActiveToolNames();
		expect(active).toContain("consult");
		expect(active).toContain("duo_handoff");
		expect(active).toContain("duo_escalate");
	}

	function orchestratorModeChangeCount(session: AgentSession): number {
		return session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "mode_change" && entry.mode === "orchestrator").length;
	}

	it("activates consult and duo tools when the duo advisor starts after orchestrator mode is already on", async () => {
		const session = createHarness();

		await startExecutingDuoWithAdvisorInOrchestrator(session);

		expect(session.getOrchestratorModeState()).toEqual({ enabled: true });
		expect(session.getToolByName("consult")).toBeDefined();
		expectLiveTools(session);

		await session.setOrchestratorModeState(undefined);

		expect(session.getOrchestratorModeState()).toBeUndefined();
		expectLiveTools(session);
	});

	it("keeps live duo and consult tools when orchestrator mode restores a pre-duo tool snapshot", async () => {
		const session = createHarness({ activeToolNames: ["read"] });

		await startExecutingDuoWithAdvisorInOrchestrator(session);
		expectLiveTools(session);

		await session.setOrchestratorModeState(undefined);

		expect(session.getActiveToolNames()).toContain("read");
		expectLiveTools(session);
	});

	it("registers and activates consult when an initially disabled advisor is started later", () => {
		const session = createHarness({ duoMode: "off", advisorEnabled: false, activeToolNames: ["read"] });
		expect(session.getToolByName("consult")?.name).toBe("consult");
		expect(session.getActiveToolNames()).not.toContain("consult");

		expect(session.setAdvisorEnabled(true)).toBe(true);

		expect(session.getToolByName("consult")?.name).toBe("consult");
		expect(session.getAllToolNames()).toContain("consult");
		expect(session.getActiveToolNames()).toContain("consult");
	});

	it("keeps duo-driven orchestrator enables out of restorable session mode", async () => {
		const session = createHarness({ activeToolNames: ["read"] });
		session.settings.override("duo.mode", "off");
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		session.settings.clearOverride("duo.mode");
		await session.setDuoEnabled(true);
		expect(session.getDuoStatus()?.phase).toBe("planning");
		const persistedOrchestratorBeforeHandoff = orchestratorModeChangeCount(session);

		const result = await session.duoHandoffToExecutor("plan locked", "multi");

		expect(result).toBe("ok");
		expect(session.getDuoStatus()?.phase).toBe("executing");
		expect(session.getOrchestratorModeState()).toEqual({ enabled: true });
		expect(orchestratorModeChangeCount(session)).toBe(persistedOrchestratorBeforeHandoff);
		expect(session.sessionManager.buildSessionContext().mode).not.toBe("orchestrator");

		const userSession = createHarness({ duoMode: "off", activeToolNames: ["read"] });
		const userPersistedOrchestratorBefore = orchestratorModeChangeCount(userSession);

		await userSession.setOrchestratorModeState({ enabled: true });

		expect(orchestratorModeChangeCount(userSession)).toBe(userPersistedOrchestratorBefore + 1);
		expect(userSession.sessionManager.buildSessionContext().mode).toBe("orchestrator");
	});

	it("does not register consult for a plain non-duo non-advisor session", () => {
		const session = createHarness({
			duoMode: "off",
			advisorEnabled: false,
			initialModelId: "claude-sonnet-4-5",
			registryToolNames: ["read"],
			activeToolNames: ["read"],
		});

		expect(session.getToolByName("consult")).toBeUndefined();
		expect(session.getAllToolNames()).not.toContain("consult");
		expect(session.getActiveToolNames()).not.toContain("consult");
	});
});
