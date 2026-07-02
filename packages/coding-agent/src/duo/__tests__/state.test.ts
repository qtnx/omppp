import { describe, expect, it } from "bun:test";
import type { DuoActivationInput, DuoStateSnapshot } from "../state";
import { DuoStateMachine } from "../state";

const config = { cooldownTurns: 3, maxConsecutive: 2 };

const input = (overrides: Partial<DuoActivationInput> = {}): DuoActivationInput => ({
	mode: "auto",
	orchestratorEnabled: false,
	mainModelKind: "other",
	plannerResolvable: true,
	executorResolvable: true,
	planModeActive: false,
	...overrides,
});

describe("DuoStateMachine activation", () => {
	it("keeps duo inactive when mode is off", () => {
		const machine = new DuoStateMachine(config);

		expect(
			machine.evaluateActivation(input({ mode: "off", orchestratorEnabled: true, mainModelKind: "fable" })),
		).toBe("inactive");
		expect(machine.phase).toBe("inactive");
	});

	it("activates in on mode when both sides are resolvable", () => {
		const machine = new DuoStateMachine(config);

		expect(machine.evaluateActivation(input({ mode: "on", mainModelKind: "other" }))).toBe("executing");
		expect(machine.phase).toBe("executing");
	});

	it("activates in auto mode when orchestrator mode is enabled", () => {
		const machine = new DuoStateMachine(config);

		expect(machine.evaluateActivation(input({ orchestratorEnabled: true, mainModelKind: "other" }))).toBe(
			"executing",
		);
	});

	it("activates executing for planner-kind main model without active plan mode", () => {
		const machine = new DuoStateMachine(config);

		expect(machine.evaluateActivation(input({ mainModelKind: "fable" }))).toBe("executing");
	});

	it("starts in planning when plan mode is active", () => {
		const machine = new DuoStateMachine(config);

		expect(machine.evaluateActivation(input({ mainModelKind: "fable", planModeActive: true }))).toBe("planning");
	});

	it("does not activate unless both planner and executor are resolvable", () => {
		const missingPlanner = new DuoStateMachine(config);
		const missingExecutor = new DuoStateMachine(config);

		expect(missingPlanner.evaluateActivation(input({ mode: "on", plannerResolvable: false }))).toBe("inactive");
		expect(missingExecutor.evaluateActivation(input({ mode: "on", executorResolvable: false }))).toBe("inactive");
	});

	it("auto-deactivates inactive, planning, and executing phases when activation condition is lost", () => {
		const planning = new DuoStateMachine(config);
		planning.evaluateActivation(input({ mainModelKind: "fable", planModeActive: true }));
		expect(planning.evaluateActivation(input({ mode: "off" }))).toBe("inactive");

		const executing = new DuoStateMachine(config);
		executing.evaluateActivation(input({ mode: "on" }));
		expect(
			executing.evaluateActivation(input({ mode: "auto", orchestratorEnabled: false, mainModelKind: "other" })),
		).toBe("inactive");
	});

	it("does not auto-deactivate suspended or takeover phases", () => {
		const suspended = new DuoStateMachine(config);
		suspended.evaluateActivation(input({ mode: "on" }));
		suspended.onSetModelFailed();
		expect(suspended.evaluateActivation(input({ mode: "off" }))).toBe("suspended");

		const takeover = new DuoStateMachine(config);
		takeover.evaluateActivation(input({ mode: "on" }));
		expect(takeover.onTakeoverRequested("recover")).toBe("accepted");
		expect(takeover.evaluateActivation(input({ mode: "off" }))).toBe("takeover");
	});
});

