import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { DuoResolvedConfig } from "../../config/model-resolver";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import { ToolError } from "../../tools/tool-errors";
import { DuoController, type DuoControllerHost } from "../controller";
import { SetExecutorEffortTool } from "../effort-tool";
import type { DuoStateSnapshot, TakeoverDecision, TakeoverPurpose } from "../state";
import { RequestTakeoverTool } from "../takeover-tool";

function anthropicModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		},
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const planner = anthropicModel("claude-fable-5");
const executor = anthropicModel("claude-opus-4.8");
const otherModel = anthropicModel("claude-sonnet-4.5");

interface ModelSwitchCall {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

interface BriefCall {
	text: string;
	deliverAs: "steer" | "nextTurn";
}

interface NoticeCall {
	level: "info" | "warning";
	text: string;
}

interface FakeHost extends DuoControllerHost {
	streaming: boolean;
	orchestrator: boolean;
	planModeOn: boolean;
	model: Model | undefined;
	thinking: ConfiguredThinkingLevel | undefined;
	failSwitch: boolean;
	switches: ModelSwitchCall[];
	thinkingChanges: ConfiguredThinkingLevel[];
	ensured: Model[];
	stops: number;
	pauses: number;
	resumes: (string | undefined)[];
	briefs: BriefCall[];
	notices: NoticeCall[];
	persisted: DuoStateSnapshot[];
	orchestratorEnables: boolean[];
	planModeEnables: boolean[];
}

function duoConfig(overrides: Partial<DuoResolvedConfig> = {}): DuoResolvedConfig {
	return {
		mode: "auto",
		advisorPromptReview: false,
		orchestrator: "auto",
		planner,
		plannerThinking: AUTO_THINKING,
		executor,
		executorThinking: ThinkingLevel.High,
		cooldownTurns: 2,
		maxConsecutive: 2,
		doneGate: "strict",
		manualSwitchIntent: "plan",
		signals: { enabled: true, sentiment: true, failureThreshold: 3, loopThreshold: 3, planningNeeded: true },
		...overrides,
	};
}

function fakeHost(overrides: Partial<FakeHost> = {}): FakeHost {
	const host: FakeHost = {
		streaming: false,
		orchestrator: true,
		planModeOn: false,
		model: otherModel,
		thinking: ThinkingLevel.Low,
		failSwitch: false,
		switches: [],
		thinkingChanges: [],
		ensured: [],
		stops: 0,
		pauses: 0,
		resumes: [],
		briefs: [],
		notices: [],
		persisted: [],
		orchestratorEnables: [],
		planModeEnables: [],
		currentModel() {
			return this.model;
		},
		availableModels() {
			return [planner, executor, otherModel];
		},
		isStreaming() {
			return this.streaming;
		},
		async setModelTemporary(model: Model, thinkingLevel?: ConfiguredThinkingLevel) {
			if (this.failSwitch) {
				throw new Error("switch failed");
			}
			this.switches.push({ model, thinkingLevel });
			this.model = model;
		},
		setThinkingLevel(level: ConfiguredThinkingLevel) {
			this.thinkingChanges.push(level);
			this.thinking = level;
		},
		configuredThinkingLevel() {
			return this.thinking;
		},
		ensureAdvisorStarted(pinned: Model) {
			this.ensured.push(pinned);
			return true;
		},
		stopDuoAdvisor() {
			this.stops += 1;
		},
		pauseAdvisor() {
			this.pauses += 1;
		},
		resumeAdvisor(catchupBrief?: string) {
			this.resumes.push(catchupBrief);
		},
		injectBrief(text: string, deliverAs: "steer" | "nextTurn") {
			this.briefs.push({ text, deliverAs });
		},
		emitNotice(level: "info" | "warning", text: string) {
			this.notices.push({ level, text });
		},
		persistSnapshot(snapshot: DuoStateSnapshot) {
			this.persisted.push(structuredClone(snapshot));
		},
		orchestratorEnabled() {
			return this.orchestrator;
		},
		setOrchestratorEnabled(enabled: boolean) {
			this.orchestratorEnables.push(enabled);
			this.orchestrator = enabled;
		},
		setPlanModeEnabled(enabled: boolean) {
			this.planModeEnables.push(enabled);
			this.planModeOn = enabled;
		},
		planModeActive() {
			return this.planModeOn;
		},
		...overrides,
	};
	return host;
}

function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map(part => part.text ?? "").join("\n");
}

