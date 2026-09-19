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

describe("duo tool registration", () => {
	// A session must be able to call `duo_handoff` the moment duo activates. The
	// registry is built before the controller exists, so phase-gated registration
	// left an activated session with no handoff tool.
	it("registers the duo tools for every duo phase, including no controller yet", async () => {
		for (const phase of [
			undefined,
			"inactive",
			"suspended",
			"planning",
			"executing",
			"takeover",
			"degraded",
		] as const) {
			const names = (await createTools(makeSession(phase))).map(tool => tool.name);
			expect(names).toContain("duo_handoff");
			expect(names).toContain("duo_escalate");
			expect(names).toContain("duo_change_phase");
		}
	});

	it("keeps duo tools out of a restricted surface unless the caller names them", async () => {
		const restricted = { ...makeSession("executing"), restrictToolNames: true } as ToolSession;
		const without = (await createTools(restricted, ["read"])).map(tool => tool.name);
		expect(without).not.toContain("duo_handoff");
		const named = (await createTools(restricted, ["read", "duo_handoff"])).map(tool => tool.name);
		expect(named).toContain("duo_handoff");
		expect(named).not.toContain("duo_escalate");
		expect(named).not.toContain("duo_change_phase");
	});

	it("honors an explicit tool list that names the duo tools", async () => {
		const names = (await createTools(makeSession(undefined), ["read", "duo_handoff"])).map(tool => tool.name);
		expect(names).toContain("duo_handoff");
		expect(names).not.toContain("duo_escalate");
		expect(names).not.toContain("duo_change_phase");
	});
});
