import { describe, expect, it } from "bun:test";
import { resolveDuoPlanTakeoverDecision, shouldRunDuoDoneGate } from "../../session/agent-session";
import type { DuoStatus } from "../controller";
import { DuoStateMachine } from "../state";

const executing: DuoStatus = { phase: "executing", takeoverCount: 0, advisorPaused: false };
const planning: DuoStatus = { phase: "planning", takeoverCount: 0, advisorPaused: false };

describe("resolveDuoPlanTakeoverDecision", () => {
	it("requests a planning takeover for a plan-shaped user message while duo executes", () => {
		const decision = resolveDuoPlanTakeoverDecision(
			"main",
			executing,
			false,
			true,
			true,
			"Implement rate limiting on the API gateway:\n1. token bucket per key\n2. config flag\n3. tests",
		);

		expect(decision.request).toBe(true);
		if (decision.request) {
			expect(decision.reason).toContain("imperative build verb");
		}
	});

	it("does not request for questions or acknowledgements", () => {
		for (const text of ["why does the build fail?", "ok", "làm tiếp đi"]) {
			expect(resolveDuoPlanTakeoverDecision("main", executing, false, true, true, text)).toEqual({ request: false });
		}
	});

	it("does not request while streaming, in subagents, outside executing, or when disabled", () => {
		const text = "Build a new onboarding flow with email verification. Then add analytics events for each step.";
		expect(resolveDuoPlanTakeoverDecision("main", executing, true, true, true, text)).toEqual({ request: false });
		expect(resolveDuoPlanTakeoverDecision("sub", executing, false, true, true, text)).toEqual({ request: false });
		expect(resolveDuoPlanTakeoverDecision("main", planning, false, true, true, text)).toEqual({ request: false });
		expect(resolveDuoPlanTakeoverDecision("main", executing, false, false, true, text)).toEqual({ request: false });
		expect(resolveDuoPlanTakeoverDecision("main", executing, false, true, false, text)).toEqual({ request: false });
	});
});

describe("duo done gate helpers", () => {
	it("still runs for duo-inactive strict advisor review", () => {
		expect(shouldRunDuoDoneGate(true, undefined, "strict")).toBe(true);
	});
});

describe("verify-done takeover removal", () => {
	it("keeps takeover state recover-only and caps repeated recover requests", () => {
		const machine = new DuoStateMachine({ cooldownTurns: 3, maxConsecutive: 1 });
		machine.evaluateActivation({
			mode: "on",
			orchestratorEnabled: false,
			mainModelKind: "other",
			plannerResolvable: true,
			executorResolvable: true,
			planModeActive: false,
		});

		expect(machine.onTakeoverRequested("recover")).toBe("accepted");
		expect(machine.snapshot.takeoverPurpose).toBe("recover");
		expect(machine.onHandoffToExecutor()).toBe(true);
		expect(machine.onTakeoverRequested("recover", { bypassCooldown: true })).toBe("rejected");
		expect(machine.snapshot).toMatchObject({ phase: "executing", takeoverCount: 1, consecutiveTakeovers: 1 });
	});
});