describe("duo oversight contracts", () => {
	test("request_takeover routes plan requests to the plan callback and recover/default requests to recovery", async () => {
		const recoverCalls: { purpose: TakeoverPurpose; reason: string; directive: string }[] = [];
		const planCalls: string[] = [];
		const tool = new RequestTakeoverTool(
			(purpose, reason, directive): TakeoverDecision => {
				recoverCalls.push({ purpose, reason, directive });
				return "accepted";
			},
			async reason => {
				planCalls.push(reason);
				return true;
			},
		);

		await tool.execute("recover-explicit", {
			purpose: "recover",
			reason: "executor hit the same auth failure twice",
			directive: "repair the auth branch",
		});
		await tool.execute("recover-default", {
			reason: "executor cannot recover the migration",
			directive: "inspect the migration state",
		});
		const planResult = await tool.execute("plan", {
			purpose: "plan",
			reason: "new architecture decision before execution continues",
		});

		expect(recoverCalls).toEqual([
			{
				purpose: "recover",
				reason: "executor hit the same auth failure twice",
				directive: "repair the auth branch",
			},
			{
				purpose: "recover",
				reason: "executor cannot recover the migration",
				directive: "inspect the migration state",
			},
		]);
		expect(planCalls).toEqual(["new architecture decision before execution continues"]);
		expect(resultText(planResult)).toContain("Planning takeover accepted");
	});

	test("executor effort override applies immediately, survives snapshots, and drives later executor handoffs", async () => {
		const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ executorThinking: ThinkingLevel.High }));
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");

		expect(controller.setExecutorThinkingOverride(ThinkingLevel.XHigh, "two failed attempts")).toBe(true);

		expect(host.thinkingChanges).toEqual([ThinkingLevel.XHigh]);
		const persistedOverride = host.persisted.at(-1);
		expect(persistedOverride?.executorThinkingOverride).toBe(ThinkingLevel.XHigh);

		expect(await controller.requestPlanTakeover("planner must re-shape the approach")).toBe(true);
		host.switches.length = 0;
		expect(await controller.handoffToExecutor("plan complete")).toBe("ok");
		expect(host.switches).toEqual([{ model: executor, thinkingLevel: ThinkingLevel.XHigh }]);

		const restoredHost = fakeHost({ model: planner, orchestrator: true, planModeOn: false });
		const restoredController = new DuoController(
			restoredHost,
			duoConfig({ executorThinking: ThinkingLevel.High }),
			persistedOverride,
		);
		expect(await restoredController.handoffToExecutor("resume after snapshot restore")).toBe("ok");
		expect(restoredHost.switches).toEqual([{ model: executor, thinkingLevel: ThinkingLevel.XHigh }]);
	});

	test("set_executor_effort rejects below-high levels and accepts high, xhigh, and max", async () => {
		const accepted: { level: ThinkingLevel; reason: string }[] = [];
		const tool = new SetExecutorEffortTool((level, reason) => {
			accepted.push({ level, reason });
			return true;
		});

		for (const level of [ThinkingLevel.High, ThinkingLevel.XHigh, ThinkingLevel.Max]) {
			const result = await tool.execute(`accept-${level}`, { level, reason: `need ${level}` });
			expect(resultText(result)).toContain(`Executor effort override set to ${level}`);
		}

		for (const level of [ThinkingLevel.Low, ThinkingLevel.Medium, ThinkingLevel.Minimal]) {
			await expect(
				tool.execute(`reject-${level}`, { level: level as "high", reason: "routine work" }),
			).rejects.toThrow(ToolError);
		}
		expect(accepted.map(call => call.level)).toEqual([ThinkingLevel.High, ThinkingLevel.XHigh, ThinkingLevel.Max]);
	});
});
