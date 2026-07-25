import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { isFableOrMythos, parseAnthropicModel } from "@oh-my-pi/pi-catalog/identity";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveDuoConfig } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	computeAdvisorRetryDelay,
	DuoController,
	type DuoExecutionScope,
	type DuoHandoffResult,
	type DuoStateSnapshot,
	type DuoStatus,
	type TakeoverDecision,
	type TakeoverPurpose,
} from "../duo";
import { detectPlanningNeeded } from "../duo/takeover-signals";
import { ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES, type OrchestratorModeState } from "../orchestrator-mode/state";
import type { PlanModeState } from "../plan-mode/state";
import type { ConfiguredThinkingLevel } from "../thinking";

export interface SessionDuoOrchestratorHost {
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentKind(): "main" | "sub";
	currentModel(): Model | undefined;
	availableModels(): Model[];
	isStreaming(): boolean;
	setModelTemporary(model: Model, thinkingLevel?: ConfiguredThinkingLevel): Promise<void>;
	setThinkingLevel(level: ConfiguredThinkingLevel): void;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	ensureDuoAdvisorStarted(planner: Model): boolean;
	stopDuoAdvisor(): void;
	scheduleDuoAdvisorRevive(retryAfterMs?: number): void;
	pauseAdvisors(): void;
	resumeAdvisors(): void;
	injectDuoBrief(text: string, deliverAs: "steer" | "nextTurn"): void;
	emitNotice(level: "info" | "warning", text: string, source?: string): void;
	persistDuoSnapshot(snapshot: DuoStateSnapshot): void;
	planArtifactReady(): boolean;
	getPlanModeState(): PlanModeState | undefined;
	setPlanModeState(state: PlanModeState | undefined): void;
	requestAgentContinue(): void;
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): Promise<void>;
	refreshSystemPrompt(): Promise<void>;
	emitModeChanged(mode: "orchestrator" | "none"): Promise<void>;
	persistModeChange(enabled: boolean): void;
	goalModeEnabled(): boolean;
}

export function shouldRunDuoDoneGate(
	advisorDoneGate: boolean,
	duoStatus: DuoStatus | undefined,
	duoDoneGate: "strict" | "inherit",
): boolean {
	return advisorDoneGate || (duoStatus?.phase === "executing" && duoDoneGate === "strict");
}

/** Parse persisted fork Duo state defensively, including legacy pin metadata. */
export function parseDuoStateSnapshot(value: unknown): DuoStateSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const phase = record.phase;
	if (
		phase !== "inactive" &&
		phase !== "planning" &&
		phase !== "executing" &&
		phase !== "takeover" &&
		phase !== "suspended" &&
		phase !== "degraded"
	) {
		return undefined;
	}
	const plannerId = typeof record.plannerId === "string" ? record.plannerId : undefined;
	const advisorModelId =
		typeof record.advisorModelId === "string" ? record.advisorModelId : phase === "inactive" ? undefined : plannerId;
	const executorThinkingOverride = Object.values(ThinkingLevel).find(
		level => level === record.executorThinkingOverride,
	);
	return {
		phase,
		plannerId,
		executorId: typeof record.executorId === "string" ? record.executorId : undefined,
		executionScope:
			record.executionScope === "single" || record.executionScope === "multi" ? record.executionScope : undefined,
		advisorModelId,
		duoOwnsAdvisor: typeof record.duoOwnsAdvisor === "boolean" ? record.duoOwnsAdvisor : advisorModelId !== undefined,
		takeoverPurpose:
			record.takeoverPurpose === "recover" || record.takeoverPurpose === "plan" ? record.takeoverPurpose : undefined,
		takeoverCount: typeof record.takeoverCount === "number" ? record.takeoverCount : 0,
		consecutiveTakeovers: typeof record.consecutiveTakeovers === "number" ? record.consecutiveTakeovers : 0,
		cooldownRemaining: typeof record.cooldownRemaining === "number" ? record.cooldownRemaining : 0,
		suspendReason:
			record.suspendReason === "set-model-failed" || record.suspendReason === "unresolvable"
				? record.suspendReason
				: undefined,
		preDuoThinking: typeof record.preDuoThinking === "string" ? record.preDuoThinking : undefined,
		executorThinkingOverride,
	};
}

