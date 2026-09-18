import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { prompt } from "@oh-my-pi/pi-utils";
import type { DuoResolvedConfig } from "../config/model-resolver";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import advisorInstructions from "./prompts/advisor-instructions.md" with { type: "text" };
import autoSignalDirective from "./prompts/auto-signal-directive.md" with { type: "text" };
import effortChangeNotice from "./prompts/effort-change-notice.md" with { type: "text" };
import handbackBrief from "./prompts/handback-brief.md" with { type: "text" };
import manualPlanBrief from "./prompts/manual-plan-brief.md" with { type: "text" };
import planTakeoverNotice from "./prompts/plan-takeover-notice.md" with { type: "text" };
import plannerHandoffNudge from "./prompts/planner-handoff-nudge.md" with { type: "text" };
import plannerNotice from "./prompts/planner-notice.md" with { type: "text" };
import plannerSummon from "./prompts/planner-summon.md" with { type: "text" };
import planningSignalNudge from "./prompts/planning-signal-nudge.md" with { type: "text" };
import takeoverBrief from "./prompts/takeover-brief.md" with { type: "text" };
import type { TurnSignals, WorkPhase } from "../signals/index";
import {
	type DuoActivationInput,
	type DuoExecutionScope,
	type DuoMode,
	type DuoPhase,
	DuoStateMachine,
	type DuoStateSnapshot,
	type TakeoverDecision,
	type TakeoverPurpose,
	type TakeoverRequestOptions,
} from "./state";
import type { TakeoverSignalReport } from "./takeover-signals";

export interface DuoControllerHost {
	currentModel(): Model | undefined;
	availableModels(): Model[];
	isStreaming(): boolean;
	setModelTemporary(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void>;
	setThinkingLevel(level: ConfiguredThinkingLevel): void;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	ensureAdvisorStarted(pinned: Model): boolean;
	stopDuoAdvisor(): void;
	scheduleAdvisorRevive?(retryAfterMs?: number): void;
	pauseAdvisor(): void;
	resumeAdvisor(catchupBrief?: string): void;
	planArtifactReady?(): boolean;
	injectBrief(text: string, deliverAs: "steer" | "nextTurn"): void;
	emitNotice(level: "info" | "warning", text: string): void;
	persistSnapshot(snapshot: DuoStateSnapshot): void;
	orchestratorEnabled(): boolean;
	/** Turn Safe orchestrator mode on/off on the main session (no-op when already in that state). */
	setOrchestratorEnabled(enabled: boolean): Promise<void> | void;
	/** Engage/release session plan mode for the duo planning phase (no-op when the state already matches or duo does not own it). */
	setPlanModeEnabled(enabled: boolean): void;
	planModeActive(): boolean;
	/** Continue after a duo-owned model switch that landed outside the normal user prompt flow. */
	requestAgentContinue?(): void;
	/** Add or remove `duo_handoff`/`duo_escalate` from the active tool surface after a phase change. */
	syncToolSurface?(): Promise<void> | void;
	/** Live `duo.mode`; falls back to the resolved config's mode when absent. Keeps `/duo off` authoritative after the controller was built. */
	duoMode?(): DuoMode;
	/** Whether a configured selector is currently suppressed (rate-limit or auth cooldown). */
	isSelectorSuppressed?(selector: string): boolean;
	/** Register the remaining phase candidates as rate-limit fallbacks of the chosen selector. */
	installFallbackChain?(selector: string, chain: string[]): void;
	/** Phase-switch policy thresholds (`duo.phaseSwitch.minConfidence`, `signals.stuckThreshold`). */
	phasePolicy?(): DuoPhasePolicy;
}

/** Hysteresis and stuck thresholds the controller reads from settings through the host. */
export interface DuoPhasePolicy {
	minConfidence: number;
	stuckThreshold: number;
}

/** Mirrors the `duo.phaseSwitch.minConfidence` / `signals.stuckThreshold` defaults for hosts that omit `phasePolicy`. */
const DEFAULT_PHASE_POLICY: DuoPhasePolicy = { minConfidence: 0.7, stuckThreshold: 0.6 };

export type DuoHandoffResult = "ok" | "no-controller" | "wrong-phase" | "already-executor" | "switch-failed";

export interface DuoStatus {
	phase: DuoPhase;
	planner?: string;
	executor?: string;
	takeoverPurpose?: TakeoverPurpose;
	executionScope?: DuoExecutionScope;
	takeoverCount: number;
	advisorPaused: boolean;
	/** Last TypeSafe-classified work phase, when signals are available. */
	workPhase?: WorkPhase;
	/** Selector of the phase model currently holding the executor stream; absent means the resolved executor. */
	phaseModelId?: string;
}

interface PendingSwitch {
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel;
	requestContinuation?: boolean;
}

export interface DuoAdvisorInstructionsInput {
	cooldownRemaining: number;
	consecutiveTakeovers: number;
}

export function renderDuoAdvisorInstructions(input: DuoAdvisorInstructionsInput): string {
	return prompt.render(advisorInstructions, { ...input });
}

export class DuoController {
	#host: DuoControllerHost;
	#config: DuoResolvedConfig;
	#machine: DuoStateMachine;
	#resolvedExecutor: Model;
	#resolvedPlanner: Model;
	#pendingSwitch: PendingSwitch | undefined;
	#advisorPaused: boolean;
	#advisorSelfPaused = false;
	#applyingOwnSwitch = false;
	#plannerDwellTurns = 0;
	#planningHandoffNudges = 0;
	#planningSignalNudged = false;
	/** Set when the user switched to a foreign model; blocks silent auto re-activation. */
	#optedOutByManualSwitch = false;
	/** Advisor-selected executor effort; persisted separately from the user's configured default. */
	#executorThinkingOverride: ThinkingLevel | undefined;
	/** Last classified work phase plus how many consecutive turns reported it (phase-switch hysteresis). */
	#lastWorkPhase: WorkPhase | undefined;
	#phaseStreak = 0;
	/** Consecutive turns whose stuck score crossed `signals.stuckThreshold`. */
	#stuckStreak = 0;
	/** Selector of the phase model currently holding the executor stream. */
	#phaseModelSelector: string | undefined;

