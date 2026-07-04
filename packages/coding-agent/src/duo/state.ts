import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";

export type DuoPhase = "inactive" | "planning" | "executing" | "takeover" | "suspended" | "degraded";
export type DuoExecutionScope = "single" | "multi";
export type DuoMode = "auto" | "on" | "off";
export type TakeoverPurpose = "recover" | "plan";
export type DuoSuspendReason = "set-model-failed" | "unresolvable";

export interface DuoStateSnapshot {
	phase: DuoPhase;
	executionScope?: DuoExecutionScope;
	plannerId?: string;
	executorId?: string;
	takeoverPurpose?: TakeoverPurpose;
	takeoverCount: number;
	consecutiveTakeovers: number;
	cooldownRemaining: number;
	suspendReason?: DuoSuspendReason;
	preDuoThinking?: string;
	/** Advisor-selected executor effort override that survives duo snapshot resume. */
	executorThinkingOverride?: ThinkingLevel;
}

export interface DuoActivationInput {
	mode: DuoMode;
	orchestratorEnabled: boolean;
	mainModelKind: "opus" | "fable" | "other";
	plannerResolvable: boolean;
	executorResolvable: boolean;
	planModeActive: boolean;
}

export type TakeoverDecision = "accepted" | "cooldown-advice" | "rejected";

export interface TakeoverRequestOptions {
	/** Strong automatic signal: skip the recover cooldown gate. Max consecutive still applies. */
	bypassCooldown?: boolean;
}

interface DuoConfig {
	cooldownTurns: number;
	maxConsecutive: number;
}

export class DuoStateMachine {
	#config: DuoConfig;
	#state: DuoStateSnapshot;