export type DuoPlanTakeoverDecision = { request: true; reason: string } | { request: false };

export function resolveDuoPlanTakeoverDecision(
	agentKind: "main" | "sub",
	duoStatus: DuoStatus | undefined,
	isStreaming: boolean,
	signalsEnabled: boolean,
	planningNeededEnabled: boolean,
	expandedText: string,
): DuoPlanTakeoverDecision {
	if (agentKind !== "main" || duoStatus?.phase !== "executing" || isStreaming) return { request: false };
	if (!signalsEnabled || !planningNeededEnabled) return { request: false };
	const detection = detectPlanningNeeded(expandedText);
	return detection.needed ? { request: true, reason: detection.evidence.join("; ") } : { request: false };
}

export function shouldNotifyDuoPlanApproved(
	previous: PlanModeState | undefined,
	next: PlanModeState | undefined,
	planReferencePath: string,
	referenceSetDuringPlanMode: boolean,
): boolean {
	return Boolean(previous?.enabled && next === undefined && referenceSetDuringPlanMode && planReferencePath.trim());
}

export type DuoAdvisorStopAction = "stop" | "rebuild" | "none";

export function resolveDuoAdvisorStopAction(
	duoOwnsAdvisor: boolean,
	pinned: Model | undefined,
	advisorModel: Model | undefined,
): DuoAdvisorStopAction {
	if (duoOwnsAdvisor) return "stop";
	if (pinned && advisorModel && modelsAreEqual(advisorModel, pinned)) return "rebuild";
	return "none";
}

export interface DuoOrchestratorOwnershipDecision {
	apply: "enable" | "disable" | undefined;
	owns: boolean;
}

export function resolveDuoOrchestratorOwnership(
	requested: boolean,
	current: boolean,
	owns: boolean,
): DuoOrchestratorOwnershipDecision {
	if (requested === current) return { apply: undefined, owns };
	if (requested) return { apply: "enable", owns: true };
	if (!owns) return { apply: undefined, owns: false };
	return { apply: "disable", owns: false };
}

/**
 * Owns the fork's Duo, safe-orchestrator, and goal-coexistence policy. AgentSession
 * only supplies session-bound operations through this narrow host contract.
 */
export class SessionDuoOrchestrator {
	readonly #host: SessionDuoOrchestratorHost;
	#controller: DuoController | undefined;
	#orchestratorModeState: OrchestratorModeState | undefined;
	#previousToolNames: string[] | undefined;
	#duoOwnsOrchestrator = false;
	#duoOwnsPlanMode = false;
	#restoredSnapshot: DuoStateSnapshot | undefined;
	#advisorRetryTimer: NodeJS.Timeout | undefined;
	#advisorRetryAttempt = 0;

	constructor(host: SessionDuoOrchestratorHost, restoredSnapshot?: DuoStateSnapshot) {
		this.#host = host;
		this.#restoredSnapshot = restoredSnapshot;
	}

	get status(): DuoStatus | undefined {
		return this.#controller?.status;
	}

	get orchestratorModeState(): OrchestratorModeState | undefined {
		return this.#orchestratorModeState;
	}

	async initialize(): Promise<void> {
		const controller = this.#ensureController(this.#restoredSnapshot);
		this.#restoredSnapshot = undefined;
		await controller?.reevaluate();
	}

	async setDuoEnabled(enabled: boolean): Promise<void> {
		this.#host.settings.set("duo.mode", enabled ? "on" : "off");
		if (!enabled) {
			this.#clearAdvisorRetry();
			await this.#controller?.deactivate();
			return;
		}
		this.#controller?.dispose();
		this.#controller = undefined;
		await this.#ensureController()?.reevaluate();
	}

