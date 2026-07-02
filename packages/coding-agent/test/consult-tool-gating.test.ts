import { describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function makeSession(settingsOverrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(settingsOverrides),
	};
}

describe("consult tool gating", () => {
	it("is present when advisor.enabled and advisor.consult are both true", async () => {
		const names = (await createTools(makeSession({ "advisor.enabled": true, "advisor.consult": true }))).map(
			t => t.name,
		);
		expect(names).toContain("consult");
	});

	it("is absent when advisor.enabled is false (compound gate — avoids a dead tool)", async () => {
		const names = (await createTools(makeSession({ "advisor.enabled": false, "advisor.consult": true }))).map(
			t => t.name,
		);
		expect(names).not.toContain("consult");
	});

	it("is absent when advisor.consult is off even with advisor enabled", async () => {
		const names = (await createTools(makeSession({ "advisor.enabled": true, "advisor.consult": false }))).map(
			t => t.name,
		);
		expect(names).not.toContain("consult");
	});
});
