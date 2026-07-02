import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { OrchestratorModeState } from "@oh-my-pi/pi-coding-agent/orchestrator-mode/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { OrchestratorModeTool } from "@oh-my-pi/pi-coding-agent/tools/orchestrator-mode";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

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

	it("rejects enter while goal mode owns the session", async () => {
		const session = createSession({
			getGoalModeState: () => ({
				enabled: true,
				mode: "active",
				goal: {
					id: "goal-1",
					objective: "finish safely",
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				},
			}),
		});
		const tool = new OrchestratorModeTool(session);

		await expect(tool.execute("call-goal-active", { op: "enter" })).rejects.toThrow(/exit goal mode/i);
	});

	it("rejects enter while a paused goal still owns the session", async () => {
		const session = createSession({
			getGoalModeState: () => ({
				enabled: false,
				mode: "active",
				goal: {
					id: "goal-1",
					objective: "finish safely later",
					status: "paused",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				},
			}),
		});
		const tool = new OrchestratorModeTool(session);

		await expect(tool.execute("call-goal-paused", { op: "enter" })).rejects.toThrow(/exit goal mode/i);
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