	async forceExecutor(): Promise<boolean> {
		return ((await this.#controller?.forceExec()) ?? "no-controller") === "ok";
	}

	async handoffToExecutor(resolution: string, scope?: DuoExecutionScope): Promise<DuoHandoffResult> {
		return (await this.#controller?.handoffToExecutor(resolution, scope)) ?? "no-controller";
	}

	async escalateToPlanner(reason: string): Promise<"ok" | "unavailable"> {
		return ((await this.#controller?.escalateToPlanner(reason)) ?? false) ? "ok" : "unavailable";
	}

	requestTakeover(purpose: TakeoverPurpose, reason: string, directive: string): TakeoverDecision {
		return this.#controller?.requestTakeover(purpose, reason, directive) ?? "rejected";
	}

	requestPlanTakeover(reason: string): Promise<boolean> {
		return this.#controller?.requestPlanTakeover(reason) ?? Promise.resolve(false);
	}

	setExecutorThinkingOverride(level: ThinkingLevel, reason: string): boolean {
		return this.#controller?.setExecutorThinkingOverride(level, reason) ?? false;
	}

	scheduleAdvisorRevive(retryAfterMs?: number): void {
		this.#clearAdvisorRetryTimer();
		if (!this.#controller) return;
		const attempt = this.#advisorRetryAttempt;
		const delayMs = computeAdvisorRetryDelay(attempt, retryAfterMs);
		logger.debug("duo advisor revive scheduled", { attempt, delayMs });
		this.#advisorRetryTimer = setTimeout(() => {
			void this.#attemptAdvisorRevive();
		}, delayMs);
		this.#advisorRetryTimer.unref?.();
	}

	async #attemptAdvisorRevive(): Promise<void> {
		this.#advisorRetryTimer = undefined;
		if (this.#controller?.status.phase !== "degraded") {
			this.#advisorRetryAttempt = 0;
			return;
		}
		try {
			await this.#controller.reevaluate();
		} catch (error) {
			logger.debug("duo advisor revive attempt failed", { error: String(error) });
		}
		if (this.#controller.status.phase !== "degraded") {
			this.#advisorRetryAttempt = 0;
			this.#host.emitNotice("info", "Duo advisor restored.", "advisor");
			return;
		}
		this.#advisorRetryAttempt++;
		this.scheduleAdvisorRevive();
	}

	#clearAdvisorRetryTimer(): void {
		if (!this.#advisorRetryTimer) return;
		clearTimeout(this.#advisorRetryTimer);
		this.#advisorRetryTimer = undefined;
	}

	#clearAdvisorRetry(): void {
		this.#clearAdvisorRetryTimer();
		this.#advisorRetryAttempt = 0;
	}

	async replan(): Promise<boolean> {
		return (await this.#controller?.notifyPlanModeEntered()) ?? false;
	}

	async summonPlanner(): Promise<boolean> {
		return (await this.#controller?.summonPlanner()) ?? false;
	}

	async onTurnEnd(): Promise<void> {
		await this.#controller?.notifyTurnEnd();
	}

	notifyManualModelChange(): void {
		this.#controller?.notifyManualModelChange();
	}

	notifyPlanApproved(): void {
		void this.#controller?.notifyPlanApproved();
	}

	async setOrchestratorModeState(
		state: OrchestratorModeState | undefined,
		options?: {
			persistModeChange?: boolean;
			restorePreviousTools?: boolean;
			reuseRestoreSnapshot?: boolean;
		},
	): Promise<void> {
		const wasEnabled = this.#orchestratorModeState?.enabled === true;
		const persistModeChange = options?.persistModeChange ?? true;
		const restorePreviousTools = options?.restorePreviousTools ?? persistModeChange;
		const reuseRestoreSnapshot = options?.reuseRestoreSnapshot ?? true;
		if (state?.enabled) {
			if (this.#host.getPlanModeState()?.enabled) this.#host.setPlanModeState(undefined);
			if (!reuseRestoreSnapshot || !wasEnabled) this.#previousToolNames = this.#host.getActiveToolNames();
			this.#orchestratorModeState = state;
			const names: string[] = [...ORCHESTRATOR_MODE_ACTIVE_TOOL_NAMES];
			if (this.#host.goalModeEnabled()) names.push("goal");
			await this.#host.setActiveToolsByName(names);
			await this.#host.refreshSystemPrompt();
			if (!wasEnabled) {
				if (persistModeChange) this.#host.persistModeChange(true);
				await this.#host.emitModeChanged("orchestrator");
			}
			return;
		}
		this.#orchestratorModeState = undefined;
		const previousToolNames = this.#previousToolNames;
		this.#previousToolNames = undefined;
		if (previousToolNames && restorePreviousTools) {
			const names = [...new Set([...previousToolNames, ...(this.#host.goalModeEnabled() ? ["goal"] : [])])];
			await this.#host.setActiveToolsByName(names);
		} else {
			await this.#host.refreshSystemPrompt();
		}
		if (wasEnabled) {
			if (persistModeChange) this.#host.persistModeChange(false);
			await this.#host.emitModeChanged("none");
		}
	}

	#ensureController(restored?: DuoStateSnapshot): DuoController | undefined {
		if (this.#controller) return this.#controller;
		if (this.#host.agentKind() !== "main") return undefined;
		if (!restored && !this.#couldActivate()) return undefined;
		const config = resolveDuoConfig(this.#host.settings, this.#host.availableModels(), this.#host.modelRegistry);
		if (!config) return undefined;
		this.#controller = new DuoController(
			{
				currentModel: () => this.#host.currentModel(),
				availableModels: () => this.#host.availableModels(),
				isStreaming: () => this.#host.isStreaming(),
				setModelTemporary: (model, thinkingLevel) => this.#host.setModelTemporary(model, thinkingLevel),
				setThinkingLevel: level => this.#host.setThinkingLevel(level),
				configuredThinkingLevel: () => this.#host.configuredThinkingLevel(),
				ensureAdvisorStarted: planner => this.#host.ensureDuoAdvisorStarted(planner),
				stopDuoAdvisor: () => this.#host.stopDuoAdvisor(),
				scheduleAdvisorRevive: retryAfterMs => this.#host.scheduleDuoAdvisorRevive(retryAfterMs),
				pauseAdvisor: () => this.#host.pauseAdvisors(),
				resumeAdvisor: () => this.#host.resumeAdvisors(),
				injectBrief: (text, deliverAs) => this.#host.injectDuoBrief(text, deliverAs),
				emitNotice: (level, text) => this.#host.emitNotice(level, text, "duo"),
				persistSnapshot: snapshot => this.#host.persistDuoSnapshot(snapshot),
				planArtifactReady: () => this.#host.planArtifactReady(),
				orchestratorEnabled: () => this.#orchestratorModeState?.enabled === true,
				setOrchestratorEnabled: enabled => this.#setDuoOrchestratorEnabled(enabled),
				setPlanModeEnabled: enabled => this.#setDuoPlanModeEnabled(enabled),
				planModeActive: () => this.#host.getPlanModeState()?.enabled === true,
				requestAgentContinue: () => this.#host.requestAgentContinue(),
			},
			config,
			restored,
		);
		return this.#controller;
	}

	#couldActivate(): boolean {
		const mode = this.#host.settings.get("duo.mode");
		if (mode === "off") return false;
		if (mode === "on" || this.#host.settings.get("duo.orchestrator") === "always") return true;
		const parsed = parseAnthropicModel(this.#host.currentModel()?.id ?? "");
		return this.#orchestratorModeState?.enabled === true || (parsed !== null && isFableOrMythos(parsed.kind));
	}

	async #setDuoOrchestratorEnabled(enabled: boolean): Promise<void> {
		const decision = resolveDuoOrchestratorOwnership(
			enabled,
			this.#orchestratorModeState?.enabled === true,
			this.#duoOwnsOrchestrator,
		);
		this.#duoOwnsOrchestrator = decision.owns;
		if (decision.apply === "enable") {
			await this.setOrchestratorModeState({ enabled: true }, { persistModeChange: false });
		} else if (decision.apply === "disable") {
			await this.setOrchestratorModeState(undefined, { persistModeChange: false, restorePreviousTools: true });
		}
	}

	#setDuoPlanModeEnabled(enabled: boolean): void {
		const current = this.#host.getPlanModeState()?.enabled === true;
		if (enabled === current) {
			if (enabled) this.#duoOwnsPlanMode = true;
			return;
		}
		if (enabled) {
			this.#duoOwnsPlanMode = true;
			this.#host.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" });
			return;
		}
		if (!this.#duoOwnsPlanMode) return;
		this.#duoOwnsPlanMode = false;
		this.#host.setPlanModeState(undefined);
	}
}
