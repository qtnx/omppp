import { describe, expect, it } from "bun:test";
import { getBundledAgent } from "../../src/task/agents";

describe("workflow-subagent bundled agent", () => {
	it("is registered, bundled, and not spawn-capable", () => {
		const agent = getBundledAgent("workflow-subagent");
		expect(agent).toBeDefined();
		expect(agent?.source).toBe("bundled");
		// Not spawn-capable → the `task` tool is NOT auto-added inside a workflow subagent.
		expect(agent?.spawns).toBeUndefined();
		expect(agent?.systemPrompt).toContain("workflow orchestration script");
	});
});
