import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { prompt } from "@oh-my-pi/pi-utils";
import type { DuoResolvedConfig } from "../../config/model-resolver";
import {
	type AgentSession,
	buildAdvisorSkillsAndRulesPrompt,
	buildSystemPromptWithOrchestratorOverlay,
	resolveDuoAdvisorStopAction,
	resolveDuoOrchestratorOwnership,
	shouldNotifyDuoPlanApproved,
} from "../../session/agent-session";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import type { ToolSession } from "../../tools";
import { DuoController, type DuoControllerHost, type DuoHandoffResult } from "../controller";
import advisorInstructionsRaw from "../prompts/advisor-instructions.md" with { type: "text" };
import duoExecutorOverlayRaw from "../prompts/executor-overlay.md" with { type: "text" };
import manualPlanBriefPrompt from "../prompts/manual-plan-brief.md" with { type: "text" };
import duoPlannerOverlayPrompt from "../prompts/planner-notice.md" with { type: "text" };
import type { DuoExecutionScope, DuoStateSnapshot } from "../state";

const _session = {} as AgentSession;
const _handoffCheck: (resolution: string, scope?: DuoExecutionScope) => Promise<DuoHandoffResult> =
	_session.duoHandoffToExecutor;
const _escalateCheck: NonNullable<ToolSession["duoEscalateToPlanner"]> = _session.duoEscalateToPlanner;
const _summonCheck: () => Promise<boolean> = _session.duoSummon;
void _handoffCheck;
void _escalateCheck;
void _summonCheck;

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

