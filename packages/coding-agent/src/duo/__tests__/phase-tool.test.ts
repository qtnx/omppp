import { describe, expect, test } from "bun:test";
import type { WorkPhase } from "@oh-my-pi/pi-coding-agent/signals/index";
import { DuoChangePhaseTool, type DuoChangePhaseResult } from "../phase-tool";

function recordingTool(result: DuoChangePhaseResult = "ok"): {
	calls: Array<{ phase: WorkPhase; reason: string | undefined }>;
	tool: DuoChangePhaseTool;
} {
	const calls: Array<{ phase: WorkPhase; reason: string | undefined }> = [];
	const tool = new DuoChangePhaseTool(async (phase, reason) => {
		calls.push({ phase, reason });
		return result;
	});
	return { calls, tool };
}

describe("DuoChangePhaseTool", () => {
	test("forwards the phase and its rationale to the duo controller", async () => {
		const { calls, tool } = recordingTool();

		const result = await tool.execute("1", { phase: "planning", reason: "idea understood" });

		expect(calls).toEqual([{ phase: "planning", reason: "idea understood" }]);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("planning") });
	});

	test("reports the controller refusal instead of claiming a switch", async () => {
		const { tool } = recordingTool("unavailable");

		await expect(tool.execute("1", { phase: "verifying" })).rejects.toThrow(/only available while a duo controller/);
	});

	test("surfaces a failed model switch as a tool error", async () => {
		const { tool } = recordingTool("switch-failed");

		await expect(tool.execute("1", { phase: "implementing" })).rejects.toThrow(
			/could not switch the main-stream model/,
		);
	});
});
