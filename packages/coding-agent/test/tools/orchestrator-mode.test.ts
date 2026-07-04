import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES,
	type OrchestratorModeState,
} from "@oh-my-pi/pi-coding-agent/orchestrator-mode/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { OrchestratorModeTool } from "@oh-my-pi/pi-coding-agent/tools/orchestrator-mode";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { type } from "arktype";

type OrchestratorModeDetails = {
	enabled: boolean;
	mode: "normal" | "orchestrator";
};

type OrchestratorModeSession = ToolSession & {
	getOrchestratorModeState?: () => OrchestratorModeState | undefined;
	setOrchestratorModeState?: (state: OrchestratorModeState | undefined) => void;
};

function createSession(overrides: Partial<OrchestratorModeSession> = {}): OrchestratorModeSession {
	let state = overrides.getOrchestratorModeState?.();
	return {
		cwd: "/tmp/orchestrator-mode-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getOrchestratorModeState: () => state,
		setOrchestratorModeState: next => {
			state = next;
		},
		...overrides,
	} as OrchestratorModeSession;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function goalState(status: "active" | "paused"): GoalModeState {
	return {
		enabled: status === "active",
		mode: "active",
		goal: {
			id: `goal-${status}`,
			objective: status === "active" ? "finish safely" : "finish safely later",
			status,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		},
	};
}

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: type({}),
		strict: true,
		async execute() {
			return { content: [{ type: "text" as const, text: `${name} executed` }] };
		},
	};
}

type AgentSessionHarness = {
	session: AgentSession;
	toolSession: ToolSession;
};

function createAgentSessionHarness(initialToolNames: readonly string[]): AgentSessionHarness {
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected bundled OpenAI test model to exist");
	const settings = Settings.isolated({ "compaction.enabled": false, "duo.mode": "off", "goal.enabled": true });
	const sessionManager = SessionManager.inMemory();
	const registryToolNames = [...new Set([...ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES, "goal", ...initialToolNames])];
	const toolRegistry = new Map(registryToolNames.map(name => [name, makeTool(name)] as const));
	let session: AgentSession | undefined;
	const toolSession: ToolSession = {
		cwd: "/tmp/orchestrator-mode-test",
		hasUI: false,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		settings,
		getToolByName: name => session?.getToolByName(name),
		getPlanModeState: () => session?.getPlanModeState(),
		getOrchestratorModeState: () => session?.getOrchestratorModeState(),
		setOrchestratorModeState: (state, options) => session?.setOrchestratorModeState(state, options),
		getGoalModeState: () => session?.getGoalModeState(),
	};
	const activeTools = initialToolNames.map(name => {
		const tool = toolRegistry.get(name);
		if (!tool) throw new Error(`Missing active test tool ${name}`);
		return tool;
	});
	session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: activeTools,
				messages: [],
			},
		}),
		sessionManager,
		settings,
		modelRegistry: {} as never,
		toolRegistry,
		builtInToolNames: Array.from(toolRegistry.keys()),
	});
	return { session, toolSession };
}

