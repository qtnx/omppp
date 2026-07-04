import { describe, expect, spyOn, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { DuoResolvedConfig } from "../../config/model-resolver";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import { DuoController, type DuoControllerHost } from "../controller";
import type { DuoStateSnapshot } from "../state";
import type { TakeoverSignalReport } from "../takeover-signals";

function anthropicModel(id: string): Model {
	const name = id
		.split("-")
		.map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join(" ");
	return buildModel({
		id,
		name,
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
	planArtifactReadyFlag: boolean;
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
	revives: number;
	continueRequests: number;
	onSwitch?: () => void;
}

function duoConfig(overrides: Partial<DuoResolvedConfig> = {}): DuoResolvedConfig {
	return {
		mode: "auto",
		orchestrator: "auto",
		planner,
		plannerThinking: AUTO_THINKING,
		executor,
		executorThinking: ThinkingLevel.Max,
		cooldownTurns: 2,
		maxConsecutive: 2,
		doneGate: "strict",
		advisorPromptReview: true,
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
		planArtifactReadyFlag: false,
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
		revives: 0,
		continueRequests: 0,
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
			this.onSwitch?.();
		},
		setThinkingLevel(level: ConfiguredThinkingLevel) {
			this.thinkingChanges.push(level);
			this.thinking = level;
		},
		configuredThinkingLevel() {
			return this.thinking;
		},
		planArtifactReady() {
			return this.planArtifactReadyFlag;
		},
		ensureAdvisorStarted(pinned: Model) {
			this.ensured.push(pinned);
			return true;
		},
		scheduleAdvisorRevive() {
			this.revives += 1;
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
		},
		planModeActive() {
			return this.planModeOn;
		},
		requestAgentContinue() {
			this.continueRequests += 1;
		},
		...overrides,
	};
	return host;
}

function signalReport(overrides: Partial<TakeoverSignalReport> = {}): TakeoverSignalReport {
	return {
		sentiment: false,
		consecutiveFailures: 0,
		loop: false,
		doneClaimWithoutEvidence: false,
		planningShapedWork: false,
		strong: false,
		evidence: [],
		...overrides,
	};
}

describe("DuoController", () => {
	test("reevaluate activates planning with planner switch, planner notice, pre-duo thinking, and persisted metadata", async () => {
		const host = fakeHost({ model: planner, planModeOn: true, thinking: ThinkingLevel.High });
		const controller = new DuoController(host, duoConfig());

		await controller.reevaluate();

		expect(controller.status).toMatchObject({
			phase: "planning",
			planner: "anthropic/claude-fable-5",
			executor: "anthropic/claude-opus-4.8",
			takeoverCount: 0,
			advisorPaused: false,
		});
		expect(host.switches).toEqual([{ model: planner, thinkingLevel: AUTO_THINKING }]);
		expect(host.briefs).toHaveLength(1);
		expect(host.briefs[0].deliverAs).toBe("nextTurn");
		expect(host.briefs[0].text).toContain("duo planning phase");
		expect(host.persisted.at(-1)).toMatchObject({
			phase: "planning",
			plannerId: "anthropic/claude-fable-5",
			executorId: "anthropic/claude-opus-4.8",
			preDuoThinking: ThinkingLevel.High,
		});
	});

	test("planning engages plan mode; handoff releases it and enters orchestrator mode", async () => {
		const host = fakeHost({ model: planner, planModeOn: true, orchestrator: false });
		const controller = new DuoController(host, duoConfig());

		await controller.reevaluate();
		expect(controller.status.phase).toBe("planning");
		expect(host.planModeEnables).toEqual([true]);
		expect(host.orchestratorEnables).toEqual([]);

		const handedOff = await controller.handoffToExecutor("plan locked");
		expect(handedOff).toBe("ok");
		expect(controller.status.phase).toBe("executing");
		expect(host.planModeEnables).toEqual([true, false]);
		expect(host.orchestratorEnables).toEqual([true]);
	});

	test("restored planning session re-engages plan mode on reevaluate", async () => {
		const restored: DuoStateSnapshot = {
			phase: "planning",
			takeoverCount: 0,
			consecutiveTakeovers: 0,
			cooldownRemaining: 0,
		};
		const host = fakeHost({ model: planner, planModeOn: true });
		const controller = new DuoController(host, duoConfig(), restored);

		await controller.reevaluate();

		expect(controller.status.phase).toBe("planning");
		// The activation branch is skipped on restore (previous phase is already
		// planning) — the idempotent reconciliation must still lock the tree.
		expect(host.planModeEnables).toEqual([true]);
	});

	test("restored executing session re-applies the executor model and advisor on reevaluate", async () => {
		const restored: DuoStateSnapshot = {
			phase: "executing",
			takeoverCount: 0,
			consecutiveTakeovers: 0,
			cooldownRemaining: 0,
		};
		const host = fakeHost({ model: planner, planModeOn: false });
		const controller = new DuoController(host, duoConfig(), restored);

		await controller.reevaluate();

		expect(controller.status.phase).toBe("executing");
		expect(host.switches.at(-1)).toEqual({ model: executor, thinkingLevel: ThinkingLevel.Max });
		expect(host.ensured).toEqual([planner]);
	});

	test("manual switch to a foreign model disables duo for the session", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.model = otherModel;

		controller.notifyManualModelChange();

		expect(controller.status.phase).toBe("inactive");
		expect(host.notices.at(-1)).toMatchObject({
			level: "info",
			text: expect.stringMatching(
				/Duo disabled: main model anthropic\/claude-sonnet-4\.5 is outside the Fable\/Opus pair/,
			),
		});
		const switchCount = host.switches.length;
		await controller.reevaluate();
		expect(controller.status.phase).toBe("inactive");
		expect(host.switches).toHaveLength(switchCount);
	});

	test("foreign manual model switch disables duo while executor-pair switches stay active", async () => {
		const controlHost = fakeHost({ model: executor, planModeOn: false });
		const controlController = new DuoController(controlHost, duoConfig());
		await controlController.reevaluate();

		controlHost.model = executor;
		controlController.notifyManualModelChange();

		expect(controlController.status.phase).toBe("executing");
		expect(controlHost.notices.some(notice => notice.text.includes("Duo disabled"))).toBe(false);

		const host = fakeHost({ model: executor, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();

		host.model = otherModel;
		controller.notifyManualModelChange();

		expect(controller.status.phase).toBe("inactive");
		expect(host.notices.at(-1)?.text).toMatch(
			/Duo disabled: main model anthropic\/claude-sonnet-4\.5 is outside the Fable\/Opus pair/,
		);
		expect(host.orchestratorEnables.at(-1)).toBe(false);
		await controller.reevaluate();
		expect(controller.status.phase).toBe("inactive");
	});

	test("manual switch to the planner during executing enters planning with the full-plan brief (default intent)", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.model = planner;
		const injectSpy = spyOn(host, "injectBrief");
		controller.notifyManualModelChange();
		expect(controller.status.phase).toBe("planning");
		expect(controller.status.executor).toBe("anthropic/claude-opus-4.8");
		expect(host.pauses).toBeGreaterThanOrEqual(1);
		expect(host.planModeEnables).not.toContain(true);
		const brief = host.briefs.at(-1);
		expect(brief?.deliverAs).toBe("nextTurn");
		expect(brief?.text).toContain("COMPLETE");
		expect(brief?.text).toContain("duo_handoff");
		expect(injectSpy).toHaveBeenCalledWith(expect.stringContaining("duo_handoff"), "nextTurn");
		expect(host.briefs.some(briefCall => briefCall.text.includes("summons to reason"))).toBe(false);
	});

	test("duo_handoff from manual planning restores the executor and never engaged literal plan mode", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		expect(await controller.handoffToExecutor("plan locked at local://PLAN.md")).toBe("ok");
		expect(controller.status.phase).toBe("executing");
		expect(host.switches.at(-1)?.model).toBe(executor);
		await controller.reevaluate();
		expect(host.planModeEnables).not.toContain(true);
	});

	test("manual planning suppresses the planner dwell nag", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		for (let index = 0; index < 6; index += 1) {
			await controller.notifyTurnEnd();
		}
		expect(host.notices.some(notice => notice.text.includes("held the executing stream"))).toBe(false);
	});

	test("manualSwitchIntent summon preserves the executor-slot override and summon brief", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		expect(controller.status.phase).toBe("executing");
		expect(controller.status.executor).toBe("anthropic/claude-fable-5");
		expect(host.briefs.some(brief => brief.text.includes("summons to reason"))).toBe(true);
	});

	test("summonPlanner puts the planner on the stream transiently and duo_handoff restores the executor", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(await controller.summonPlanner()).toBe(true);
		expect(host.model).toBe(planner);
		expect(controller.status.phase).toBe("executing");
		expect(host.briefs.some(brief => brief.text.includes("summons to reason"))).toBe(true);
		expect(await controller.handoffToExecutor("back to work")).toBe("ok");
		expect(host.model).toBe(executor);
	});

	test("manual override to planner model emits one planning tip and summon protocol", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.briefs = [];
		host.model = planner;
		controller.notifyManualModelChange();
		controller.notifyManualModelChange();

		const plannerTipNotices = host.notices.filter(
			notice =>
				notice.text ===
				"Duo executor set to anthropic/claude-fable-5 (manual switch). Tip: use /duo plan to put the planner on the main stream for planning.",
		);
		expect(plannerTipNotices).toHaveLength(1);
		const summonBriefs = host.briefs.filter(brief => brief.text.includes("summons to reason"));
		expect(summonBriefs).toHaveLength(1);
		expect(summonBriefs[0]).toMatchObject({ deliverAs: "nextTurn" });
		expect(host.thinkingChanges).toEqual([AUTO_THINKING]);
	});

	test("manual switch to a foreign model disables duo and restores pre-duo thinking without summon protocol", async () => {
		const host = fakeHost({ model: executor, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.briefs = [];
		host.model = otherModel;

		controller.notifyManualModelChange();

		expect(controller.status.phase).toBe("inactive");
		expect(host.briefs.filter(brief => brief.text.includes("summons to reason"))).toHaveLength(0);
		expect(host.thinkingChanges).toEqual([ThinkingLevel.Low]);
		expect(host.notices.some(notice => notice.text.startsWith("Duo executor set to"))).toBe(false);
	});

	test("manual switch to the planner is ignored after a foreign switch disables duo", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.briefs = [];
		host.model = planner;
		controller.notifyManualModelChange();
		host.model = otherModel;
		controller.notifyManualModelChange();
		host.model = planner;
		controller.notifyManualModelChange();

		expect(controller.status.phase).toBe("inactive");
		expect(host.briefs.filter(brief => brief.text.includes("summons to reason"))).toHaveLength(1);
		expect(host.notices.at(-1)?.text).toMatch(/outside the Fable\/Opus pair/);
	});

	test("manual planner model change during takeover does not inject summon protocol", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(await controller.escalateToPlanner("needs planner")).toBe(true);
		host.briefs = [];
		host.model = planner;
		controller.notifyManualModelChange();

		expect(controller.status.phase).toBe("takeover");
		expect(host.briefs.filter(brief => brief.text.includes("summons to reason"))).toHaveLength(0);
	});

	test("manual switch to the Fable model pauses the advisor", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.notices = [];

		host.model = planner;
		controller.notifyManualModelChange();

		expect(host.pauses).toBe(1);
		expect(host.notices.at(-1)?.text).toContain("advisor paused");
		expect(controller.status.phase).toBe("executing");
	});

	test("switching from the Fable model to a foreign model disables duo and stops the advisor", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		host.notices = [];
		const stopCount = host.stops;

		host.model = otherModel;
		controller.notifyManualModelChange();

		expect(host.stops).toBe(stopCount + 1);
		expect(host.resumes).toHaveLength(0);
		expect(host.notices.at(-1)?.text).toMatch(
			/Duo disabled: main model anthropic\/claude-sonnet-4\.5 is outside the Fable\/Opus pair/,
		);
		expect(controller.status.phase).toBe("inactive");
	});

	test("Fable dwell on the executing stream nags every third turn", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		host.notices = [];
		host.briefs = [];

		for (let index = 0; index < 6; index += 1) {
			await controller.notifyTurnEnd();
		}

		const dwellNotices = host.notices.filter(notice => notice.text.includes("held the executing stream"));
		expect(dwellNotices).toHaveLength(2);
		expect(dwellNotices[0]).toMatchObject({ level: "warning" });
		expect(dwellNotices[0].text).toContain("3 turns");
		expect(dwellNotices[1].text).toContain("6 turns");
		const dwellBriefs = host.briefs.filter(brief => brief.text.includes("Fable dwell"));
		expect(dwellBriefs).toHaveLength(2);
		expect(dwellBriefs[0]).toMatchObject({ deliverAs: "nextTurn" });
		expect(dwellBriefs[0].text).toContain("3 turns");
		expect(dwellBriefs[1].text).toContain("6 turns");
	});

	test("pending handoff to executor suppresses Fable dwell and resets later dwell cadence", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		host.notices = [];
		host.briefs = [];

		await controller.notifyTurnEnd();
		await controller.notifyTurnEnd();

		const emitSpy = spyOn(host, "emitNotice");
		const injectSpy = spyOn(host, "injectBrief");
		host.switches = [];
		host.streaming = true;

		expect(await controller.handoffToExecutor("back to opus")).toBe("ok");
		expect(host.switches).toEqual([]);
		expect(host.model).toBe(planner);

		emitSpy.mockClear();
		injectSpy.mockClear();
		host.notices = [];
		host.briefs = [];
		host.streaming = false;

		await controller.notifyTurnEnd();

		expect(emitSpy).not.toHaveBeenCalledWith("warning", expect.stringContaining("held the executing stream"));
		expect(injectSpy).not.toHaveBeenCalledWith(expect.stringContaining("Fable dwell"), "nextTurn");
		expect(host.notices.filter(notice => notice.text.includes("held the executing stream"))).toHaveLength(0);
		expect(host.briefs.filter(brief => brief.text.includes("Fable dwell"))).toHaveLength(0);

		host.model = planner;
		controller.notifyManualModelChange();
		emitSpy.mockClear();
		injectSpy.mockClear();
		host.notices = [];
		host.briefs = [];

		await controller.notifyTurnEnd();

		expect(emitSpy).not.toHaveBeenCalledWith("warning", expect.stringContaining("held the executing stream"));
		expect(injectSpy).not.toHaveBeenCalledWith(expect.stringContaining("Fable dwell"), "nextTurn");

		await controller.notifyTurnEnd();
		await controller.notifyTurnEnd();

		const dwellNotices = host.notices.filter(notice => notice.text.includes("held the executing stream"));
		expect(dwellNotices).toHaveLength(1);
		expect(dwellNotices[0].text).toContain("3 turns");
		const dwellBriefs = host.briefs.filter(brief => brief.text.includes("Fable dwell"));
		expect(dwellBriefs).toHaveLength(1);
		expect(dwellBriefs[0].text).toContain("3 turns");
	});

	test("dwell counter resets when the executor model returns", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		await controller.notifyTurnEnd();
		await controller.notifyTurnEnd();
		host.model = executor;
		controller.notifyManualModelChange();
		host.notices = [];
		host.briefs = [];

		for (let index = 0; index < 3; index += 1) {
			await controller.notifyTurnEnd();
		}

		expect(host.notices.filter(notice => notice.text.includes("held the executing stream"))).toHaveLength(0);
		expect(host.briefs.filter(brief => brief.text.includes("Fable dwell"))).toHaveLength(0);
	});

	test("no dwell nag outside executing", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		await controller.escalateToPlanner("needs planner");
		host.notices = [];
		host.briefs = [];

		for (let index = 0; index < 3; index += 1) {
			await controller.notifyTurnEnd();
		}

		expect(host.notices.filter(notice => notice.text.includes("held the executing stream"))).toHaveLength(0);
		expect(host.briefs.filter(brief => brief.text.includes("Fable dwell"))).toHaveLength(0);
	});

	test("duo_handoff in executing restores the resolved executor", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false, thinking: ThinkingLevel.Max });
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		host.switches = [];
		host.notices = [];

		expect(await controller.handoffToExecutor("back to opus")).toBe("ok");
		expect(host.switches).toEqual([{ model: executor, thinkingLevel: ThinkingLevel.Max }]);
		expect(host.resumes).toHaveLength(1);
		expect(host.notices.at(-1)?.text).toBe("Duo executor restored: anthropic/claude-opus-4.8 takes the main stream.");
		expect(controller.status.executor).toBe("anthropic/claude-opus-4.8");
	});

	test("handoff from takeover to a planner-equal executor slot keeps advisor paused", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ manualSwitchIntent: "summon" }));
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();

		expect(await controller.escalateToPlanner("needs planner")).toBe(true);
		expect(await controller.handoffToExecutor("resolved")).toBe("ok");

		expect(host.switches.at(-1)).toEqual({ model: planner, thinkingLevel: ThinkingLevel.Low });
		expect(host.resumes).toHaveLength(1);
		expect(host.pauses).toBe(3);
		expect(controller.status).toMatchObject({ phase: "executing", advisorPaused: false });
		expect(host.notices.at(-1)?.text).toContain("advisor paused");
	});

	test("restored takeover session re-applies the Fable model", async () => {
		const restored: DuoStateSnapshot = {
			phase: "takeover",
			takeoverCount: 1,
			consecutiveTakeovers: 1,
			cooldownRemaining: 0,
			takeoverPurpose: "recover",
		};
		const host = fakeHost({ model: executor, planModeOn: false });
		const controller = new DuoController(host, duoConfig(), restored);

		await controller.reevaluate();

		expect(controller.status.phase).toBe("takeover");
		expect(host.switches.at(-1)).toEqual({ model: planner, thinkingLevel: AUTO_THINKING });
		expect(controller.status.advisorPaused).toBe(true);
		expect(host.ensured).toEqual([planner]);
	});

	test("plan mode re-entry while executing returns the stream to the planner", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");

		expect(await controller.notifyPlanModeEntered()).toBe(true);

		expect(controller.status.phase).toBe("planning");
		expect(host.pauses).toBe(1);
		expect(host.switches.at(-1)).toEqual({ model: planner, thinkingLevel: AUTO_THINKING });
		expect(controller.status.takeoverCount).toBe(0);
		expect(host.planModeEnables).toContain(true);

		// No-op outside executing.
		expect(await controller.notifyPlanModeEntered()).toBe(false);
		expect(host.pauses).toBe(1);
	});

	test("reevaluate activates executing with executor switch and starts advisor pinned to planner", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());

		await controller.reevaluate();

		expect(controller.status.phase).toBe("executing");
		expect(host.switches).toEqual([{ model: executor, thinkingLevel: ThinkingLevel.Max }]);
		expect(host.ensured).toEqual([planner]);
		expect(host.persisted.at(-1)?.phase).toBe("executing");
	});

	test("mode on activates executing with orchestrator disabled and non-planner main model", async () => {
		const host = fakeHost({ orchestrator: false, model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig({ mode: "on" }));

		await controller.reevaluate();

		expect(controller.status.phase).toBe("executing");
		expect(host.switches).toEqual([{ model: executor, thinkingLevel: ThinkingLevel.Max }]);
		expect(host.persisted.at(-1)?.phase).toBe("executing");
	});

	test("mode off stays inactive even with orchestrator enabled and planner main model", async () => {
		const host = fakeHost({ orchestrator: true, model: planner, planModeOn: true });
		const controller = new DuoController(host, duoConfig({ mode: "off" }));

		await controller.reevaluate();

		expect(controller.status.phase).toBe("inactive");
		expect(host.switches).toEqual([]);
		expect(host.briefs).toEqual([]);
		expect(host.persisted.at(-1)?.phase).toBe("inactive");
	});

	test("reevaluate deactivates when activation condition is lost, stops advisor, restores thinking, and keeps current model", async () => {
		const host = fakeHost({ orchestrator: true, thinking: ThinkingLevel.Medium });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.switches = [];
		host.orchestrator = false;
		host.model = otherModel;

		await controller.reevaluate();

		expect(controller.status.phase).toBe("inactive");
		expect(host.stops).toBe(1);
		expect(host.thinkingChanges).toEqual([ThinkingLevel.Medium]);
		expect(host.switches).toEqual([]);
		expect(host.persisted.at(-1)?.phase).toBe("inactive");
	});

	test("streaming defers switches until turn end and only applies the latest pending switch", async () => {
		const host = fakeHost({ streaming: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();

		const decision = controller.requestTakeover("recover", "executor drift", "recover now");
		host.streaming = false;
		await controller.notifyTurnEnd();

		expect(decision).toBe("accepted");
		expect(host.switches).toEqual([{ model: planner, thinkingLevel: AUTO_THINKING }]);
		expect(controller.status.phase).toBe("takeover");
	});

	test("notifyPlanApproved switches to executor, starts advisor, persists, and injects no extra brief", async () => {
		const host = fakeHost({ model: planner, planModeOn: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.briefs = [];
		host.planModeOn = false;

		await controller.notifyPlanApproved();

		expect(controller.status.phase).toBe("executing");
		expect(host.switches.at(-1)).toEqual({ model: executor, thinkingLevel: ThinkingLevel.Max });
		expect(host.ensured).toEqual([planner, planner]);
		expect(host.briefs).toEqual([]);
		expect(host.persisted.at(-1)?.phase).toBe("executing");
	});

	test("requestTakeover accepted pauses advisor, switches planner, injects rendered takeover brief, and emits info", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.switches = [];

		const decision = controller.requestTakeover("recover", "executor looped", "inspect last command");

		expect(decision).toBe("accepted");
		expect(controller.status).toMatchObject({ phase: "takeover", takeoverPurpose: "recover", advisorPaused: true });
		expect(host.pauses).toBe(1);
		expect(host.switches).toEqual([{ model: planner, thinkingLevel: AUTO_THINKING }]);
		expect(host.briefs.at(-1)).toMatchObject({ deliverAs: "steer" });
		expect(host.briefs.at(-1)?.text).toContain("executor looped");
		expect(host.notices.at(-1)?.level).toBe("info");
		expect(host.persisted.at(-1)?.phase).toBe("takeover");
	});

	test("executor escalation switches to the planner and pauses the advisor", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");
		host.switches = [];

		expect(await controller.escalateToPlanner("stuck on X")).toBe(true);
		expect(controller.status).toMatchObject({ phase: "takeover", takeoverPurpose: "recover", advisorPaused: true });
		expect(host.pauses).toBe(1);
		expect(host.switches.at(-1)).toEqual({ model: planner, thinkingLevel: AUTO_THINKING });
		expect(host.briefs.at(-1)?.text).toContain("stuck on X");

		expect(await controller.escalateToPlanner("again")).toBe(false);
	});

	test("requestTakeover cooldown-advice performs no switch or pause", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.requestTakeover("recover", "drift", "plan");
		await controller.handoffToExecutor("resolved");
		host.switches = [];
		host.pauses = 0;
		host.notices = [];

		const decision = controller.requestTakeover("recover", "again", "advise");

		expect(decision).toBe("cooldown-advice");
		expect(host.switches).toEqual([]);
		expect(host.pauses).toBe(0);
		expect(host.notices).toEqual([]);
	});

	test("requestTakeover rejected emits one warning per rejected request", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig({ maxConsecutive: 1 }));
		await controller.reevaluate();
		controller.requestTakeover("recover", "first", "recover");
		host.notices = [];

		expect(controller.requestTakeover("recover", "second", "recover")).toBe("rejected");
		expect(controller.requestTakeover("recover", "third", "recover")).toBe("rejected");
		expect(host.notices.filter(notice => notice.level === "warning")).toHaveLength(2);
	});

	test("handoffToExecutor switches, resumes advisor with handback brief, injects next-turn handback, and forceExec works from planning", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.requestTakeover("recover", "claim", "recover");
		host.switches = [];

		expect(await controller.handoffToExecutor("verified and ready")).toBe("ok");
		expect(controller.status).toMatchObject({ phase: "executing", advisorPaused: false });
		expect(host.switches).toEqual([{ model: executor, thinkingLevel: ThinkingLevel.Max }]);
		expect(host.resumes.at(-1)).toContain("verified and ready");
		expect(host.briefs.at(-1)).toMatchObject({ deliverAs: "nextTurn" });
		expect(host.persisted.at(-1)?.phase).toBe("executing");

		const planningHost = fakeHost({ model: planner, planModeOn: true });
		const planningController = new DuoController(planningHost, duoConfig());
		await planningController.reevaluate();
		expect(await planningController.forceExec()).toBe("ok");
		expect(planningController.status.phase).toBe("executing");
		expect(planningHost.ensured).toEqual([planner, planner]);
	});

	test("manual-change guard ignores self-initiated model changes and disables on external foreign switches", async () => {
		const host = fakeHost();
		let controller: DuoController | undefined;
		host.onSwitch = () => controller?.notifyManualModelChange();
		controller = new DuoController(host, duoConfig());

		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");
		expect(host.notices).toEqual([]);

		host.model = otherModel;
		controller.notifyManualModelChange();
		expect(controller.status.phase).toBe("inactive");
		expect(host.persisted.at(-1)?.phase).toBe("inactive");
		expect(host.notices.at(-1)).toMatchObject({
			level: "info",
			text: expect.stringMatching(/outside the Fable\/Opus pair/),
		});
	});

	test("advisor drop degrades executing state and emits warning", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();

		controller.notifyAdvisorDropped();

		expect(controller.status.phase).toBe("degraded");
		expect(host.notices.at(-1)).toMatchObject({ level: "warning" });
		expect(host.persisted.at(-1)?.phase).toBe("degraded");
	});

	test("handoff from degraded restores the executor", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.notifyAdvisorDropped();
		host.model = planner;
		host.switches = [];

		expect(await controller.handoffToExecutor("advisor failed")).toBe("ok");

		expect(controller.status.phase).toBe("degraded");
		expect(host.switches.at(-1)).toEqual({ model: executor, thinkingLevel: ThinkingLevel.Max });
		expect(host.notices.at(-1)?.text).toBe("Duo executor restored: anthropic/claude-opus-4.8 takes the main stream.");
	});

	test("handoff already on executor returns already-executor", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.switches = [];

		expect(await controller.handoffToExecutor("already on opus")).toBe("already-executor");

		expect(host.switches).toEqual([]);
		expect(controller.status.phase).toBe("executing");
	});

	test("degraded reevaluate re-applies the executor model", async () => {
		const restored: DuoStateSnapshot = {
			phase: "degraded",
			takeoverCount: 0,
			consecutiveTakeovers: 0,
			cooldownRemaining: 0,
		};
		const host = fakeHost({ model: planner, planModeOn: false });
		const controller = new DuoController(host, duoConfig(), restored);

		await controller.reevaluate();

		expect(host.switches.at(-1)).toEqual({ model: executor, thinkingLevel: ThinkingLevel.Max });
		expect(controller.status.phase).toBe("executing");
	});

	test("Fable dwell nag fires while degraded", async () => {
		const restored: DuoStateSnapshot = {
			phase: "degraded",
			takeoverCount: 0,
			consecutiveTakeovers: 0,
			cooldownRemaining: 0,
		};
		const host = fakeHost({ model: planner, planModeOn: false });
		const controller = new DuoController(host, duoConfig(), restored);

		for (let index = 0; index < 3; index += 1) {
			await controller.notifyTurnEnd();
		}

		const dwellNotices = host.notices.filter(notice => notice.text.includes("held the executing stream"));
		expect(dwellNotices).toHaveLength(1);
		expect(dwellNotices[0].text).toContain("3 turns");
		const dwellBriefs = host.briefs.filter(brief => brief.text.includes("Fable dwell"));
		expect(dwellBriefs).toHaveLength(1);
	});

	test("setModelTemporary rejection suspends and never throws", async () => {
		const host = fakeHost({ failSwitch: true });
		const controller = new DuoController(host, duoConfig());

		await expect(controller.reevaluate()).resolves.toBeUndefined();

		expect(controller.status.phase).toBe("suspended");
		expect(host.notices.at(-1)).toMatchObject({ level: "warning" });
		expect(host.persisted.at(-1)).toMatchObject({ phase: "suspended", suspendReason: "set-model-failed" });
	});

	test("notifyTurnEnd ticks executor cooldown to zero and persists each transition", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig({ cooldownTurns: 2 }));
		await controller.reevaluate();
		controller.requestTakeover("recover", "drift", "fix");
		await controller.handoffToExecutor("fixed");
		const persistedBeforeTicks = host.persisted.length;

		await controller.notifyTurnEnd();
		await controller.notifyTurnEnd();

		expect(host.persisted.length).toBe(persistedBeforeTicks + 2);
		expect(host.persisted.at(-1)).toMatchObject({ cooldownRemaining: 0, consecutiveTakeovers: 0 });
	});

	test("notifyTurnEnd applies a pending handback switch and still ticks cooldown", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig({ cooldownTurns: 2 }));
		await controller.reevaluate();
		controller.requestTakeover("recover", "drift", "fix");
		host.streaming = true;
		await controller.handoffToExecutor("fixed");
		host.switches = [];
		host.streaming = false;

		await controller.notifyTurnEnd();

		expect(host.switches).toEqual([{ model: executor, thinkingLevel: ThinkingLevel.Max }]);
		expect(host.persisted.at(-1)).toMatchObject({ phase: "executing", cooldownRemaining: 1 });
	});

	test("planning nudges duo_handoff only once the plan artifact exists, escalating when ignored", async () => {
		const host = fakeHost({ model: planner, planModeOn: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		await controller.notifyTurnEnd();
		await controller.notifyTurnEnd();
		expect(host.briefs.filter(brief => brief.text.includes("duo_handoff NOW"))).toHaveLength(0);
		const injectSpy = spyOn(host, "injectBrief");
		const noticeSpy = spyOn(host, "emitNotice");
		host.planArtifactReadyFlag = true;
		await controller.notifyTurnEnd();
		expect(host.briefs.at(-1)?.text).toContain("duo_handoff NOW");
		const noticesBefore = host.notices.length;
		expect(injectSpy).toHaveBeenCalledWith(expect.stringContaining("duo_handoff NOW"), "nextTurn");
		await controller.notifyTurnEnd();
		expect(host.notices.length).toBeGreaterThan(noticesBefore);
		expect(host.notices.at(-1)?.level).toBe("warning");
		expect(host.notices.at(-1)?.text).toContain("duo_handoff");
		expect(noticeSpy).toHaveBeenCalledWith("warning", expect.stringContaining("duo_handoff"));
	});

	test("handoff during streaming queues the Fable to Opus switch and notifyTurnEnd applies it with continuation", async () => {
		const host = fakeHost({ model: planner, planModeOn: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.streaming = true;
		expect(await controller.handoffToExecutor("plan locked")).toBe("ok");
		expect(host.model).toBe(planner);
		host.streaming = false;
		await controller.notifyTurnEnd();
		expect(host.model).toBe(executor);
		expect(controller.status.phase).toBe("executing");
		expect(host.continueRequests).toBe(1);
	});

	test("streaming escalation auto-continues after notifyTurnEnd applies the planner switch", async () => {
		const host = fakeHost({ streaming: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(await controller.escalateToPlanner("needs planner")).toBe(true);
		expect(host.switches).toEqual([]);
		host.streaming = false;

		await controller.notifyTurnEnd();

		expect(host.switches.at(-1)).toEqual({ model: planner, thinkingLevel: AUTO_THINKING });
		expect(host.continueRequests).toBe(1);
	});

	test("notifyTurnEnd without a pending switch does not request continuation", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.continueRequests = 0;

		await controller.notifyTurnEnd();

		expect(host.continueRequests).toBe(0);
	});

	test("fresh planning activation switches to planner without requesting continuation", async () => {
		const host = fakeHost({ model: planner, planModeOn: true });
		const controller = new DuoController(host, duoConfig());

		await controller.reevaluate();

		expect(controller.status.phase).toBe("planning");
		expect(host.switches.at(-1)).toEqual({ model: planner, thinkingLevel: AUTO_THINKING });
		expect(host.continueRequests).toBe(0);
	});

	test("idle handoff applies immediately and requests continuation", async () => {
		const host = fakeHost({ model: planner, planModeOn: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.switches = [];

		expect(await controller.handoffToExecutor("plan locked")).toBe("ok");

		expect(host.switches.at(-1)).toEqual({ model: executor, thinkingLevel: ThinkingLevel.Max });
		expect(host.continueRequests).toBe(1);
	});

	test("controller-side advisor start failure schedules a revive; recovery unblocks takeover", async () => {
		const host = fakeHost({ model: executor });
		let advisorUp = false;
		host.ensureAdvisorStarted = (pinned: Model) => {
			host.ensured.push(pinned);
			return advisorUp;
		};
		const reviveSpy = spyOn(host, "scheduleAdvisorRevive");
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("degraded");
		expect(host.revives).toBeGreaterThanOrEqual(1);
		expect(reviveSpy).toHaveBeenCalled();
		expect(controller.requestTakeover("recover", "stuck", "unstick")).toBe("rejected");
		advisorUp = true;
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");
		expect(controller.requestTakeover("recover", "stuck", "unstick")).toBe("accepted");
	});

	test("strong auto signal takes over even during the recover cooldown", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.requestTakeover("recover", "seed", "d")).toBe("accepted");
		expect(await controller.handoffToExecutor("resolved")).toBe("ok");
		const requestSpy = spyOn(controller, "requestTakeover");
		controller.notifyAutoSignals(
			signalReport({
				strong: true,
				sentiment: true,
				consecutiveFailures: 3,
				evidence: ["negative user sentiment", "3 consecutive failed tool results"],
			}),
		);
		expect(requestSpy).toHaveBeenCalledWith(
			"recover",
			expect.stringContaining("Automatic signal"),
			expect.stringContaining("Diagnose"),
			{ bypassCooldown: true },
		);
		expect(controller.status.phase).toBe("takeover");
		expect(controller.status.takeoverPurpose).toBe("recover");
	});
	test("loop signal alone respects the cooldown as advice without takeover", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.requestTakeover("recover", "seed", "d")).toBe("accepted");
		expect(await controller.handoffToExecutor("resolved")).toBe("ok");
		controller.notifyAutoSignals(signalReport({ loop: true, evidence: ["loop"] }));
		expect(controller.status.phase).toBe("executing");
	});

	test("unverified done-claim signal does not request a takeover", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		const requestSpy = spyOn(controller, "requestTakeover");

		controller.notifyAutoSignals(
			signalReport({ doneClaimWithoutEvidence: true, evidence: ["done without verification"] }),
		);

		expect(requestSpy).not.toHaveBeenCalled();
		expect(controller.status.phase).toBe("executing");
	});

	test("auto signals are inert when disabled, when not executing, or when the planner holds the stream", async () => {
		const disabledHost = fakeHost();
		const disabled = new DuoController(
			disabledHost,
			duoConfig({
				signals: { enabled: false, sentiment: true, failureThreshold: 3, loopThreshold: 3, planningNeeded: true },
			}),
		);
		await disabled.reevaluate();
		disabled.notifyAutoSignals(signalReport({ strong: true }));
		expect(disabled.status.phase).toBe("executing");

		const takeoverHost = fakeHost();
		const takeoverController = new DuoController(takeoverHost, duoConfig());
		await takeoverController.reevaluate();
		expect(takeoverController.requestTakeover("recover", "seed", "recover")).toBe("accepted");
		takeoverController.notifyAutoSignals(signalReport({ strong: true }));
		expect(takeoverController.status.phase).toBe("takeover");

		const summonHost = fakeHost();
		const summoned = new DuoController(summonHost, duoConfig());
		await summoned.reevaluate();
		await summoned.summonPlanner();
		summoned.notifyAutoSignals(signalReport({ strong: true }));
		expect(summoned.status.phase).toBe("executing");
	});

	test("strong signal rejected at the consecutive cap surfaces the manual escape hatch", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig({ maxConsecutive: 0 }));
		await controller.reevaluate();
		controller.notifyAutoSignals(signalReport({ strong: true, evidence: ["x"] }));
		expect(controller.status.phase).toBe("executing");
		expect(host.notices.at(-1)?.level).toBe("warning");
		expect(host.notices.at(-1)?.text).toContain("/duo");
	});

	test("planning-shaped executor work draws one duo_escalate nudge per streak", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.notifyAutoSignals(signalReport({ planningShapedWork: true }));
		controller.notifyAutoSignals(signalReport({ planningShapedWork: true }));
		expect(host.briefs.filter(brief => brief.text.includes("duo_escalate"))).toHaveLength(1);
		controller.notifyAutoSignals(signalReport());
		controller.notifyAutoSignals(signalReport({ planningShapedWork: true }));
		expect(host.briefs.filter(brief => brief.text.includes("duo_escalate"))).toHaveLength(2);
	});

	test("flushPendingSwitch applies a queued switch, requests continuation, and notifyTurnEnd does not double-request", async () => {
		const host = fakeHost({ streaming: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");

		expect(await controller.escalateToPlanner("needs planner")).toBe(true);
		expect(host.switches).toEqual([]);
		host.streaming = false;

		await controller.flushPendingSwitch();
		await controller.notifyTurnEnd();

		expect(host.switches.at(-1)).toEqual({ model: planner, thinkingLevel: AUTO_THINKING });
		expect(host.persisted.at(-1)).toMatchObject({ phase: "takeover", cooldownRemaining: 0 });
		expect(host.continueRequests).toBe(1);
	});

	test("failed queued switch clears pending switch without requesting continuation", async () => {
		const host = fakeHost({ streaming: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(await controller.escalateToPlanner("needs planner")).toBe(true);
		host.streaming = false;
		host.failSwitch = true;

		await controller.notifyTurnEnd();

		expect(controller.status.phase).toBe("suspended");
		expect(host.continueRequests).toBe(0);
	});

	test("deactivate stops advisor, restores thinking, persists, and dispose drops pending switch without host calls", async () => {
		const host = fakeHost({ streaming: true, thinking: ThinkingLevel.Low });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.dispose();
		host.streaming = false;
		await controller.notifyTurnEnd();
		expect(host.switches).toEqual([]);

		await controller.deactivate();

		expect(controller.status.phase).toBe("inactive");
		expect(host.stops).toBe(1);
		expect(host.thinkingChanges).toEqual([ThinkingLevel.Low]);
		expect(host.persisted.at(-1)?.phase).toBe("inactive");
	});

	describe("requestPlanTakeover", () => {
		test("enters planning, switches to the planner synchronously, injects the full-plan brief, pauses the advisor", async () => {
			const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
			const controller = new DuoController(host, duoConfig());
			await controller.reevaluate();
			expect(controller.status.phase).toBe("executing");

			const engaged = await controller.requestPlanTakeover("imperative build verb; itemized scope list");

			expect(engaged).toBe(true);
			expect(controller.status.phase).toBe("planning");
			expect(host.switches.at(-1)?.model.id).toBe(planner.id);
			expect(host.briefs.at(-1)?.text).toContain("COMPLETE");
			expect(host.briefs.at(-1)?.text).toContain("duo_handoff");
			expect(host.pauses).toBeGreaterThanOrEqual(1);
			const notice = host.notices.at(-1);
			expect(notice?.text).toContain("planning takeover");
			expect(notice?.text).toContain("imperative build verb");
			expect(notice?.text).toContain("/duo exec");
		});

		test("no-ops when not executing or when the planner already holds the stream", async () => {
			const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
			const controller = new DuoController(host, duoConfig());
			await controller.reevaluate();
			await controller.requestPlanTakeover("first");
			const switchesAfterFirst = host.switches.length;

			expect(await controller.requestPlanTakeover("second")).toBe(false);
			expect(host.switches.length).toBe(switchesAfterFirst);

			const host2 = fakeHost({ model: planner, orchestrator: true, planModeOn: false });
			const controller2 = new DuoController(host2, duoConfig({ mode: "on" }));
			await controller2.reevaluate();
			host2.model = planner;
			if (controller2.status.phase === "executing") {
				expect(await controller2.requestPlanTakeover("noop")).toBe(false);
			}

			const host3 = fakeHost({
				model: executor,
				orchestrator: true,
				planModeOn: false,
				availableModels() {
					return [executor, otherModel];
				},
			});
			const controller3 = new DuoController(host3, duoConfig());
			await controller3.reevaluate();
			expect(await controller3.requestPlanTakeover("unavailable")).toBe(false);
		});

		test("a failing model switch suspends duo and reports false", async () => {
			const host = fakeHost({ model: executor, orchestrator: true, planModeOn: false });
			const controller = new DuoController(host, duoConfig());
			await controller.reevaluate();
			host.failSwitch = true;

			expect(await controller.requestPlanTakeover("reason")).toBe(false);
			expect(controller.status.phase).toBe("suspended");
		});
	});

	describe("scope-aware orchestrator toggling", () => {
		test("planning handoff scope:single disables orchestrator and persists single scope", async () => {
			const host = fakeHost({ model: planner, planModeOn: true, orchestrator: false });
			const controller = new DuoController(host, duoConfig());
			await controller.reevaluate();
			expect(controller.status.phase).toBe("planning");
			expect(host.orchestratorEnables).toEqual([]);

			expect(await controller.handoffToExecutor("plan locked", "single")).toBe("ok");

			expect(controller.status.phase).toBe("executing");
			expect(host.orchestratorEnables).toEqual([false]);
			expect(host.persisted.at(-1)?.executionScope).toBe("single");
		});

		test("summon-return handoff without scope leaves orchestrator untouched", async () => {
			const host = fakeHost({ model: planner, planModeOn: true, orchestrator: false });
			const controller = new DuoController(host, duoConfig());
			await controller.reevaluate();
			expect(await controller.handoffToExecutor("plan locked", "single")).toBe("ok");
			expect(await controller.summonPlanner()).toBe(true);

			const before = host.orchestratorEnables.length;
			expect(await controller.handoffToExecutor("back to work")).toBe("ok");

			expect(host.orchestratorEnables.length).toBe(before);
			expect(host.persisted.at(-1)?.executionScope).toBe("single");
		});

		test("summon-return handoff with scope updates orchestrator and injects the handback brief", async () => {
			const host = fakeHost({ model: planner, planModeOn: true, orchestrator: true });
			const controller = new DuoController(host, duoConfig());
			await controller.reevaluate();
			expect(await controller.handoffToExecutor("plan locked", "multi")).toBe("ok");
			expect(await controller.summonPlanner()).toBe(true);

			host.briefs = [];
			expect(await controller.handoffToExecutor("single-phase follow-up", "single")).toBe("ok");

			expect(host.orchestratorEnables.at(-1)).toBe(false);
			expect(host.persisted.at(-1)?.executionScope).toBe("single");
			expect(host.briefs.at(-1)?.text).toContain("single-phase follow-up");
		});

		test("recover handback without scope keeps single scope (no force-on)", async () => {
			const host = fakeHost({ model: planner, planModeOn: true, orchestrator: false });
			const controller = new DuoController(host, duoConfig());
			await controller.reevaluate();
			expect(await controller.handoffToExecutor("plan locked", "single")).toBe("ok");
			expect(controller.requestTakeover("recover", "claim", "recover now")).toBe("accepted");

			const before = host.orchestratorEnables.length;
			expect(await controller.handoffToExecutor("recovered")).toBe("ok");

			expect(host.orchestratorEnables.slice(before)).not.toContain(true);
			expect(host.persisted.at(-1)?.executionScope).toBe("single");
		});

		test("orchestrator:always forces orchestrator on despite scope single", async () => {
			const host = fakeHost({ model: planner, planModeOn: true, orchestrator: false });
			const controller = new DuoController(host, duoConfig({ orchestrator: "always" }));
			await controller.reevaluate();

			expect(await controller.handoffToExecutor("plan locked", "single")).toBe("ok");

			expect(host.orchestratorEnables.at(-1)).toBe(true);
			expect(host.persisted.at(-1)?.executionScope).toBe("single");
		});

		test("deactivate releases orchestrator mode", async () => {
			const host = fakeHost({ model: planner, planModeOn: true });
			const controller = new DuoController(host, duoConfig());
			await controller.reevaluate();

			await controller.deactivate();

			expect(controller.status.phase).toBe("inactive");
			expect(host.orchestratorEnables.at(-1)).toBe(false);
		});
	});

	test("mid-turn handoff after escalation resumes the advisor and does not re-pause it", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");
		host.pauses = 0;
		host.resumes = [];

		host.streaming = true;
		expect(await controller.escalateToPlanner("stuck")).toBe(true);
		expect(host.pauses).toBe(1);

		host.streaming = false;
		await controller.notifyTurnEnd();
		expect(host.model).toBe(planner);

		host.streaming = true;
		expect(await controller.handoffToExecutor("resolved")).toBe("ok");
		expect(host.resumes).toHaveLength(1);
		expect(host.pauses).toBe(1);

		host.streaming = false;
		await controller.notifyTurnEnd();
		expect(host.switches.at(-1)?.model).toEqual(executor);
		expect(host.pauses).toBe(1);
		expect(controller.status).toMatchObject({ phase: "executing", advisorPaused: false });
	});

	test("plan approval resumes the advisor paused by plan-mode re-entry", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");
		host.pauses = 0;
		host.resumes = [];
		host.ensured = [];

		expect(await controller.notifyPlanModeEntered()).toBe(true);
		expect(host.pauses).toBe(1);

		host.planModeOn = false;
		await controller.notifyPlanApproved();

		expect(host.resumes).toHaveLength(1);
		expect(host.pauses).toBe(1);
		expect(controller.status).toMatchObject({ phase: "executing", advisorPaused: false });
		expect(host.ensured).toContainEqual(planner);
	});
});
