import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DuoPhase } from "@oh-my-pi/pi-coding-agent/duo/state";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function makeSession(phase: DuoPhase | undefined): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getDuoStatus: phase === undefined ? undefined : () => ({ phase, takeoverCount: 0, advisorPaused: false }),
	} as ToolSession;
}

describe("duo tool gating", () => {
	it("creates the duo tools only while a duo controller is live", async () => {
		for (const phase of [undefined, "inactive", "suspended"] as const) {
			const names = (await createTools(makeSession(phase))).map(tool => tool.name);
			expect(names).not.toContain("duo_handoff");
			expect(names).not.toContain("duo_escalate");
			expect(names).not.toContain("duo_change_phase");
		}
		for (const phase of ["planning", "executing", "takeover", "degraded"] as const) {
			const names = (await createTools(makeSession(phase))).map(tool => tool.name);
			expect(names).toContain("duo_handoff");
			expect(names).toContain("duo_escalate");
			expect(names).toContain("duo_change_phase");
		}
	});

	it("honors an explicit tool list that names the duo tools even when duo is off", async () => {
		const names = (await createTools(makeSession(undefined), ["read", "duo_handoff"])).map(tool => tool.name);
		expect(names).toContain("duo_handoff");
		expect(names).not.toContain("duo_escalate");
		expect(names).not.toContain("duo_change_phase");
	});
});