describe("DuoStateMachine transitions", () => {
	it("transitions from planning to executing when the plan is approved", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mainModelKind: "fable", planModeActive: true }));

		expect(machine.onPlanApproved()).toBe(true);
		expect(machine.phase).toBe("executing");
		expect(machine.onPlanApproved()).toBe(false);
	});

	it("returns executing to planning on replan without touching takeover counters", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		expect(machine.phase).toBe("executing");

		expect(machine.onReplanRequested()).toBe(true);
		expect(machine.snapshot).toMatchObject({ phase: "planning", takeoverCount: 0, consecutiveTakeovers: 0 });
		// Only the executor's stream can be handed back for re-planning.
		expect(machine.onReplanRequested()).toBe(false);
		// The replanning cycle completes through the normal handoff.
		expect(machine.onHandoffToExecutor()).toBe(true);
		expect(machine.phase).toBe("executing");
	});

	it("accepts a recover takeover while executing", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));

		expect(machine.onTakeoverRequested("recover")).toBe("accepted");
		expect(machine.snapshot).toMatchObject({
			phase: "takeover",
			takeoverPurpose: "recover",
			takeoverCount: 1,
			consecutiveTakeovers: 1,
		});
	});

	it("returns cooldown-advice for recover takeovers during cooldown", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onTakeoverRequested("recover");
		expect(machine.onHandoffToExecutor()).toBe(true);

		expect(machine.onTakeoverRequested("recover")).toBe("cooldown-advice");
		expect(machine.snapshot).toMatchObject({ phase: "executing", takeoverCount: 1, consecutiveTakeovers: 1 });
	});

	it("accepts executor escalation during cooldown but respects maxConsecutive", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		expect(machine.onTakeoverRequested("recover")).toBe("accepted");
		expect(machine.onHandoffToExecutor()).toBe(true);
		expect(machine.snapshot.cooldownRemaining).toBeGreaterThan(0);

		expect(machine.onExecutorEscalate()).toBe("accepted");
		expect(machine.snapshot).toMatchObject({
			phase: "takeover",
			takeoverPurpose: "recover",
			consecutiveTakeovers: 2,
		});
		expect(machine.onExecutorEscalate()).toBe("rejected");
		expect(machine.onHandoffToExecutor()).toBe(true);
		expect(machine.onExecutorEscalate()).toBe("rejected");
	});

	it("allows verify takeovers to bypass cooldown", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onTakeoverRequested("recover");
		machine.onHandoffToExecutor();

		expect(machine.onTakeoverRequested("verify")).toBe("accepted");
		expect(machine.snapshot).toMatchObject({ phase: "takeover", takeoverPurpose: "verify", takeoverCount: 2 });
	});

	it("does not reset consecutive takeovers on handoff to executor", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onTakeoverRequested("recover");

		expect(machine.onHandoffToExecutor()).toBe(true);

		expect(machine.snapshot).toMatchObject({ phase: "executing", consecutiveTakeovers: 1, cooldownRemaining: 3 });
	});

	it("rejects takeover requests after maxConsecutive is reached", () => {
		const machine = new DuoStateMachine({ cooldownTurns: 3, maxConsecutive: 2 });
		machine.evaluateActivation(input({ mode: "on" }));
		expect(machine.onTakeoverRequested("recover")).toBe("accepted");
		expect(machine.onHandoffToExecutor()).toBe(true);
		expect(machine.onTakeoverRequested("verify")).toBe("accepted");
		expect(machine.onHandoffToExecutor()).toBe(true);

		expect(machine.onTakeoverRequested("verify")).toBe("rejected");
		expect(machine.snapshot).toMatchObject({ phase: "executing", takeoverCount: 2, consecutiveTakeovers: 2 });
	});

	it("decrements cooldown to a floor of zero only while executing", () => {
		const machine = new DuoStateMachine({ cooldownTurns: 2, maxConsecutive: 2 });
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onTakeoverRequested("recover");
		machine.onHandoffToExecutor();

		machine.onExecutorTurnEnd();
		expect(machine.snapshot.cooldownRemaining).toBe(1);
		machine.onExecutorTurnEnd();
		expect(machine.snapshot.cooldownRemaining).toBe(0);
		machine.onExecutorTurnEnd();
		expect(machine.snapshot.cooldownRemaining).toBe(0);
		machine.onTakeoverRequested("recover");
		machine.onExecutorTurnEnd();
		expect(machine.snapshot.cooldownRemaining).toBe(0);
	});

	it("resets consecutive takeovers when cooldown fully elapses", () => {
		const machine = new DuoStateMachine({ cooldownTurns: 2, maxConsecutive: 2 });
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onTakeoverRequested("recover");
		machine.onHandoffToExecutor();

		machine.onExecutorTurnEnd();
		expect(machine.snapshot.consecutiveTakeovers).toBe(1);
		machine.onExecutorTurnEnd();

		expect(machine.snapshot).toMatchObject({ cooldownRemaining: 0, consecutiveTakeovers: 0 });
	});

	it("suspends active phases after set-model failures", () => {
		const failed = new DuoStateMachine(config);
		failed.evaluateActivation(input({ mode: "on" }));
		failed.onSetModelFailed();
		expect(failed.snapshot).toMatchObject({ phase: "suspended", suspendReason: "set-model-failed" });
	});

	it("recomputes activation phase when resumed from suspended", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onSetModelFailed();

		expect(machine.onResume(input({ mainModelKind: "fable", planModeActive: true }))).toBe("planning");
		expect(machine.snapshot.suspendReason).toBeUndefined();
	});

	it("moves from executing to degraded when the advisor drops", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));

		machine.onAdvisorDropped();

		expect(machine.phase).toBe("degraded");
	});

	it("degraded recovers to executing when still activatable", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onAdvisorDropped();

		expect(machine.evaluateActivation(input({ mode: "on" }))).toBe("executing");
		expect(machine.phase).toBe("executing");
	});

	it("degraded deactivates when no longer activatable", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onAdvisorDropped();

		expect(machine.evaluateActivation(input({ mode: "off" }))).toBe("inactive");
		expect(machine.phase).toBe("inactive");
	});

	it("executor can escalate from degraded", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onAdvisorDropped();

		expect(machine.onExecutorEscalate()).toBe("accepted");
		expect(machine.snapshot).toMatchObject({ phase: "takeover", takeoverPurpose: "recover" });
	});

	it("restored degraded snapshot recovers on first evaluate", () => {
		const restored: DuoStateSnapshot = {
			phase: "degraded",
			takeoverCount: 1,
			consecutiveTakeovers: 1,
			cooldownRemaining: 0,
		};
		const machine = new DuoStateMachine(config, restored);

		expect(machine.evaluateActivation(input({ mode: "on" }))).toBe("executing");
		expect(machine.phase).toBe("executing");
	});

	it("duo off always returns to inactive and clears transient fields", () => {
		const machine = new DuoStateMachine(config);
		machine.evaluateActivation(input({ mode: "on" }));
		machine.onTakeoverRequested("recover");

		machine.onDuoOff();

		expect(machine.snapshot).toMatchObject({
			phase: "inactive",
			takeoverCount: 1,
			consecutiveTakeovers: 1,
			cooldownRemaining: 0,
		});
		expect(machine.snapshot.takeoverPurpose).toBeUndefined();
		expect(machine.snapshot.suspendReason).toBeUndefined();
	});

	it("round-trips restored snapshots and exposes defensive snapshot copies", () => {
		const restored: DuoStateSnapshot = {
			phase: "takeover",
			plannerId: "anthropic/claude-fable-4",
			executorId: "anthropic/claude-opus-4",
			takeoverPurpose: "verify",
			takeoverCount: 3,
			consecutiveTakeovers: 2,
			cooldownRemaining: 1,
			suspendReason: "set-model-failed",
			preDuoThinking: "auto",
		};
		const machine = new DuoStateMachine(config, restored);
		const snapshot = machine.snapshot;
		snapshot.phase = "inactive";
		snapshot.takeoverCount = 0;

		expect(machine.snapshot).toEqual(restored);
		expect(machine.phase).toBe("takeover");
	});
});