	constructor(config: DuoConfig, restored?: DuoStateSnapshot) {
		this.#config = config;
		this.#state = {
			...(restored
				? structuredClone(restored)
				: {
						phase: "inactive",
						takeoverCount: 0,
						consecutiveTakeovers: 0,
						cooldownRemaining: 0,
					}),
			executionScope: restored?.executionScope ?? "multi",
		};
	}

	get snapshot(): DuoStateSnapshot {
		return structuredClone(this.#state);
	}

	get phase(): DuoPhase {
		return this.#state.phase;
	}

	get executionScope(): DuoExecutionScope {
		return this.#state.executionScope ?? "multi";
	}

	evaluateActivation(input: DuoActivationInput): DuoPhase {
		const nextPhase = activationPhase(input);
		const keepsSingleScopeAutoActive =
			input.mode === "auto" &&
			this.#state.executionScope === "single" &&
			input.plannerResolvable &&
			input.executorResolvable;
		if (this.#state.phase === "degraded") {
			this.#state.phase = canActivate(input) || keepsSingleScopeAutoActive ? "executing" : "inactive";
			return this.#state.phase;
		}
		if (this.#state.phase === "inactive") {
			this.#state.phase = nextPhase;
			if (this.#state.phase === "planning") {
				this.#state.executionScope = "multi";
			}
			return this.#state.phase;
		}

		if (this.#state.phase === "planning" || this.#state.phase === "executing") {
			if (nextPhase === "inactive" && !keepsSingleScopeAutoActive) {
				this.#state.phase = "inactive";
				this.#state.takeoverPurpose = undefined;
				this.#state.suspendReason = undefined;
				this.#state.executionScope = "multi";
			}
			if (this.#state.phase === "planning") {
				this.#state.executionScope = "multi";
			}
			return this.#state.phase;
		}

		return this.#state.phase;
	}

	onPlanApproved(): boolean {
		if (this.#state.phase !== "planning") {
			return false;
		}
		this.#state.phase = "executing";
		this.#state.executionScope = "multi";
		return true;
	}

	onHandoffToExecutor(scope?: DuoExecutionScope): boolean {
		if (this.#state.phase !== "planning" && this.#state.phase !== "takeover") {
			return false;
		}

		const fromTakeover = this.#state.phase === "takeover";
		this.#state.phase = "executing";
		if (scope !== undefined) {
			this.#state.executionScope = scope;
		}
		this.#state.takeoverPurpose = undefined;
		if (fromTakeover) {
			this.#state.cooldownRemaining = Math.max(0, Math.trunc(this.#config.cooldownTurns));
		}
		return true;
	}

	/** Plan mode re-entered while executing: hand the main stream back to the
	 *  planner. Not a takeover — counters and cooldown are untouched. */
	onReplanRequested(): boolean {
		if (this.#state.phase !== "executing") {
			return false;
		}
		this.#state.phase = "planning";
		this.#state.executionScope = "multi";
		this.#state.takeoverPurpose = undefined;
		return true;
	}

	/** Advisor/user prompt takeover for fresh planning; unlike recover takeover, counters and cooldown stay untouched. */
	onPlanTakeoverRequested(): boolean {
		if (this.#state.phase !== "executing") {
			return false;
		}
		this.#state.phase = "planning";
		this.#state.takeoverPurpose = undefined;
		return true;
	}

	/** Executor self-escalation is voluntary recovery, so it bypasses the
	 *  recover cooldown but still respects max consecutive takeovers. */
	onExecutorEscalate(): TakeoverDecision {
		if (
			(this.#state.phase !== "executing" && this.#state.phase !== "degraded") ||
			this.#state.consecutiveTakeovers >= this.#config.maxConsecutive
		) {
			return "rejected";
		}

		this.#state.phase = "takeover";
		this.#state.takeoverPurpose = "recover";
		this.#state.takeoverCount += 1;
		this.#state.consecutiveTakeovers += 1;
		return "accepted";
	}

	onTakeoverRequested(purpose: TakeoverPurpose, options?: TakeoverRequestOptions): TakeoverDecision {
		if (this.#state.consecutiveTakeovers >= this.#config.maxConsecutive) {
			return "rejected";
		}
		if (purpose === "recover" && this.#state.cooldownRemaining > 0 && !options?.bypassCooldown) {
			return "cooldown-advice";
		}
		if (this.#state.phase !== "executing") {
			return "rejected";
		}

		this.#state.phase = "takeover";
		this.#state.takeoverPurpose = purpose;
		this.#state.takeoverCount += 1;
		this.#state.consecutiveTakeovers += 1;
		return "accepted";
	}

	onExecutorTurnEnd(): void {
		if (this.#state.phase !== "executing") {
			return;
		}
		if (this.#state.cooldownRemaining > 0) {
			this.#state.cooldownRemaining -= 1;
			if (this.#state.cooldownRemaining === 0) {
				this.#state.consecutiveTakeovers = 0;
			}
		}
	}

	onSetModelFailed(): void {
		this.#suspend("set-model-failed");
	}

	onAdvisorDropped(): void {
		if (this.#state.phase === "executing") {
			this.#state.phase = "degraded";
		}
	}

	onResume(input: DuoActivationInput): DuoPhase {
		if (this.#state.phase !== "suspended") {
			return this.#state.phase;
		}
		this.#state.suspendReason = undefined;
		this.#state.takeoverPurpose = undefined;
		this.#state.phase = activationPhase(input);
		if (this.#state.phase === "planning") {
			this.#state.executionScope = "multi";
		}
		return this.#state.phase;
	}

	onDuoOff(): void {
		this.#state.phase = "inactive";
		this.#state.suspendReason = undefined;
		this.#state.takeoverPurpose = undefined;
		this.#state.executionScope = "multi";
		this.#state.executorThinkingOverride = undefined;
	}

	#suspend(reason: DuoSuspendReason): void {
		if (this.#state.phase === "inactive") {
			return;
		}
		this.#state.phase = "suspended";
		this.#state.suspendReason = reason;
		this.#state.takeoverPurpose = undefined;
	}
}

function activationPhase(input: DuoActivationInput): "inactive" | "planning" | "executing" {
	if (!canActivate(input)) {
		return "inactive";
	}
	if (input.planModeActive) {
		return "planning";
	}
	return "executing";
}

function canActivate(input: DuoActivationInput): boolean {
	if (input.mode === "off") {
		return false;
	}
	if (!input.plannerResolvable || !input.executorResolvable) {
		return false;
	}
	if (input.mode === "on") {
		return true;
	}
	return input.orchestratorEnabled || input.mainModelKind === "fable";
}
