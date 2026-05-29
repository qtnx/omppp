import { describe, expect, it } from "bun:test";
import { renderWorkflowTree } from "../../src/workflow/render";
import type { WorkflowProgressFrame } from "../../src/workflow/types";

describe("renderWorkflowTree", () => {
	it("groups agents under phases, collapses to latest state, surfaces logs", () => {
		const frames: WorkflowProgressFrame[] = [
			{ kind: "phase", runId: "r", index: 1, title: "scan" },
			{
				kind: "agent",
				runId: "r",
				index: 1,
				label: "scan:a",
				phaseTitle: "scan",
				state: "start",
				agentId: "0-scan",
			},
			{
				kind: "agent",
				runId: "r",
				index: 1,
				label: "scan:a",
				phaseTitle: "scan",
				state: "done",
				agentId: "0-scan",
				durationMs: 120,
			},
			{ kind: "log", runId: "r", message: "1 found" },
		];
		const text = renderWorkflowTree(frames);
		expect(text).toContain("▸ scan");
		expect(text).toContain("scan:a");
		expect(text).toContain("✓"); // done glyph (last state wins over start)
		expect(text).not.toContain("•"); // start glyph collapsed away
		expect(text).toContain("» 1 found");
	});

	it("returns a placeholder when empty", () => {
		expect(renderWorkflowTree([])).toContain("no workflow activity");
	});
});