	constructor(host: DuoControllerHost, config: DuoResolvedConfig, restored?: DuoStateSnapshot) {
		this.#host = host;
		this.#config = config;
		this.#resolvedExecutor = config.executor;
		this.#resolvedPlanner = config.planner;
		this.#machine = new DuoStateMachine(
			{ cooldownTurns: config.cooldownTurns, maxConsecutive: config.maxConsecutive },
			restored,
		);
		this.#advisorPaused = restored?.phase === "takeover";
		this.#executorThinkingOverride = restored?.executorThinkingOverride;
		this.#refreshSnapshotMetadata(restored?.preDuoThinking);
	}

	get status(): DuoStatus {
		const snapshot = this.#machine.snapshot;
		return {
			phase: snapshot.phase,
			planner: snapshot.plannerId ?? this.#formatModel(this.#config.planner),
			executor: snapshot.executorId ?? this.#formatModel(this.#config.executor),
			takeoverPurpose: snapshot.takeoverPurpose,
			takeoverCount: snapshot.takeoverCount,
			executionScope: snapshot.executionScope ?? "single",
			advisorPaused: this.#advisorPaused,
			workPhase: snapshot.workPhase,
			phaseModelId: this.#phaseModelSelector,
		};
	}

	async reevaluate(): Promise<void> {
		const activationInput = this.#activationInput();
		const previousPhase = this.#machine.phase;
		const previousPreDuoThinking = this.#machine.snapshot.preDuoThinking;
		const nextPhase = this.#machine.evaluateActivation(activationInput);
		const wasDormant = previousPhase === "inactive" || previousPhase === "suspended";
		const activated = wasDormant && nextPhase !== "inactive";
		const deactivated = !wasDormant && nextPhase === "inactive";
		const preDuoThinking = activated ? this.#host.configuredThinkingLevel() : previousPreDuoThinking;
		this.#refreshSnapshotMetadata(preDuoThinking);
		if (activated || deactivated) await this.#host.syncToolSurface?.();

		if (activated && nextPhase === "planning") {
			this.#host.injectBrief(prompt.render(plannerNotice), "nextTurn");
			await this.#applySwitch(this.#config.planner, this.#config.plannerThinking);
		} else if (activated && nextPhase === "executing") {
			if (await this.#applySwitch(this.#config.executor, this.#executorThinking())) {
				await this.#setOrchestratorForExecutionScope(activationInput);
			}
		} else if (deactivated) {
			this.#host.setPlanModeEnabled(false);
			this.#host.stopDuoAdvisor();
			this.#pendingSwitch = undefined;
			this.#advisorPaused = false;
			this.#executorThinkingOverride = undefined;
			this.#refreshSnapshotMetadata(preDuoThinking);
			this.#plannerDwellTurns = 0;
			const restoredThinking = parseConfiguredThinkingLevel(preDuoThinking);
			if (restoredThinking !== undefined) {
				this.#host.setThinkingLevel(restoredThinking);
			}
		}
		// Idempotent phase side-effects: session restores skip the activation
		// branches above (previousPhase is already non-inactive), so reconcile
		// plan mode with the surviving phase on every evaluation.
		if (this.#machine.phase === "planning") {
			this.#host.setPlanModeEnabled(true);
		} else if (this.#isExecutingLike()) {
			this.#host.setPlanModeEnabled(false);
		}
		const desiredMain = this.#desiredMainForPhase();
		if (desiredMain) {
			const currentModel = this.#host.currentModel();
			const mainModelReady = currentModel ? modelsAreEqual(currentModel, desiredMain.model) : false;
			if (!mainModelReady) {
				await this.#applySwitch(desiredMain.model, desiredMain.thinkingLevel);
			}
		}
		if (this.#phaseShouldHavePlannerAdvisor()) {
			this.#ensurePlannerAdvisor();
		}
		this.#syncAdvisorSelfPause();
		this.#persistSnapshot();
	}

