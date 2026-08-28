import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	formatTimeBudgetSnapshot,
	parseTimeBudgetCommand,
	TIME_BUDGET_CHECKPOINT_MS,
	TimeBudgetController,
	type TimeBudgetEntryData,
	type TimeBudgetSnapshot,
} from "@oh-my-pi/pi-coding-agent/session/time-budget";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	await initTheme();
});

async function flushReminders(): Promise<void> {
	for (let turn = 0; turn < 6; turn++) {
		await Promise.resolve();
	}
}

function createController() {
	let now = 1_000;
	const entries: TimeBudgetEntryData[] = [];
	const reminders: Array<{ kind: "activation" | "checkpoint" | "overtime"; snapshot: TimeBudgetSnapshot }> = [];
	const controller = new TimeBudgetController({
		now: () => now,
		appendEntry: entry => entries.push(entry),
		sendReminder: async (kind, snapshot) => {
			reminders.push({ kind, snapshot });
		},
	});
	return {
		controller,
		entries,
		reminders,
		advance(ms: number) {
			now += ms;
		},
	};
}

function createStatusContext(
	snapshot: TimeBudgetSnapshot,
	planMode: SegmentContext["planMode"] = null,
): SegmentContext {
	return {
		session: {
			getTimeBudgetSnapshot: () => snapshot,
		} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("time budget command parsing", () => {
	for (const [input, expected] of [
		["", { action: "status" }],
		["10m", { action: "activate", durationMs: 600_000 }],
		["2h", { action: "activate", durationMs: 7_200_000 }],
		["1h30m", { action: "activate", durationMs: 5_400_000 }],
		["+5m", { action: "extend", durationMs: 300_000 }],
		["off", { action: "off" }],
	] as const) {
		it(`parses ${input || "status"}`, () => {
			expect(parseTimeBudgetCommand(input)).toEqual(expected);
		});
	}

	it("rejects malformed, duplicate-unit, and below-minimum activations without accepting a budget", () => {
		for (const input of ["9m", "1m1m", "30", "-10m", "10x", "+", "+1h1h"]) {
			expect(parseTimeBudgetCommand(input)).toBeTypeOf("string");
		}
	});
});

describe("time budget controller", () => {
	it("counts only running windows and does not charge idle or offline time after restore", async () => {
		const budget = createController();
		await budget.controller.activate(20 * 60_000);
		budget.controller.setRunState("running");
		budget.advance(4 * 60_000);
		budget.controller.setRunState("idle");
		budget.advance(30 * 60_000);
		expect(budget.controller.snapshot()?.activeMs).toBe(4 * 60_000);

		const restored = createController();
		restored.advance(12 * 60 * 60_000);
		restored.controller.restore([
			{ customType: "time_budget", data: budget.entries[0] },
			{ customType: "time_budget", data: budget.entries.at(-1) },
			{ customType: "time_budget", data: { event: "checkpoint", budgetMs: Number.NaN, activeMs: 1, at: 1 } },
		]);
		expect(restored.controller.snapshot()).toMatchObject({ active: true, running: false, activeMs: 4 * 60_000 });
	});

	it("emits one current checkpoint after a missed-bucket stall and one overtime reminder after crossing the deadline", async () => {
		const budget = createController();
		await budget.controller.activate(10 * 60_000);
		budget.controller.setRunState("running");
		budget.advance(15 * 60_000);
		budget.controller.setRunState("idle");
		await flushReminders();

		expect(budget.entries.map(entry => entry.event)).toEqual(["activate", "checkpoint", "overtime"]);
		expect(budget.reminders.map(reminder => reminder.kind)).toEqual(["activation", "checkpoint", "overtime"]);
		expect(budget.entries[1]?.activeMs).toBe(15 * 60_000);

		budget.controller.setRunState("running");
		budget.advance(TIME_BUDGET_CHECKPOINT_MS);
		budget.controller.setRunState("idle");
		await flushReminders();
		expect(budget.entries.filter(entry => entry.event === "overtime")).toHaveLength(1);
		expect(budget.reminders.filter(reminder => reminder.kind === "overtime")).toHaveLength(1);
	});

	it("extends the active budget without losing elapsed work and persists final deactivation", async () => {
		const budget = createController();
		await budget.controller.activate(10 * 60_000);
		budget.controller.setRunState("running");
		budget.advance(5 * 60_000);
		await budget.controller.extend(5 * 60_000);
		expect(budget.controller.snapshot()).toMatchObject({
			budgetMs: 15 * 60_000,
			activeMs: 5 * 60_000,
			remainingMs: 10 * 60_000,
		});

		const final = budget.controller.deactivate();
		expect(final).toMatchObject({ active: false, activeMs: 5 * 60_000, overtimeMs: 0 });
		expect(budget.entries.at(-1)?.event).toBe("deactivate");
	});

	it("re-arms overtime after an extension returns an over-budget run to within budget, including after restore", async () => {
		const budget = createController();
		await budget.controller.activate(10 * 60_000);
		budget.controller.setRunState("running");
		budget.advance(11 * 60_000);
		budget.controller.setRunState("idle");
		await flushReminders();
		expect(budget.entries.filter(entry => entry.event === "overtime")).toHaveLength(1);
		expect(budget.reminders.filter(reminder => reminder.kind === "overtime")).toHaveLength(1);

		await budget.controller.extend(5 * 60_000);
		expect(budget.controller.snapshot()).toMatchObject({
			activeMs: 11 * 60_000,
			remainingMs: 4 * 60_000,
			overtimeMs: 0,
			overtimeLogged: false,
		});
		const underBudgetEntries = [...budget.entries];

		budget.controller.setRunState("running");
		budget.advance(4 * 60_000);
		budget.controller.setRunState("idle");
		await flushReminders();
		expect(budget.entries.filter(entry => entry.event === "overtime")).toHaveLength(2);
		expect(budget.reminders.filter(reminder => reminder.kind === "overtime")).toHaveLength(2);

		const restoredUnderBudget = createController();
		restoredUnderBudget.controller.restore(underBudgetEntries.map(data => ({ customType: "time_budget", data })));
		expect(restoredUnderBudget.controller.snapshot()).toMatchObject({
			activeMs: 11 * 60_000,
			remainingMs: 4 * 60_000,
			overtimeMs: 0,
			overtimeLogged: false,
		});

		restoredUnderBudget.controller.setRunState("running");
		restoredUnderBudget.advance(4 * 60_000);
		restoredUnderBudget.controller.setRunState("idle");
		await flushReminders();
		expect(restoredUnderBudget.entries.filter(entry => entry.event === "overtime")).toHaveLength(1);
		expect(restoredUnderBudget.reminders.filter(reminder => reminder.kind === "overtime")).toHaveLength(1);
	});
});

describe("time budget slash and status surfaces", () => {
	it("routes a slash activation through the shared handler into the session budget", async () => {
		resetSettingsForTest();
		const tempDir = TempDir.createSync("@pi-time-budget-command-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		try {
			await Settings.init({ inMemory: true, cwd: tempDir.path() });
			const modelRegistry = new ModelRegistry(authStorage);
			const defaultModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 in registry");
			const session = new AgentSession({
				agent: new Agent({
					initialState: { model: defaultModel, systemPrompt: ["Test"], tools: [], messages: [] },
				}),
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				settings: Settings.isolated(),
				modelRegistry,
			});
			try {
				const command = BUILTIN_MODE_SLASH_COMMANDS.find(candidate => candidate.name === "time-budget");
				if (!command?.handle) throw new Error("Expected /time-budget shared handler");
				const output: string[] = [];
				await command.handle({ name: "time-budget", args: "1h30m", text: "/time-budget 1h30m" }, {
					session,
					output: async (value: string) => {
						output.push(value);
					},
				} as never);
				expect(output).toEqual(["Time budget active: 0m elapsed, 1h30m remaining."]);
				expect(session.getTimeBudgetSnapshot()).toMatchObject({ active: true, budgetMs: 5_400_000, activeMs: 0 });
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
			tempDir.removeSync();
			resetSettingsForTest();
		}
	});

	it("renders active, warning, and overtime budget state alongside the primary mode", () => {
		const active: TimeBudgetSnapshot = {
			active: true,
			running: true,
			budgetMs: 30 * 60_000,
			activeMs: 12 * 60_000,
			remainingMs: 18 * 60_000,
			overtimeMs: 0,
			overtimeLogged: false,
		};
		const activeRendered = renderSegment("mode", createStatusContext(active));
		expect(Bun.stripANSI(activeRendered.content)).toContain("12m/30m · 18m left");

		const warning = { ...active, activeMs: 25 * 60_000, remainingMs: 5 * 60_000 };
		const warningRendered = renderSegment("mode", createStatusContext(warning));
		expect(warningRendered.content).toBe(theme.fg("warning", "⏱ 25m/30m · 5m left"));

		const overtime = {
			...active,
			activeMs: 37 * 60_000,
			remainingMs: 0,
			overtimeMs: 7 * 60_000,
			overtimeLogged: true,
		};
		const overtimeRendered = renderSegment("mode", createStatusContext(overtime, { enabled: true, paused: false }));
		expect(Bun.stripANSI(overtimeRendered.content)).toContain("Plan ⏱ 37m/30m · +7m over");
		expect(overtimeRendered.content).toContain(theme.fg("error", "⏱ 37m/30m · +7m over"));
	});

	it("formats inactive elapsed time without claiming remaining budget", () => {
		expect(
			formatTimeBudgetSnapshot({
				active: false,
				running: false,
				budgetMs: 10 * 60_000,
				activeMs: 5 * 60_000,
				remainingMs: 5 * 60_000,
				overtimeMs: 0,
				overtimeLogged: false,
			}),
		).toBe("Time budget inactive: 5m elapsed.");
	});
});