function duoConfig(overrides: Partial<DuoResolvedConfig> = {}): DuoResolvedConfig {
	return {
		mode: "on",
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

interface FakeHost extends DuoControllerHost {
	model: Model | undefined;
	planMode: boolean;
	planReady: boolean;
	switches: { model: Model; thinkingLevel?: ConfiguredThinkingLevel }[];
	ensured: Model[];
	persisted: DuoStateSnapshot[];
	reviveScheduled: number;
	briefs: string[];
}

function fakeHost(): FakeHost {
	return {
		model: planner,
		planMode: true,
		planReady: false,
		switches: [],
		ensured: [],
		persisted: [],
		reviveScheduled: 0,
		briefs: [],
		currentModel() {
			return this.model;
		},
		availableModels() {
			return [planner, executor];
		},
		isStreaming() {
			return false;
		},
		async setModelTemporary(model, thinkingLevel) {
			this.model = model;
			this.switches.push({ model, thinkingLevel });
		},
		setThinkingLevel() {},
		configuredThinkingLevel() {
			return ThinkingLevel.Medium;
		},
		ensureAdvisorStarted(pinned) {
			this.ensured.push(pinned);
			return true;
		},
		stopDuoAdvisor() {},
		pauseAdvisor() {},
		resumeAdvisor() {},
		injectBrief(text) {
			this.briefs.push(text);
		},
		emitNotice() {},
		persistSnapshot(snapshot) {
			this.persisted.push(snapshot);
		},
		orchestratorEnabled() {
			return false;
		},
		setOrchestratorEnabled() {},
		setPlanModeEnabled(enabled) {
			this.planMode = enabled;
		},
		planModeActive() {
			return this.planMode;
		},
		planArtifactReady() {
			return this.planReady;
		},
		scheduleAdvisorRevive() {
			this.reviveScheduled += 1;
		},
	};
}

describe("AgentSession duo wiring helpers", () => {
	test("plan approval notification drives executor switch and pins advisor to planner", async () => {
		expect(
			shouldNotifyDuoPlanApproved(
				{ enabled: true, planFilePath: "local://draft-plan.md", workflow: "parallel" },
				undefined,
				"local://approved-plan.md",
				true,
			),
		).toBe(true);
		expect(
			shouldNotifyDuoPlanApproved(
				{ enabled: true, planFilePath: "local://draft-plan.md", workflow: "parallel" },
				undefined,
				"local://approved-plan.md",
				false,
			),
		).toBe(false);

		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("planning");
		expect(host.switches.map(call => call.model.id)).toEqual([planner.id]);

		await controller.notifyPlanApproved();

		expect(controller.status.phase).toBe("executing");
		expect(host.switches.map(call => call.model.id)).toEqual([planner.id, executor.id]);
		expect(host.ensured.map(model => model.id)).toEqual([planner.id]);
	});

	test("planning artifact readiness is consumed by planning progress nudges", async () => {
		const host = fakeHost();
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("planning");

		host.briefs = [];
		await controller.notifyTurnEnd();
		expect(host.briefs).toEqual([]);

		host.planReady = true;
		await controller.notifyTurnEnd();
		expect(host.briefs.at(-1)).toContain("The plan is locked");
	});

	test("controller-side advisor startup failure schedules advisor revive", async () => {
		const host = fakeHost();
		host.model = executor;
		host.planMode = false;
		host.orchestratorEnabled = () => true;
		host.ensureAdvisorStarted = pinned => {
			host.ensured.push(pinned);
			return false;
		};
		const controller = new DuoController(host, duoConfig());

		await controller.reevaluate();

		expect(controller.status.phase).toBe("degraded");
		expect(host.reviveScheduled).toBe(1);
	});

	test("duo summon keeps executing phase and switches the main stream to the planner", async () => {
		const host = fakeHost();
		host.model = executor;
		host.planMode = false;
		host.orchestratorEnabled = () => true;
		const controller = new DuoController(host, duoConfig());
		await controller.reevaluate();
		expect(controller.status.phase).toBe("executing");

		const summoned = await controller.summonPlanner();

		expect(summoned).toBe(true);
		expect(controller.status.phase).toBe("executing");
		expect(host.switches.at(-1)?.model.id).toBe(planner.id);
		expect(host.briefs.at(-1)).toContain("summons");
	});

	test("duo planner overlay renders current main-stream model identity", () => {
		const rendered = prompt.render(duoPlannerOverlayPrompt, {
			current: "anthropic/claude-fable-5",
			planner: "anthropic/claude-fable-5",
			executor: "anthropic/claude-opus-4-8",
		});

		expect(rendered.split("\n")[0]).toBe(
			"Current main-stream model: anthropic/claude-fable-5 — duo planner: anthropic/claude-fable-5, executor: anthropic/claude-opus-4-8. When asked which model you are, answer from this line; never infer it from your role.",
		);
	});

	test("manual plan brief demands a complete locked plan handed off via duo_handoff", () => {
		const rendered = prompt.render(manualPlanBriefPrompt, {
			planArtifact: "local://PLAN.md",
			executor: "anthropic/claude-opus-4-8",
		});

		expect(rendered).toContain("COMPLETE");
		expect(rendered).toContain("local://PLAN.md");
		expect(rendered).toContain("duo_handoff");
		expect(rendered).not.toContain("{{");
	});

	test("executor overlay routes planning needs to duo_escalate, never plan-mode round-trips", () => {
		expect(duoExecutorOverlayRaw).toContain("duo_escalate");
		expect(duoExecutorOverlayRaw).not.toContain("re-enters plan mode");
	});

	test("advisor instructions name the automatic takeover signals and the strong-signal bypass", () => {
		expect(advisorInstructionsRaw).toContain("automatic");
		expect(advisorInstructionsRaw).toContain("bypass");
	});

	test("duo advisor stop clears the planner pin for user-owned advisors", () => {
		// Duo-owned advisor: full stop regardless of pin state.
		expect(resolveDuoAdvisorStopAction(true, planner, planner)).toBe("stop");
		expect(resolveDuoAdvisorStopAction(true, undefined, undefined)).toBe("stop");
		// User-owned advisor rebuilt on the duo planner pin: rebuild on the role model.
		expect(resolveDuoAdvisorStopAction(false, planner, planner)).toBe("rebuild");
		// User-owned advisor that never ran on the pin: untouched.
		expect(resolveDuoAdvisorStopAction(false, planner, executor)).toBe("none");
		expect(resolveDuoAdvisorStopAction(false, undefined, planner)).toBe("none");
		expect(resolveDuoAdvisorStopAction(false, planner, undefined)).toBe("none");
	});

	test("duo orchestrator ownership guard never tears down a user-owned session", () => {
		// Fresh off -> on flip driven by duo: duo takes ownership and enables.
		expect(resolveDuoOrchestratorOwnership(true, false, false)).toEqual({ apply: "enable", owns: true });
		// After a duo-driven enable, a disable releases what duo owns.
		expect(resolveDuoOrchestratorOwnership(false, true, true)).toEqual({ apply: "disable", owns: false });
		// User already had orchestrator on (no off->on flip): a no-op NEVER adopts,
		// so a later single-scope disable is refused and live mode stays orchestrator.
		expect(resolveDuoOrchestratorOwnership(true, true, false)).toEqual({ apply: undefined, owns: false });
		expect(resolveDuoOrchestratorOwnership(false, true, false)).toEqual({ apply: undefined, owns: false });
		// Disable when already off is a no-op regardless of ownership.
		expect(resolveDuoOrchestratorOwnership(false, false, true)).toEqual({ apply: undefined, owns: true });
	});

	test("executor overlay conditionally renders orchestrator vs direct-execution text by live state", () => {
		const orchestrated = prompt.render(duoExecutorOverlayRaw, {
			current: "anthropic/claude-opus-4-8",
			planner: "anthropic/claude-fable-5",
			executor: "anthropic/claude-opus-4-8",
			orchestrator: true,
		});
		expect(orchestrated).toContain("Safe orchestrator mode");
		expect(orchestrated).toContain("delegating to subagents");
		expect(orchestrated).not.toContain("direct-execution mode");
		expect(orchestrated).toContain("mandatory checkpoints");
		expect(orchestrated).toContain("Committing to a plan");
		expect(orchestrated).toContain("Ending your turn");
		expect(orchestrated).not.toContain("{{");

		const direct = prompt.render(duoExecutorOverlayRaw, {
			current: "anthropic/claude-opus-4-8",
			planner: "anthropic/claude-fable-5",
			executor: "anthropic/claude-opus-4-8",
			orchestrator: false,
		});
		expect(direct).toContain("direct-execution mode");
		expect(direct).toContain("orchestrator_mode");
		expect(direct).not.toContain("decomposing it into work packages");
		expect(direct).toContain("mandatory checkpoints");
		expect(direct).toContain("Committing to a plan");
		expect(direct).toContain("Ending your turn");
		expect(direct).not.toContain("{{");
		// Shared paragraphs stay outside the conditional in both variants.
		expect(orchestrated).toContain("watches as your advisor");
		expect(direct).toContain("watches as your advisor");
		expect(direct).toContain("duo_escalate");
	});

	test("orchestrator overlay preserves only the base Skills & Rules section", () => {
		const baseSkillsSection = [
			"# Skills & Rules",
			"Skills are specialized knowledge. If one matches your task, you MUST read `skill://<name>` before proceeding.",
			"<skills>",
			"- brainstorming: Use before creative work.",
			"- test-driven-development: Use before production code.",
			"</skills>",
		].join("\n");
		const baseInternalUrlsSection = [
			"# Internal URLs",
			"- `skill://<name>`: skill instructions; `/<path>` = file within",
			"- `rule://<name>`: rule details",
		].join("\n");
		const basePrompt = [
			["Base identity block.", baseSkillsSection, baseInternalUrlsSection].join("\n\n"),
			"Tool block",
		];

		const [orchestratorBlock, ...unchangedBlocks] = buildSystemPromptWithOrchestratorOverlay(basePrompt);

		expect(unchangedBlocks).toEqual(["Tool block"]);
		expect(orchestratorBlock).toContain("Safe orchestrator mode");
		expect(orchestratorBlock).toContain("`skill://<name>`");
		expect(orchestratorBlock).toContain("- brainstorming: Use before creative work.");
		expect(orchestratorBlock).toContain("- test-driven-development: Use before production code.");
		expect(orchestratorBlock).not.toContain("Base identity block.");
		expect(orchestratorBlock).not.toContain("# Internal URLs");
		expect(orchestratorBlock).not.toContain("- `rule://<name>`: rule details");
		expect(orchestratorBlock.slice(orchestratorBlock.indexOf("# Skills & Rules"))).toBe(baseSkillsSection);
	});
	test("advisor skills prompt preserves Skills & Rules and reminds advisor to supervise skill use", () => {
		const baseSkillsSection = [
			"# Skills & Rules",
			"Skills are specialized knowledge. If one matches your task, you MUST read `skill://<name>` before proceeding.",
			"<skills>",
			"- brainstorming: Use before creative work.",
			"- test-driven-development: Use before production code.",
			"</skills>",
		].join("\n");
		const baseInternalUrlsSection = [
			"# Internal URLs",
			"- `skill://<name>`: skill instructions; `/<path>` = file within",
			"- `rule://<name>`: rule details",
		].join("\n");
		const basePrompt = [
			["Base identity block.", baseSkillsSection, baseInternalUrlsSection].join("\n\n"),
			"Tool block",
		];

		const advisorSkillsPrompt = buildAdvisorSkillsAndRulesPrompt(basePrompt);

		expect(advisorSkillsPrompt).toContain(baseSkillsSection);
		expect(advisorSkillsPrompt).toMatch(/monitor(?:ing)? skill usage/i);
		expect(advisorSkillsPrompt).toMatch(/advise(?:s|d|r|ing)? (?:the )?(?:executor|subagent)/i);
		expect(advisorSkillsPrompt).toContain("`skill://<name>`");
		expect(advisorSkillsPrompt).toMatch(/when applicable/i);
		expect(advisorSkillsPrompt).not.toContain("Base identity block.");
		expect(advisorSkillsPrompt).not.toContain("# Internal URLs");
		expect(advisorSkillsPrompt).not.toContain("- `rule://<name>`: rule details");
		expect(buildAdvisorSkillsAndRulesPrompt(["Base identity block.", "Tool block"])).toBeUndefined();
	});
});
