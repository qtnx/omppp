import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { containsWorkflow, highlightWorkflow, WORKFLOW_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/workflow";

beforeAll(() => {
	// highlightWorkflow reads the global theme's color mode.
	initTheme();
});

describe("workflow keyword detection", () => {
	it("matches the lowercase trigger word delimited by whitespace", () => {
		expect(containsWorkflow("workflow")).toBe(true);
		expect(containsWorkflow("please workflow this rollout")).toBe(true);
		expect(containsWorkflow("design the workflows")).toBe(true);
		expect(containsWorkflow("run these workflows")).toBe(true);
	});

	it("ignores casing and path-embedded forms but preserves lowercase prose-substring triggers", () => {
		expect(containsWorkflow("Workflow")).toBe(false);
		expect(containsWorkflow("WORKFLOW")).toBe(false);
		expect(containsWorkflow("workflowed the build")).toBe(true);
		expect(containsWorkflow("workflowz +500k! compare these approaches")).toBe(true);
		expect(containsWorkflow("reworkflow everything")).toBe(true);
		// A path/extension is masked by prose detection, so it does not trigger.
		expect(containsWorkflow("packages/coding-agent/test/modes/workflow.test.ts")).toBe(false);
		expect(containsWorkflow("do it. workflow.")).toBe(true);
		expect(containsWorkflow("nothing to see here")).toBe(false);
	});
});

describe("workflow keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const input = "please workflow this";
		const decorated = highlightWorkflow(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		// Probe hits the substring but the whitespace boundary fails — no decoration.
		expect(highlightWorkflow("workflowed builds")).toBe("workflowed builds");
		expect(highlightWorkflow("Workflow this")).toBe("Workflow this");
		const filePath = "packages/coding-agent/test/modes/workflow.test.ts";
		expect(highlightWorkflow(filePath)).toBe(filePath);
	});
});

describe("workflow notice", () => {
	it("is a non-empty system notice carrying the eval-fan-out contract", () => {
		expect(WORKFLOW_NOTICE.length).toBeGreaterThan(0);
		expect(WORKFLOW_NOTICE).toContain("**workflow** keyword");
		expect(WORKFLOW_NOTICE).toContain("parallel(");
	});
});