describe("OrchestratorModeTool", () => {
	it("enters orchestrator mode through the session switch seam", async () => {
		const states: Array<OrchestratorModeState | undefined> = [];
		const session = createSession({
			setOrchestratorModeState: next => {
				states.push(next);
			},
		});
		const tool = new OrchestratorModeTool(session);

		const result = await tool.execute("call-enter", { op: "enter" });

		expect(states).toHaveLength(1);
		expect(states[0]).toEqual({ enabled: true });
		expect(getText(result)).toMatch(/orchestrator mode (is )?enabled/i);
		expect(result.details as OrchestratorModeDetails).toEqual({ enabled: true, mode: "orchestrator" });
	});

	it("exits orchestrator mode through the session switch seam", async () => {
		const states: Array<OrchestratorModeState | undefined> = [];
		const session = createSession({
			getOrchestratorModeState: () => ({ enabled: true }) as OrchestratorModeState,
			setOrchestratorModeState: next => {
				states.push(next);
			},
		});
		const tool = new OrchestratorModeTool(session);

		const result = await tool.execute("call-exit", { op: "exit" });

		expect(states).toHaveLength(1);
		expect(states[0]).toBeUndefined();
		expect(getText(result)).toMatch(/normal mode (is )?restored/i);
		expect(result.details as OrchestratorModeDetails).toEqual({ enabled: false, mode: "normal" });
	});

	it("reports orchestrator mode status without mutating state", async () => {
		let setCalls = 0;
		const session = createSession({
			getOrchestratorModeState: () => ({ enabled: true }) as OrchestratorModeState,
			setOrchestratorModeState: () => {
				setCalls++;
			},
		});
		const tool = new OrchestratorModeTool(session);

		const result = await tool.execute("call-status", { op: "status" });

		expect(setCalls).toBe(0);
		expect(getText(result)).toMatch(/orchestrator mode/i);
		expect(result.details as OrchestratorModeDetails).toEqual({ enabled: true, mode: "orchestrator" });
	});

	it("rejects enter while plan mode owns the session", async () => {
		const session = createSession({
			getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" }),
		});
		const tool = new OrchestratorModeTool(session);

		await expect(tool.execute("call-plan-active", { op: "enter" })).rejects.toThrow(/exit plan mode/i);
	});

	it("enters orchestrator mode while active goal mode owns the session", async () => {
		const goal = goalState("active");
		const session = createSession({
			getGoalModeState: () => goal,
		});
		const tool = new OrchestratorModeTool(session);

		const result = await tool.execute("call-goal-active", { op: "enter" });

		expect(session.getOrchestratorModeState?.()).toEqual({ enabled: true });
		expect(session.getGoalModeState?.()).toBe(goal);
		expect(getText(result)).toMatch(/orchestrator mode (is )?enabled/i);
		expect(result.details as OrchestratorModeDetails).toEqual({ enabled: true, mode: "orchestrator" });
	});

	it("enters orchestrator mode while a paused goal still owns the session", async () => {
		const goal = goalState("paused");
		const session = createSession({
			getGoalModeState: () => goal,
		});
		const tool = new OrchestratorModeTool(session);

		const result = await tool.execute("call-goal-paused", { op: "enter" });

		expect(session.getOrchestratorModeState?.()).toEqual({ enabled: true });
		expect(session.getGoalModeState?.()).toBe(goal);
		expect(getText(result)).toMatch(/orchestrator mode (is )?enabled/i);
		expect(result.details as OrchestratorModeDetails).toEqual({ enabled: true, mode: "orchestrator" });
	});

	it("enter while active goal returns success with orchestrator delegate tools and goal active", async () => {
		const { session, toolSession } = createAgentSessionHarness(["read", "goal"]);
		const goal = goalState("active");
		session.setGoalModeState(goal);
		const tool = new OrchestratorModeTool(toolSession);
		try {
			const result = await tool.execute("call-goal-active-tools", { op: "enter" });
			const activeToolNames = session.getActiveToolNames();

			expect(result.details as OrchestratorModeDetails).toEqual({ enabled: true, mode: "orchestrator" });
			expect(session.getOrchestratorModeState()).toEqual({ enabled: true });
			expect(session.getGoalModeState()).toBe(goal);
			for (const toolName of ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES) {
				expect(activeToolNames).toContain(toolName);
			}
			expect(activeToolNames).toContain("goal");
		} finally {
			await session.dispose();
		}
	});

	it("throws a clear ToolError when the session switch seam is unavailable", async () => {
		const session = {
			cwd: "/tmp/orchestrator-mode-test",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		} as ToolSession;
		const tool = new OrchestratorModeTool(session);

		await expect(tool.execute("call-unavailable", { op: "enter" })).rejects.toThrow(ToolError);
		await expect(tool.execute("call-unavailable", { op: "enter" })).rejects.toThrow(
			/orchestrator mode is unavailable/i,
		);
	});
});
