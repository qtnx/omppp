import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { DuoResolvedConfig } from "../../config/model-resolver";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import { DuoController, type DuoControllerHost } from "../controller";
import type { DuoStateSnapshot } from "../state";

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
	onSwitch?: () => void;
}

function duoConfig(overrides: Partial<DuoResolvedConfig> = {}): DuoResolvedConfig {
	return {
		mode: "auto",
		planner,
		plannerThinking: AUTO_THINKING,
		executor,
		executorThinking: ThinkingLevel.Max,
		cooldownTurns: 2,
		maxConsecutive: 2,
		doneGate: "strict",
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
			this.onSwitch?.();
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
		},
		planModeActive() {
			return this.planModeOn;
		},
		...overrides,
	};
	return host;
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

	test("manual override survives reevaluate", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.model = otherModel;
		controller.notifyManualModelChange();
		const nonPlannerNotice = host.notices.at(-1)?.text;
		const switchCount = host.switches.length;

		await controller.reevaluate();
		expect(host.switches).toHaveLength(switchCount);
		expect(controller.status.executor).toBe("anthropic/claude-sonnet-4.5");
		expect(nonPlannerNotice).toBe("Duo executor set to anthropic/claude-sonnet-4.5 (manual switch).");
	});

	test("manual override to planner model emits one planning tip and summon protocol", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
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

	test("manual override to a non-planner model does not inject summon protocol", async () => {
		const host = fakeHost({ model: executor, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.briefs = [];
		host.model = otherModel;
		controller.notifyManualModelChange();

		expect(host.briefs.filter(brief => brief.text.includes("summons to reason"))).toHaveLength(0);
		expect(host.thinkingChanges).toEqual([]);
	});

	test("manual override to planner model re-summons after switching away", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.briefs = [];
		host.model = planner;
		controller.notifyManualModelChange();
		host.model = otherModel;
		controller.notifyManualModelChange();
		host.model = planner;
		controller.notifyManualModelChange();

		expect(host.briefs.filter(brief => brief.text.includes("summons to reason"))).toHaveLength(2);
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
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.notices = [];

		host.model = planner;
		controller.notifyManualModelChange();

		expect(host.pauses).toBe(1);
		expect(host.notices.at(-1)?.text).toContain("advisor paused");
		expect(controller.status.phase).toBe("executing");
	});

	test("switching away from the Fable model resumes the advisor", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		host.model = planner;
		controller.notifyManualModelChange();
		host.notices = [];

		host.model = otherModel;
		controller.notifyManualModelChange();

		expect(host.resumes).toHaveLength(1);
		expect(host.resumes.at(-1)).toBeUndefined();
		expect(host.notices.at(-1)?.text).toContain("resumed");
		expect(controller.status.phase).toBe("executing");
	});

	test("Fable dwell on the executing stream nags every third turn", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
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

	test("dwell counter resets when the executor model returns", async () => {
		const host = fakeHost({ model: otherModel, planModeOn: false });
		const controller = new DuoController(host, duoConfig());
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
		const controller = new DuoController(host, duoConfig());
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
		const controller = new DuoController(host, duoConfig());
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
		expect(host.ensured).toEqual([]);
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

		const decision = controller.requestTakeover("verify", "completion claim", "verify now");
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
		expect(host.ensured).toEqual([planner]);
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
		controller.requestTakeover("verify", "first", "verify");
		host.notices = [];

		expect(controller.requestTakeover("verify", "second", "verify")).toBe("rejected");
		expect(controller.requestTakeover("verify", "third", "verify")).toBe("rejected");
		expect(host.notices.filter(notice => notice.level === "warning")).toHaveLength(2);
	});

	test("handoffToExecutor switches, resumes advisor with handback brief, injects next-turn handback, and forceExec works from planning", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		controller.requestTakeover("verify", "claim", "verify");
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
		expect(planningHost.ensured).toEqual([planner]);
	});

	test("manual-change guard ignores self-initiated model changes and records external executor slot override", async () => {
		const host = fakeHost();
		let controller: DuoController | undefined;
		host.onSwitch = () => controller?.notifyManualModelChange();
		controller = new DuoController(host, duoConfig());

		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");
		expect(host.notices).toEqual([]);

		host.model = otherModel;
		controller.notifyManualModelChange();
		expect(controller.status.phase).toBe("executing");
		expect(host.persisted.at(-1)?.executorId).toBe("anthropic/claude-sonnet-4.5");
		expect(host.notices.at(-1)).toMatchObject({ level: "info" });
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

	test("flushPendingSwitch applies a queued switch without ticking the machine", async () => {
		const host = fakeHost({ streaming: true });
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");

		const decision = controller.requestTakeover("recover", "drift", "fix");
		expect(decision).toBe("accepted");
		expect(host.switches).toEqual([]);
		host.streaming = false;

		await controller.flushPendingSwitch();

		expect(host.switches.at(-1)).toEqual({ model: planner, thinkingLevel: AUTO_THINKING });
		expect(host.persisted.at(-1)).toMatchObject({ phase: "takeover", cooldownRemaining: 0 });
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
});
