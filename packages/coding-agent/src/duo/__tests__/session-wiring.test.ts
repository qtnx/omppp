import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { prompt } from "@oh-my-pi/pi-utils";
import type { DuoResolvedConfig } from "../../config/model-resolver";
import type { AgentSession } from "../../session/agent-session";
import {
	handleDuoEscalateVerifyVerdict,
	resolveDuoAdvisorStopAction,
	shouldNotifyDuoPlanApproved,
} from "../../session/agent-session";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import type { ToolSession } from "../../tools";
import { DuoController, type DuoControllerHost, type DuoHandoffResult } from "../controller";
import duoPlannerOverlayPrompt from "../prompts/planner-notice.md" with { type: "text" };
import type { DuoStateSnapshot } from "../state";

const _session = {} as AgentSession;
const _handoffCheck: (resolution: string) => Promise<DuoHandoffResult> = _session.duoHandoffToExecutor;
const _escalateCheck: NonNullable<ToolSession["duoEscalateToPlanner"]> = _session.duoEscalateToPlanner;
void _handoffCheck;
void _escalateCheck;

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

interface FakeHost extends DuoControllerHost {
	model: Model | undefined;
	planMode: boolean;
	switches: { model: Model; thinkingLevel?: ConfiguredThinkingLevel }[];
	ensured: Model[];
	persisted: DuoStateSnapshot[];
}

function fakeHost(): FakeHost {
	return {
		model: planner,
		planMode: true,
		switches: [],
		ensured: [],
		persisted: [],
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
		injectBrief() {},
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
	};
}

describe("AgentSession duo wiring helpers", () => {
	test("escalate_verify verdict requests a verify takeover and defers stop when accepted", () => {
		const calls: { purpose: "verify"; reason: string; directive: string }[] = [];
		let emitted = 0;

		const deferred = handleDuoEscalateVerifyVerdict(
			{
				verdict: "escalate_verify",
				note: "claim lacks proof",
				missing: ["fresh test output", "browser evidence"],
			},
			(purpose, reason, directive) => {
				calls.push({ purpose, reason, directive });
				return "accepted";
			},
			() => {
				emitted++;
			},
		);

		expect(deferred).toBe(true);
		expect(calls).toEqual([
			{
				purpose: "verify",
				reason: "claim lacks proof",
				directive: "fresh test output; browser evidence",
			},
		]);
		expect(emitted).toBe(1);
	});

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
		expect(host.ensured.map(model => model.id)).toEqual([planner.id, planner.id]);
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
});