	async notifyPlanApproved(): Promise<void> {
		if (this.#machine.onPlanApproved()) {
			this.#refreshSnapshotMetadata();
			if (await this.#applySwitch(this.#config.executor, this.#executorThinking())) {
				if (!this.#host.ensureAdvisorStarted(this.#config.planner)) {
					this.#machine.onAdvisorDropped();
					this.#advisorPaused = false;
					this.#host.emitNotice(
						"warning",
						"Duo advisor could not be started; continuing with the executor without takeover support.",
					);
				} else {
					// A plan approval returns to executing but never resumed the advisor that
					// notifyPlanModeEntered/requestPlanTakeover paused when the planner took the
					// stream, leaving it paused for the whole executing phase. Resume it here.
					this.#host.resumeAdvisor();
					this.#advisorPaused = false;
					this.#advisorSelfPaused = false;
				}
				this.#host.setPlanModeEnabled(false);
				await this.#setOrchestratorForExecutionScope();
				this.#plannerDwellTurns = 0;
				this.#syncAdvisorSelfPause();
			}
			this.#persistSnapshot();
		}
	}

	/** Plan mode re-entered by the user while the executor holds the stream:
	 *  hand the main stream back to the planner for re-planning. */
	async notifyPlanModeEntered(): Promise<boolean> {
		if (!this.#machine.onReplanRequested()) return false;
		this.#refreshSnapshotMetadata();
		this.#host.pauseAdvisor();
		this.#advisorPaused = true;
		await this.#applySwitch(this.#config.planner, this.#config.plannerThinking);
		this.#plannerDwellTurns = 0;
		this.#host.setPlanModeEnabled(true);
		this.#host.emitNotice("info", "Duo returned to planning: the planner holds the main stream again.");
		this.#persistSnapshot();
		return true;
	}

	/** TypeSafe classification of the turn that just ended (see plan: phase models, stuck). */
	notifyTurnSignals(signals: TurnSignals): void {
		const policy = this.#host.phasePolicy?.() ?? DEFAULT_PHASE_POLICY;
		this.#phaseStreak = this.#lastWorkPhase === signals.phase ? this.#phaseStreak + 1 : 1;
		this.#lastWorkPhase = signals.phase;
		this.#stuckStreak = signals.stuck >= policy.stuckThreshold ? this.#stuckStreak + 1 : 0;
		if (this.#machine.workPhase !== signals.phase) {
			this.#machine.setWorkPhase(signals.phase);
			this.#persistSnapshot();
		}
		if (this.#machine.phase !== "executing") {
			this.#watchPlannerTakeoverDrift(signals, policy.minConfidence);
			return;
		}
		this.#switchPhaseModel(signals, policy.minConfidence);
		this.#triggerStuckTakeover();
	}

	async notifyTurnEnd(): Promise<void> {
		const pending = this.#pendingSwitch;
		this.#pendingSwitch = undefined;
		if (pending) {
			await this.#applySwitchNow(pending.model, pending.thinkingLevel, pending.requestContinuation);
		}
		const before = this.#machine.snapshot;
		this.#machine.onExecutorTurnEnd();
		if (this.#snapshotChanged(before, this.#machine.snapshot)) {
			this.#refreshSnapshotMetadata(before.preDuoThinking);
			this.#persistSnapshot();
		}
		this.#trackPlanningHandoffNudge();
		this.#trackPlannerDwell();
	}

	/** Applies a queued switch at run end; never touches the machine because notifyTurnEnd would double-tick the cooldown. */
	async flushPendingSwitch(): Promise<void> {
		const pending = this.#pendingSwitch;
		this.#pendingSwitch = undefined;
		if (pending) {
			await this.#applySwitchNow(pending.model, pending.thinkingLevel, pending.requestContinuation);
		}
	}

	notifyManualModelChange(): void {
		if (this.#applyingOwnSwitch) {
			return;
		}
		const model = this.#host.currentModel();
		if (!model) {
			return;
		}
		const phase = this.#machine.phase;
		if (phase === "inactive" || phase === "suspended") {
			// Dormant duo in auto mode: a manual switch onto the planner (documented
			// `auto` trigger, same as at startup) activates duo — unless the user
			// already opted out by switching to a foreign model.
			const mode = this.#host.duoMode?.() ?? this.#config.mode;
			if (mode === "auto" && !this.#optedOutByManualSwitch && this.#mainModelKind(model) === "fable") {
				void this.reevaluate();
			}
			return;
		}
		this.#pendingSwitch = undefined;
		const configuredThinking = this.#host.configuredThinkingLevel();
		if (this.#isExecutingLike()) {
			if (modelsAreEqual(model, this.#config.executor)) {
				return;
			}
			if (modelsAreEqual(model, this.#resolvedExecutor)) {
				this.#config = {
					...this.#config,
					executor: this.#resolvedExecutor,
					executorThinking: configuredThinking ?? this.#executorThinking(),
				};
				this.#plannerDwellTurns = 0;
				this.#syncAdvisorSelfPause();
				this.#refreshSnapshotMetadata();
				this.#persistSnapshot();
				return;
			}
			if (!modelsAreEqual(model, this.#resolvedPlanner)) {
				this.#disableForForeignManualSwitch(model);
				return;
			}
			if (this.#config.manualSwitchIntent === "plan") {
				if (this.#machine.onPlanTakeoverRequested()) {
					this.#refreshSnapshotMetadata();
					this.#host.pauseAdvisor();
					this.#advisorPaused = true;
					this.#advisorSelfPaused = false;
					this.#plannerDwellTurns = 0;
					const thinking = parseConfiguredThinkingLevel(this.#config.plannerThinking);
					if (thinking !== undefined) this.#host.setThinkingLevel(thinking);
					this.#host.injectBrief(
						prompt.render(manualPlanBrief, {
							planArtifact: "local://duo-plan.md",
							executor: this.#formatModel(this.#resolvedExecutor),
						}),
						"nextTurn",
					);
					this.#persistSnapshot();
				}
				return;
			}
			this.#config = {
				...this.#config,
				executor: model,
				executorThinking: configuredThinking ?? this.#executorThinking(),
			};
			this.#host.emitNotice(
				"info",
				`Duo executor set to ${this.#formatModel(model)} (manual switch). Tip: use /duo plan to put the planner on the main stream for planning.`,
			);
			this.#host.injectBrief(prompt.render(plannerSummon), "nextTurn");
			const thinking = parseConfiguredThinkingLevel(this.#config.plannerThinking);
			if (thinking !== undefined) this.#host.setThinkingLevel(thinking);
		} else {
			if (modelsAreEqual(model, this.#config.planner)) {
				return;
			}
			this.#config = {
				...this.#config,
				planner: model,
				plannerThinking: configuredThinking ?? this.#config.plannerThinking,
			};
			this.#host.emitNotice("info", `Duo planner set to ${this.#formatModel(model)} (manual switch).`);
			const thinking = parseConfiguredThinkingLevel(this.#config.plannerThinking);
			if (thinking !== undefined) this.#host.setThinkingLevel(thinking);
		}
		this.#syncAdvisorSelfPause();
		this.#refreshSnapshotMetadata();
		this.#persistSnapshot();
	}

	notifyAdvisorDropped(): void {
		const before = this.#machine.snapshot;
		this.#machine.onAdvisorDropped();
		if (this.#snapshotChanged(before, this.#machine.snapshot)) {
			this.#advisorPaused = false;
			this.#plannerDwellTurns = 0;
			this.#host.emitNotice(
				"warning",
				"Duo advisor dropped; continuing with the executor without takeover support.",
			);
			this.#refreshSnapshotMetadata(before.preDuoThinking);
			this.#persistSnapshot();
		}
	}

	requestTakeover(
		purpose: TakeoverPurpose,
		reason: string,
		directive: string,
		options?: TakeoverRequestOptions,
	): TakeoverDecision {
		const decision = this.#machine.onTakeoverRequested(purpose, options);
		if (decision === "accepted") {
			this.#refreshSnapshotMetadata();
			this.#host.pauseAdvisor();
			this.#advisorPaused = true;
			this.#plannerDwellTurns = 0;
			void this.#applySwitch(this.#config.planner, this.#config.plannerThinking);
			this.#host.injectBrief(
				prompt.render(takeoverBrief, { purpose, reason, directive }),
				this.#host.isStreaming() ? "nextTurn" : "steer",
			);
			this.#host.emitNotice("info", `Duo planner takeover accepted (${purpose}).`);
			this.#persistSnapshot();
			return decision;
		}
		if (decision === "rejected") {
			this.#host.emitNotice("warning", "Duo takeover request rejected; manual /duo exec is required.");
		}
		return decision;
	}

	async requestPlanTakeover(reason: string): Promise<boolean> {
		if (this.#machine.phase !== "executing") {
			return false;
		}
		const currentModel = this.#host.currentModel();
		if (currentModel && modelsAreEqual(currentModel, this.#config.planner)) {
			return false;
		}
		const planner = this.#host.availableModels().find(model => modelsAreEqual(model, this.#config.planner));
		if (!planner || !this.#machine.onPlanTakeoverRequested()) {
			return false;
		}
		this.#refreshSnapshotMetadata();
		if (!(await this.#applySwitch(planner, this.#config.plannerThinking))) {
			return false;
		}
		this.#host.pauseAdvisor();
		this.#advisorPaused = true;
		this.#plannerDwellTurns = 0;
		this.#host.setPlanModeEnabled(true);
		this.#host.injectBrief(
			prompt.render(manualPlanBrief, {
				planArtifact: "local://duo-plan.md",
				executor: this.#formatModel(this.#config.executor),
			}),
			"nextTurn",
		);
		this.#persistSnapshot();
		this.#host.emitNotice("info", prompt.render(planTakeoverNotice, { reason }));
		return true;
	}

	notifyAutoSignals(report: TakeoverSignalReport): void {
		if (!this.#config.signals.enabled || this.#machine.phase !== "executing") {
			return;
		}
		const current = this.#pendingSwitch?.model ?? this.#host.currentModel();
		if (current && modelsAreEqual(current, this.#config.planner)) {
			return;
		}
		const failureSignal = report.consecutiveFailures >= this.#config.signals.failureThreshold;
		const loopSignal = report.loop;
		const strongSignal = this.#config.signals.sentiment && report.strong;
		if (this.#config.signals.planningNeeded && report.planningShapedWork) {
			if (!this.#planningSignalNudged) {
				this.#host.injectBrief(prompt.render(planningSignalNudge), "nextTurn");
				this.#planningSignalNudged = true;
			}
		} else {
			this.#planningSignalNudged = false;
		}
		if (!strongSignal && !failureSignal && !loopSignal) {
			return;
		}
		const evidence = report.evidence.length > 0 ? report.evidence.join("; ") : "automatic takeover threshold tripped";
		this.requestTakeover("recover", `Automatic signal: ${evidence}`, prompt.render(autoSignalDirective), {
			bypassCooldown: strongSignal,
		});
	}

	async summonPlanner(): Promise<boolean> {
		if (!this.#isExecutingLike()) {
			return false;
		}
		const currentModel = this.#host.currentModel();
		if (currentModel && modelsAreEqual(currentModel, this.#config.planner)) {
			return false;
		}
		const planner = this.#host.availableModels().find(model => modelsAreEqual(model, this.#config.planner));
		if (!planner) {
			return false;
		}
		if (!(await this.#applySwitch(planner, this.#config.plannerThinking, true))) {
			return false;
		}
		this.#host.injectBrief(prompt.render(plannerSummon), "nextTurn");
		this.#syncAdvisorSelfPause();
		this.#refreshSnapshotMetadata();
		this.#persistSnapshot();
		return true;
	}

	setExecutorThinkingOverride(level: ThinkingLevel | undefined, reason: string): boolean {
		// The advisor override is persisted so subsequent executor handoffs keep the raised effort.
		this.#executorThinkingOverride = level;
		this.#refreshSnapshotMetadata();
		if (this.#machine.phase === "executing") {
			this.#host.setThinkingLevel(this.#executorThinking());
		}
		this.#host.emitNotice("info", prompt.render(effortChangeNotice, { level: level ?? "default", reason }));
		this.#persistSnapshot();
		return true;
	}

	/** Executor-initiated escalation: hand the main stream to the planner. */
	async escalateToPlanner(reason: string): Promise<boolean> {
		if (this.#machine.onExecutorEscalate() !== "accepted") return false;
		this.#refreshSnapshotMetadata();
		this.#host.pauseAdvisor();
		this.#advisorPaused = true;
		this.#plannerDwellTurns = 0;
		await this.#applySwitch(this.#config.planner, this.#config.plannerThinking, true);
		this.#host.injectBrief(
			prompt.render(takeoverBrief, {
				purpose: "recover",
				reason,
				directive:
					"Self-escalated by the executor. Resolve the blocker, then call duo_handoff to return the stream.",
			}),
			this.#host.isStreaming() ? "nextTurn" : "steer",
		);
		this.#host.emitNotice("info", "Duo executor escalated to the planner.");
		this.#persistSnapshot();
		return true;
	}

	async handoffToExecutor(resolution: string, scope?: DuoExecutionScope): Promise<DuoHandoffResult> {
		if (this.#isExecutingLike()) {
			const currentModel = this.#host.currentModel();
			if (currentModel && modelsAreEqual(currentModel, this.#resolvedExecutor)) {
				return "already-executor";
			}
			this.#config = { ...this.#config, executor: this.#resolvedExecutor };
			const brief = prompt.render(handbackBrief, { resolution });
			if (!(await this.#applySwitch(this.#resolvedExecutor, this.#executorThinking(), true))) {
				this.#persistSnapshot();
				return "switch-failed";
			}
			if (scope !== undefined) {
				this.#machine.applyExecutionScope(scope);
				await this.#setOrchestratorForExecutionScope();
			}
			this.#host.resumeAdvisor(brief);
			this.#advisorPaused = false;
			this.#advisorSelfPaused = false;
			this.#syncAdvisorSelfPause();
			this.#plannerDwellTurns = 0;
			this.#host.injectBrief(brief, "nextTurn");
			this.#host.emitNotice(
				"info",
				`Duo executor restored: ${this.#formatModel(this.#resolvedExecutor)} takes the main stream.`,
			);
			this.#refreshSnapshotMetadata();
			this.#persistSnapshot();
			return "ok";
		}
		const previousPhase = this.#machine.phase;
		if (!this.#machine.onHandoffToExecutor(scope)) {
			return "wrong-phase";
		}
		this.#refreshSnapshotMetadata();
		const brief = prompt.render(handbackBrief, { resolution });
		if (!(await this.#applySwitch(this.#config.executor, this.#executorThinking(), true))) {
			this.#persistSnapshot();
			return "switch-failed";
		}
		this.#host.setPlanModeEnabled(false);
		await this.#setOrchestratorForExecutionScope();
		if (previousPhase === "planning" && !this.#host.ensureAdvisorStarted(this.#config.planner)) {
			this.#machine.onAdvisorDropped();
			this.#advisorPaused = false;
			this.#host.emitNotice(
				"warning",
				"Duo advisor could not be started; continuing with the executor without takeover support.",
			);
		}
		this.#host.resumeAdvisor(brief);
		this.#advisorPaused = false;
		this.#advisorSelfPaused = false;
		this.#plannerDwellTurns = 0;
		this.#syncAdvisorSelfPause();
		this.#host.injectBrief(brief, "nextTurn");
		this.#persistSnapshot();
		return "ok";
	}

	async forceExec(): Promise<DuoHandoffResult> {
		return await this.handoffToExecutor("manual /duo exec");
	}

	async deactivate(): Promise<void> {
		const snapshot = this.#machine.snapshot;
		this.#machine.onDuoOff();
		this.#pendingSwitch = undefined;
		this.#host.setPlanModeEnabled(false);
		this.#host.stopDuoAdvisor();
		this.#advisorPaused = false;
		this.#executorThinkingOverride = undefined;
		this.#phaseModelSelector = undefined;
		this.#plannerDwellTurns = 0;
		const restoredThinking = parseConfiguredThinkingLevel(snapshot.preDuoThinking);
		if (restoredThinking !== undefined) {
			this.#host.setThinkingLevel(restoredThinking);
		}
		await this.#host.setOrchestratorEnabled(false);
		await this.#host.syncToolSurface?.();
		this.#refreshSnapshotMetadata(snapshot.preDuoThinking);
		this.#persistSnapshot();
	}

	dispose(): void {
		this.#pendingSwitch = undefined;
	}

	#mainModelKind(model: Model | undefined): DuoActivationInput["mainModelKind"] {
		if (!model) return "other";
		// The configured pair wins over family detection so a non-Anthropic
		// executor (or planner) is still recognized once duo is live.
		if (modelsAreEqual(model, this.#config.executor) || modelsAreEqual(model, this.#resolvedExecutor)) {
			return "opus";
		}
		if (modelsAreEqual(model, this.#config.planner) || modelsAreEqual(model, this.#resolvedPlanner)) {
			return "fable";
		}
		const identity = classifyModel(model.provider, model.id, { lenient: true });
		if (identity.class !== "anthropic") return "other";
		if (identity.family === "opus") return "opus";
		if (identity.family === "fable" || identity.family === "mythos") return "fable";
		return "other";
	}

	#activationInput(): DuoActivationInput {
		return {
			mode: this.#host.duoMode?.() ?? this.#config.mode,
			orchestratorEnabled: this.#config.orchestrator === "always" || this.#host.orchestratorEnabled(),
			mainModelKind: this.#mainModelKind(this.#host.currentModel()),
			plannerResolvable: Boolean(this.#config.planner),
			executorResolvable: Boolean(this.#config.executor),
			planModeActive: this.#host.planModeActive(),
		};
	}

	#desiredMainForPhase(): PendingSwitch | undefined {
		switch (this.#machine.phase) {
			case "executing":
			case "degraded":
				return { model: this.#config.executor, thinkingLevel: this.#executorThinking() };
			case "planning":
			case "takeover":
				return { model: this.#config.planner, thinkingLevel: this.#config.plannerThinking };
			default:
				return undefined;
		}
	}

	#isExecutingLike(): boolean {
		return this.#machine.phase === "executing" || this.#machine.phase === "degraded";
	}

	#executorThinking(): ConfiguredThinkingLevel {
		return this.#executorThinkingOverride ?? this.#config.executorThinking;
	}

	/** Phase-model selection: hysteresis, suppressed candidates skipped, and restore to the resolved executor. */
	#switchPhaseModel(signals: TurnSignals, minConfidence: number): void {
		const candidates = this.#config.phaseModels[signals.phase];
		if (candidates && candidates.length > 0) {
			if (signals.phaseConfidence < minConfidence) return;
			if (signals.phase !== "blocked" && this.#phaseStreak < 2) return;
			const chosen = candidates.find(candidate => !this.#host.isSelectorSuppressed?.(candidate.selector));
			if (!chosen || chosen.selector === this.#phaseModelSelector) return;
			// A suppressed selector stays out of the chain: it is in a rate-limit/auth cooldown,
			// and the chain is a runtime override that would outlive that suppression.
			const chain = candidates
				.filter(
					candidate =>
						candidate.selector !== chosen.selector && !this.#host.isSelectorSuppressed?.(candidate.selector),
				)
				.map(candidate => candidate.selector);
			if (chain.length > 0) this.#host.installFallbackChain?.(chosen.selector, chain);
			this.#phaseModelSelector = chosen.selector;
			void this.#applySwitch(chosen.model, chosen.thinkingLevel ?? this.#executorThinking());
			return;
		}
		// Unlisted phase (or no available candidate): the planner/executor models are authoritative.
		if (this.#phaseModelSelector === undefined) return;
		if (signals.phaseConfidence < minConfidence || this.#phaseStreak < 2) return;
		this.#phaseModelSelector = undefined;
		void this.#applySwitch(this.#resolvedExecutor, this.#executorThinking());
	}

	/** Two consecutive stuck turns hand the stream to the planner; the streak resets so the takeover cooldown governs repeats. */
	#triggerStuckTakeover(): void {
		if (this.#stuckStreak < 2) return;
		this.#stuckStreak = 0;
		this.notifyAutoSignals({
			sentiment: false,
			consecutiveFailures: 0,
			loop: true,
			doneClaimWithoutEvidence: false,
			planningShapedWork: false,
			strong: false,
			evidence: ["TypeSafe stuck score ≥ threshold for 2 turns"],
		});
	}

	#phaseShouldHavePlannerAdvisor(): boolean {
		switch (this.#machine.phase) {
			case "planning":
			case "executing":
			case "takeover":
			case "degraded":
				return !modelsAreEqual(this.#config.executor, this.#config.planner);
			default:
				return false;
		}
	}

	#ensurePlannerAdvisor(): void {
		if (this.#host.ensureAdvisorStarted(this.#config.planner)) return;
		this.#machine.onAdvisorDropped();
		this.#advisorPaused = false;
		this.#host.emitNotice(
			"warning",
			"Duo advisor could not be started; continuing with the executor without takeover support.",
		);
		this.#host.scheduleAdvisorRevive?.();
	}

	async #applySwitch(
		model: Model,
		thinkingLevel: ConfiguredThinkingLevel,
		requestContinuation = false,
	): Promise<boolean> {
		if (this.#host.isStreaming()) {
			this.#pendingSwitch = { model, thinkingLevel, requestContinuation };
			return true;
		}
		return await this.#applySwitchNow(model, thinkingLevel, requestContinuation);
	}

	async #applySwitchNow(
		model: Model,
		thinkingLevel: ConfiguredThinkingLevel,
		requestContinuation = false,
	): Promise<boolean> {
		this.#applyingOwnSwitch = true;
		try {
			await this.#host.setModelTemporary(model, thinkingLevel);
			if (requestContinuation) this.#host.requestAgentContinue?.();
			return true;
		} catch (error) {
			const before = this.#machine.snapshot;
			this.#machine.onSetModelFailed();
			this.#pendingSwitch = undefined;
			this.#advisorPaused = false;
			this.#plannerDwellTurns = 0;
			this.#refreshSnapshotMetadata(before.preDuoThinking);
			this.#persistSnapshot();
			const message = error instanceof Error ? error.message : String(error);
			this.#host.emitNotice("warning", `Duo model switch failed; duo suspended. ${message}`);
			return false;
		} finally {
			this.#applyingOwnSwitch = false;
		}
	}

	#trackPlanningHandoffNudge(): void {
		if (this.#machine.phase !== "planning") {
			this.#planningHandoffNudges = 0;
			return;
		}
		if (!this.#host.planArtifactReady?.()) {
			this.#planningHandoffNudges = 0;
			return;
		}
		this.#planningHandoffNudges += 1;
		if (this.#planningHandoffNudges === 1) {
			this.#host.injectBrief(prompt.render(plannerHandoffNudge), "nextTurn");
			return;
		}
		this.#host.emitNotice("warning", "The plan artifact is ready; call duo_handoff now to return to the executor.");
	}

	#trackPlannerDwell(): void {
		const current = this.#host.currentModel();
		if (this.#isExecutingLike() && current && modelsAreEqual(current, this.#config.planner)) {
			this.#plannerDwellTurns += 1;
			if (this.#plannerDwellTurns % 3 === 0) {
				this.#host.emitNotice(
					"warning",
					`The Fable model has held the executing stream for ${this.#plannerDwellTurns} turns. For ordinary execution call duo_handoff to restore the executor, or stay only while planner-grade reasoning is needed.`,
				);
				this.#host.injectBrief(
					`You are on the Fable model in the executing phase (Fable dwell: ${this.#plannerDwellTurns} turns). For ordinary execution call duo_handoff to restore the executor NOW; stay only while the current work needs planner-grade reasoning.`,
					"nextTurn",
				);
			}
			return;
		}
		this.#plannerDwellTurns = 0;
	}

	/**
	 * The return watch: while a takeover or plan-mode planning holds the main
	 * stream, the classified work phase is the trigger back to the executor. A
	 * planner whose turns read as implementing or verifying has drifted into
	 * executor-domain work, so hand the stream back automatically instead of
	 * relying on the soft handoff nudges. Mirrors the phase-model switch gates
	 * (confidence and a two-turn streak) so one noisy classification never yanks
	 * the stream.
	 */
	#watchPlannerTakeoverDrift(signals: TurnSignals, minConfidence: number): void {
		const phase = this.#machine.phase;
		if (phase !== "takeover" && phase !== "planning") return;
		if (signals.phase !== "implementing" && signals.phase !== "verifying") return;
		if (signals.phaseConfidence < minConfidence || this.#phaseStreak < 2) return;
		void this.#returnStreamFromPlanner(signals.phase);
	}

	async #returnStreamFromPlanner(classifiedPhase: WorkPhase): Promise<void> {
		const result = await this.handoffToExecutor(
			`Auto-returned: the planner's last turns were classified as ${classifiedPhase}, which is executor work.`,
		);
		if (result === "ok") {
			this.#host.emitNotice(
				"info",
				`Duo returned the stream to the executor: the planner was ${classifiedPhase} instead of handing off; ${this.#formatModel(this.#resolvedExecutor)} now executes.`,
			);
		} else if (result === "switch-failed") {
			this.#host.emitNotice(
				"warning",
				"Duo could not auto-return the stream to the executor; the planner keeps the stream for now.",
			);
		}
	}

	#syncAdvisorSelfPause(): void {
		if (this.#machine.phase !== "executing") {
			this.#plannerDwellTurns = 0;
			return;
		}
		// A model switch queued while streaming lands only at turn end, so currentModel()
		// still reports the planner mid-handoff. Evaluate the model that WILL hold the
		// stream (the pending target) so we don't re-pause the advisor we just resumed.
		const current = this.#pendingSwitch?.model ?? this.#host.currentModel();
		if (!current) {
			return;
		}
		if (modelsAreEqual(current, this.#config.planner)) {
			if (!this.#advisorSelfPaused) {
				this.#host.pauseAdvisor();
				this.#advisorSelfPaused = true;
				this.#host.emitNotice("info", "Duo advisor paused: the Fable model holds the main stream.");
			}
			return;
		}
		this.#plannerDwellTurns = 0;
		if (this.#advisorSelfPaused) {
			this.#host.resumeAdvisor();
			this.#advisorSelfPaused = false;
			this.#host.emitNotice("info", "Duo advisor resumed.");
		}
	}

	async #setOrchestratorForExecutionScope(activationInput?: DuoActivationInput): Promise<void> {
		if (this.#config.orchestrator === "always") {
			await this.#host.setOrchestratorEnabled(true);
			return;
		}
		const shouldEnable = this.#machine.executionScope === "multi";
		// A manual orchestrator toggle can disable the host while an earlier auto
		// reevaluation is still awaiting the model switch; do not resurrect that stale
		// activation if the current host state no longer matches its input snapshot.
		if (shouldEnable && activationInput?.orchestratorEnabled === true && !this.#host.orchestratorEnabled()) {
			return;
		}
		await this.#host.setOrchestratorEnabled(shouldEnable);
	}

	#disableForForeignManualSwitch(model: Model): void {
		const snapshot = this.#machine.snapshot;
		this.#machine.onDuoOff();
		this.#optedOutByManualSwitch = true;
		this.#pendingSwitch = undefined;
		this.#host.setPlanModeEnabled(false);
		this.#host.stopDuoAdvisor();
		this.#advisorPaused = false;
		this.#advisorSelfPaused = false;
		this.#plannerDwellTurns = 0;
		this.#planningHandoffNudges = 0;
		this.#executorThinkingOverride = undefined;
		this.#phaseModelSelector = undefined;
		const restoredThinking = parseConfiguredThinkingLevel(snapshot.preDuoThinking);
		if (restoredThinking !== undefined) this.#host.setThinkingLevel(restoredThinking);
		void this.#host.setOrchestratorEnabled(false);
		this.#host.emitNotice(
			"info",
			`Duo disabled: main model ${this.#formatModel(model)} is outside the duo planner/executor pair (${this.#formatModel(this.#resolvedPlanner)} / ${this.#formatModel(this.#resolvedExecutor)}).`,
		);
		this.#refreshSnapshotMetadata(snapshot.preDuoThinking);
		this.#persistSnapshot();
	}

	#refreshSnapshotMetadata(preDuoThinking = this.#machine.snapshot.preDuoThinking): void {
		const snapshot = this.#machine.snapshot;
		this.#machine = new DuoStateMachine(
			{ cooldownTurns: this.#config.cooldownTurns, maxConsecutive: this.#config.maxConsecutive },
			{
				...snapshot,
				plannerId: this.#formatModel(this.#config.planner),
				executorId: this.#formatModel(this.#config.executor),
				preDuoThinking,
				executorThinkingOverride: this.#executorThinkingOverride,
			},
		);
	}

	#persistSnapshot(): void {
		this.#host.persistSnapshot(this.#machine.snapshot);
	}

	#formatModel(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#snapshotChanged(before: DuoStateSnapshot, after: DuoStateSnapshot): boolean {
		return JSON.stringify(before) !== JSON.stringify(after);
	}
}
