import { describe, expect, test } from "bun:test";
import { duoStatusToSnapshot } from "@oh-my-pi/pi-coding-agent/session/session-duo-orchestrator";

describe("duoStatusToSnapshot", () => {
	test("preserves the live phase, models, scope, and takeover state for an in-flight takeover", () => {
		const snapshot = duoStatusToSnapshot({
			phase: "takeover",
			planner: "anthropic/claude-fable-5-1:medium",
			executor: "tnx/openrouter/~deepseek/deepseek-v4-flash-latest:high",
			takeoverPurpose: "recover",
			takeoverCount: 2,
			executionScope: "multi",
			advisorPaused: true,
		});

		expect(snapshot.phase).toBe("takeover");
		expect(snapshot.takeoverPurpose).toBe("recover");
		expect(snapshot.takeoverCount).toBe(2);
		expect(snapshot.executionScope).toBe("multi");
		expect(snapshot.plannerId).toBe("anthropic/claude-fable-5-1:medium");
		expect(snapshot.executorId).toBe("tnx/openrouter/~deepseek/deepseek-v4-flash-latest:high");
		// Rebuilt controllers re-earn cooldown credit rather than carrying stale state.
		expect(snapshot.cooldownRemaining).toBe(0);
	});

	test("accepts a status already in the inactive phase", () => {
		const snapshot = duoStatusToSnapshot({
			phase: "inactive",
			takeoverCount: 0,
			advisorPaused: false,
		});

		expect(snapshot.phase).toBe("inactive");
		expect(snapshot.takeoverCount).toBe(0);
		expect(snapshot.takeoverPurpose).toBeUndefined();
	});
});
