import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Goal, GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/orchestrator-mode/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ModeChangeEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

const BASE_TOOL_NAMES = ["read", "bash", "extra_tool"] as const;
const GOAL_TOOL_NAME = "goal";

type Harness = {
	session: AgentSession;
	mode: InteractiveMode;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
};

function activeGoalState(objective = "Ship the release"): GoalModeState {
	const now = Date.now();
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: `goal-${now}`,
			objective,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		},
	};
}

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name} output` }] }),
	};
}

function modeChanges(sessionManager: SessionManager): ModeChangeEntry[] {
	return sessionManager.getEntries().filter((entry): entry is ModeChangeEntry => entry.type === "mode_change");
}

function customTypesFromPrompt(promptSpy: { mock: { calls: unknown[][] } }): string[] {
	const promptMessages = promptSpy.mock.calls[0]?.[0] as Array<{ customType?: string }> | undefined;
	return promptMessages?.map(message => message.customType).filter(type => type !== undefined) ?? [];
}

function expectActiveTools(session: AgentSession, expected: readonly string[]): void {
	expect(session.getActiveToolNames()).toEqual([...expected]);
}

function expectOrchestratorToolsWithGoal(session: AgentSession): void {
	expectActiveTools(session, [...ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES, GOAL_TOOL_NAME]);
}

describe("AgentSession goal/orchestrator coexistence", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(async () => {
		initTheme();
		tempDir = TempDir.createSync("@pi-agent-goal-orchestrator-coexistence-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	async function createHarness(initialToolNames: readonly string[] = ["read"]): Promise<Harness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
			"duo.mode": "off",
			"goal.enabled": true,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const toolNames = [...new Set([...BASE_TOOL_NAMES, GOAL_TOOL_NAME, ...ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES])];
		const toolRegistry = new Map<string, AgentTool>(toolNames.map(name => [name, makeTool(name)] as const));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialToolNames.map(name => {
					const tool = toolRegistry.get(name);
					if (!tool) throw new Error(`Missing initial test tool ${name}`);
					return tool;
				}),
				messages: [],
			},
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		});
		const mode = new InteractiveMode(session, "test");

		cleanups.push(async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
		});

		return { session, mode, sessionManager, authStorage };
	}

	async function enterGoal(mode: InteractiveMode, objective = "Ship the release"): Promise<void> {
		await mode.handleGoalModeCommand(objective);
	}

	async function pauseGoal(mode: InteractiveMode): Promise<void> {
		await mode.handleGoalModeCommand("pause");
	}

	it("preserves an active goal and exposes orchestrator tools plus goal when orchestrator enters", async () => {
		const { session } = await createHarness(["read", GOAL_TOOL_NAME]);
		session.setGoalModeState(activeGoalState("Coordinate the release"));

		await session.setOrchestratorModeState({ enabled: true });

		expect(session.getGoalModeState()?.enabled).toBe(true);
		expect(session.getGoalModeState()?.goal.objective).toBe("Coordinate the release");
		expectOrchestratorToolsWithGoal(session);
	});

	it("adds goal without replacing delegate tools when goal enters after orchestrator", async () => {
		const { session, mode } = await createHarness(["read"]);
		await session.setOrchestratorModeState({ enabled: true });

		await enterGoal(mode, "Delegate the migration");

		expect(session.getGoalModeState()?.enabled).toBe(true);
		expect(session.getGoalModeState()?.goal.objective).toBe("Delegate the migration");
		expectOrchestratorToolsWithGoal(session);
	});

	it("retains goal after exiting orchestrator, then strips only goal when goal exits", async () => {
		const { session, mode } = await createHarness(["read"]);
		await enterGoal(mode, "Keep the goal alive");
		await session.setOrchestratorModeState({ enabled: true });

		await session.setOrchestratorModeState(undefined);

		expect(session.getOrchestratorModeState()).toBeUndefined();
		expect(session.getGoalModeState()?.enabled).toBe(true);
		expectActiveTools(session, ["read", GOAL_TOOL_NAME]);

		await pauseGoal(mode);

		expect(session.getGoalModeState()?.enabled).toBe(false);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		expectActiveTools(session, ["read"]);
	});

	it("strips goal while orchestrator stays active, then restores the pre-orchestrator snapshot", async () => {
		const { session, mode } = await createHarness(["read", "bash"]);
		await session.setOrchestratorModeState({ enabled: true });
		await enterGoal(mode, "Delegation survives pausing");

		await pauseGoal(mode);

		expect(session.getGoalModeState()?.enabled).toBe(false);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		expect(session.getOrchestratorModeState()?.enabled).toBe(true);
		expectActiveTools(session, ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES);

		await session.setOrchestratorModeState(undefined);

		expect(session.getOrchestratorModeState()).toBeUndefined();
		expectActiveTools(session, ["read", "bash"]);
	});

	it("preserves tools activated mid-goal when goal exits", async () => {
		const { session, mode } = await createHarness(["read"]);
		await enterGoal(mode, "Discover tools mid-goal");
		await session.setActiveToolsByName([...session.getActiveToolNames(), "extra_tool"]);

		await pauseGoal(mode);

		expect(session.getGoalModeState()?.enabled).toBe(false);
		expectActiveTools(session, ["read", "extra_tool"]);
	});

	it("auto-enters orchestrator from the public prompt seam while an active goal stays intact", async () => {
		const { session, mode } = await createHarness(["read"]);
		await enterGoal(mode, "Orchestrate on request");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate these independent changes");

		expect(session.getOrchestratorModeState()?.enabled).toBe(true);
		expect(session.getGoalModeState()?.enabled).toBe(true);
		expect(session.getGoalModeState()?.goal.objective).toBe("Orchestrate on request");
		expectOrchestratorToolsWithGoal(session);
		expect(customTypesFromPrompt(promptSpy)).not.toContain("orchestrate-notice");
	});

	it("does not auto-enter orchestrator from the public prompt seam while the goal is paused", async () => {
		const { session, mode } = await createHarness(["read"]);
		await enterGoal(mode, "Stay paused");
		await pauseGoal(mode);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate the paused goal work");

		expect(session.getOrchestratorModeState()?.enabled).not.toBe(true);
		expect(session.getGoalModeState()?.enabled).toBe(false);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		expectActiveTools(session, ["read"]);
		expect(customTypesFromPrompt(promptSpy)).toContain("orchestrate-notice");
	});

	it("restores the original tool snapshot and persists only once after double-entering orchestrator", async () => {
		const { session, sessionManager } = await createHarness(["read", "bash"]);
		const beforeCount = modeChanges(sessionManager).length;

		await session.setOrchestratorModeState({ enabled: true });

		expectActiveTools(session, ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES);

		await session.setOrchestratorModeState({ enabled: true });

		const appendedAcrossEnters = modeChanges(sessionManager).slice(beforeCount);
		expect(appendedAcrossEnters).toHaveLength(1);
		expect(appendedAcrossEnters[0].mode).toBe("orchestrator");

		await session.setOrchestratorModeState(undefined);

		expect(session.getOrchestratorModeState()).toBeUndefined();
		expectActiveTools(session, ["read", "bash"]);
		expect(
			modeChanges(sessionManager)
				.slice(beforeCount)
				.filter(entry => entry.mode === "orchestrator"),
		).toHaveLength(1);
	});

	it("persists orchestrator entry during an active goal as a goal mode change with an orchestrator flag", async () => {
		const { session, mode, sessionManager } = await createHarness(["read"]);
		await enterGoal(mode, "Persist co-active mode");
		const beforeCount = modeChanges(sessionManager).length;

		await session.setOrchestratorModeState({ enabled: true });

		const appended = modeChanges(sessionManager).slice(beforeCount);
		expect(appended).toHaveLength(1);
		expect(appended[0].mode).toBe("goal");
		expect(appended[0].data?.orchestrator).toBe(true);
		const persistedGoal = appended[0].data?.goal;
		if (persistedGoal === null || typeof persistedGoal !== "object" || Array.isArray(persistedGoal)) {
			throw new Error("Expected persisted goal data on co-active mode change");
		}
		const goal = persistedGoal as Goal;
		expect(goal.objective).toBe("Persist co-active mode");
		expect(goal.status).toBe("active");
		expect(appended.some(entry => entry.mode === "orchestrator")).toBe(false);
	});
});
