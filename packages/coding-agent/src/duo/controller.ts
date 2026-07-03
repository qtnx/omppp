import type { Model } from "@oh-my-pi/pi-ai";
import { isFableOrMythos, parseAnthropicModel } from "@oh-my-pi/pi-catalog/identity";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { prompt } from "@oh-my-pi/pi-utils";
import type { DuoResolvedConfig } from "../config/model-resolver";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import advisorInstructions from "./prompts/advisor-instructions.md" with { type: "text" };
import handbackBrief from "./prompts/handback-brief.md" with { type: "text" };
import plannerNotice from "./prompts/planner-notice.md" with { type: "text" };
import plannerSummon from "./prompts/planner-summon.md" with { type: "text" };
import takeoverBrief from "./prompts/takeover-brief.md" with { type: "text" };
import {
	type DuoActivationInput,
	type DuoPhase,
	DuoStateMachine,
	type DuoStateSnapshot,
	type TakeoverDecision,
	type TakeoverPurpose,
} from "./state";

export interface DuoControllerHost {
	currentModel(): Model | undefined;
	availableModels(): Model[];
	isStreaming(): boolean;
	setModelTemporary(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void>;
	setThinkingLevel(level: ConfiguredThinkingLevel): void;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	ensureAdvisorStarted(pinned: Model): boolean;
	stopDuoAdvisor(): void;
	pauseAdvisor(): void;
	resumeAdvisor(catchupBrief?: string): void;
	injectBrief(text: string, deliverAs: "steer" | "nextTurn"): void;
	emitNotice(level: "info" | "warning", text: string): void;
	persistSnapshot(snapshot: DuoStateSnapshot): void;
	orchestratorEnabled(): boolean;
	/** Turn Safe orchestrator mode on/off on the main session (no-op when already in that state). */
	setOrchestratorEnabled(enabled: boolean): Promise<void> | void;
	/** Engage/release session plan mode for the duo planning phase (no-op when the state already matches or duo does not own it). */
	setPlanModeEnabled(enabled: boolean): void;
	planModeActive(): boolean;
}

export type DuoHandoffResult = "ok" | "no-controller" | "wrong-phase" | "already-executor" | "switch-failed";

export interface DuoStatus {
	phase: DuoPhase;
	planner?: string;
	executor?: string;
	takeoverPurpose?: TakeoverPurpose;
	takeoverCount: number;
	advisorPaused: boolean;
}

interface PendingSwitch {
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel;
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
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: captured with the resolved executor so manual slot overrides cannot erase the original duo pair.
	#resolvedPlanner: Model;
	#pendingSwitch: PendingSwitch | undefined;
	#advisorPaused: boolean;
	#advisorSelfPaused = false;
	#applyingOwnSwitch = false;
	#plannerDwellTurns = 0;

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
			advisorPaused: this.#advisorPaused,
		};
	}

	async reevaluate(): Promise<void> {
		const previousPhase = this.#machine.phase;
		const previousPreDuoThinking = this.#machine.snapshot.preDuoThinking;
		const nextPhase = this.#machine.evaluateActivation(this.#activationInput());
		const activated = previousPhase === "inactive" && nextPhase !== "inactive";
		const deactivated = previousPhase !== "inactive" && nextPhase === "inactive";
		const preDuoThinking = activated ? this.#host.configuredThinkingLevel() : previousPreDuoThinking;
		this.#refreshSnapshotMetadata(preDuoThinking);

		if (activated && nextPhase === "planning") {
			this.#host.injectBrief(prompt.render(plannerNotice), "nextTurn");
			await this.#applySwitch(this.#config.planner, this.#config.plannerThinking);
		} else if (activated && nextPhase === "executing") {
			if (await this.#applySwitch(this.#config.executor, this.#config.executorThinking)) {
				if (!modelsAreEqual(this.#config.executor, this.#config.planner)) {
					if (!this.#host.ensureAdvisorStarted(this.#config.planner)) {
						this.#machine.onAdvisorDropped();
						this.#advisorPaused = false;
						this.#host.emitNotice(
							"warning",
							"Duo advisor could not be started; continuing with the executor without takeover support.",
						);
					}
				}
				await this.#host.setOrchestratorEnabled(true);
			}
		} else if (deactivated) {
			this.#host.setPlanModeEnabled(false);
			this.#host.stopDuoAdvisor();
			this.#pendingSwitch = undefined;
			this.#advisorPaused = false;
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
			if (await this.#applySwitch(this.#config.executor, this.#config.executorThinking)) {
				if (!this.#host.ensureAdvisorStarted(this.#config.planner)) {
					this.#machine.onAdvisorDropped();
					this.#advisorPaused = false;
					this.#host.emitNotice(
						"warning",
						"Duo advisor could not be started; continuing with the executor without takeover support.",
					);
				}
				this.#host.setPlanModeEnabled(false);
				await this.#host.setOrchestratorEnabled(true);
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

	async notifyTurnEnd(): Promise<void> {
		const pending = this.#pendingSwitch;
		this.#pendingSwitch = undefined;
		if (pending) {
			await this.#applySwitchNow(pending.model, pending.thinkingLevel);
		}
		const before = this.#machine.snapshot;
		this.#machine.onExecutorTurnEnd();
		if (this.#snapshotChanged(before, this.#machine.snapshot)) {
			this.#refreshSnapshotMetadata(before.preDuoThinking);
			this.#persistSnapshot();
		}
		this.#trackPlannerDwell();
	}

	/** Applies a queued switch at run end; never touches the machine because notifyTurnEnd would double-tick the cooldown. */
	async flushPendingSwitch(): Promise<void> {
		const pending = this.#pendingSwitch;
		this.#pendingSwitch = undefined;
		if (pending) {
			await this.#applySwitchNow(pending.model, pending.thinkingLevel);
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
			return;
		}
		this.#pendingSwitch = undefined;
		const configuredThinking = this.#host.configuredThinkingLevel();
		if (this.#isExecutingLike()) {
			if (modelsAreEqual(model, this.#config.executor)) {
				return;
			}
			const switchedToPlannerSlot = modelsAreEqual(model, this.#config.planner);
			this.#config = {
				...this.#config,
				executor: model,
				executorThinking: configuredThinking ?? this.#config.executorThinking,
			};
			this.#host.emitNotice(
				"info",
				`Duo executor set to ${this.#formatModel(model)} (manual switch).${switchedToPlannerSlot ? " Tip: use /duo plan to put the planner on the main stream for planning." : ""}`,
			);
			if (switchedToPlannerSlot) {
				this.#host.injectBrief(prompt.render(plannerSummon), "nextTurn");
				const thinking = parseConfiguredThinkingLevel(this.#config.plannerThinking);
				if (thinking !== undefined) this.#host.setThinkingLevel(thinking);
			}
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

	requestTakeover(purpose: TakeoverPurpose, reason: string, directive: string): TakeoverDecision {
		const decision = this.#machine.onTakeoverRequested(purpose);
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

	/** Executor-initiated escalation: hand the main stream to the planner. */
	async escalateToPlanner(reason: string): Promise<boolean> {
		if (this.#machine.onExecutorEscalate() !== "accepted") return false;
		this.#refreshSnapshotMetadata();
		this.#host.pauseAdvisor();
		this.#advisorPaused = true;
		this.#plannerDwellTurns = 0;
		await this.#applySwitch(this.#config.planner, this.#config.plannerThinking);
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

	async handoffToExecutor(resolution: string): Promise<DuoHandoffResult> {
		if (this.#isExecutingLike()) {
			const currentModel = this.#host.currentModel();
			if (currentModel && modelsAreEqual(currentModel, this.#resolvedExecutor)) {
				return "already-executor";
			}
			this.#config = { ...this.#config, executor: this.#resolvedExecutor };
			if (!(await this.#applySwitch(this.#resolvedExecutor, this.#config.executorThinking))) {
				this.#persistSnapshot();
				return "switch-failed";
			}
			this.#syncAdvisorSelfPause();
			this.#plannerDwellTurns = 0;
			this.#host.emitNotice(
				"info",
				`Duo executor restored: ${this.#formatModel(this.#resolvedExecutor)} takes the main stream.`,
			);
			this.#refreshSnapshotMetadata();
			this.#persistSnapshot();
			return "ok";
		}
		const previousPhase = this.#machine.phase;
		if (!this.#machine.onHandoffToExecutor()) {
			return "wrong-phase";
		}
		this.#refreshSnapshotMetadata();
		const brief = prompt.render(handbackBrief, { resolution });
		if (!(await this.#applySwitch(this.#config.executor, this.#config.executorThinking))) {
			this.#persistSnapshot();
			return "switch-failed";
		}
		this.#host.setPlanModeEnabled(false);
		await this.#host.setOrchestratorEnabled(true);
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
		this.#plannerDwellTurns = 0;
		const restoredThinking = parseConfiguredThinkingLevel(snapshot.preDuoThinking);
		if (restoredThinking !== undefined) {
			this.#host.setThinkingLevel(restoredThinking);
		}
		this.#refreshSnapshotMetadata(snapshot.preDuoThinking);
		this.#persistSnapshot();
	}

	dispose(): void {
		this.#pendingSwitch = undefined;
	}

	#activationInput(): DuoActivationInput {
		const parsed = parseAnthropicModel(this.#host.currentModel()?.id ?? "");
		let mainModelKind: DuoActivationInput["mainModelKind"] = "other";
		if (parsed?.kind === "opus") {
			mainModelKind = "opus";
		} else if (parsed && isFableOrMythos(parsed.kind)) {
			mainModelKind = "fable";
		}
		return {
			mode: this.#config.mode,
			orchestratorEnabled: this.#host.orchestratorEnabled(),
			mainModelKind,
			plannerResolvable: Boolean(this.#config.planner),
			executorResolvable: Boolean(this.#config.executor),
			planModeActive: this.#host.planModeActive(),
		};
	}

	#desiredMainForPhase(): PendingSwitch | undefined {
		switch (this.#machine.phase) {
			case "executing":
			case "degraded":
				return { model: this.#config.executor, thinkingLevel: this.#config.executorThinking };
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
	}

	async #applySwitch(model: Model, thinkingLevel: ConfiguredThinkingLevel): Promise<boolean> {
		if (this.#host.isStreaming()) {
			this.#pendingSwitch = { model, thinkingLevel };
			return true;
		}
		return await this.#applySwitchNow(model, thinkingLevel);
	}

	async #applySwitchNow(model: Model, thinkingLevel: ConfiguredThinkingLevel): Promise<boolean> {
		this.#applyingOwnSwitch = true;
		try {
			await this.#host.setModelTemporary(model, thinkingLevel);
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

	#syncAdvisorSelfPause(): void {
		if (this.#machine.phase !== "executing") {
			this.#plannerDwellTurns = 0;
			return;
		}
		const current = this.#host.currentModel();
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

	#refreshSnapshotMetadata(preDuoThinking = this.#machine.snapshot.preDuoThinking): void {
		const snapshot = this.#machine.snapshot;
		this.#machine = new DuoStateMachine(
			{ cooldownTurns: this.#config.cooldownTurns, maxConsecutive: this.#config.maxConsecutive },
			{
				...snapshot,
				plannerId: this.#formatModel(this.#config.planner),
				executorId: this.#formatModel(this.#config.executor),
				preDuoThinking,
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
