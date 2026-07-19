import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault, SETTINGS_SCHEMA, TAB_GROUPS } from "@oh-my-pi/pi-coding-agent/config/settings-schema";

describe("memory idle trim settings", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("resolves idle trim defaults through settings.get", () => {
		const settings = Settings.instance;
		expect(settings.get("memory.idleTrimEnabled")).toBe(true);
		expect(settings.get("memory.idleTrimSeconds")).toBe(600);
		expect(settings.get("memory.idleTrimMcp")).toBe(true);
		expect(getDefault("memory.idleTrimEnabled")).toBe(true);
		expect(getDefault("memory.idleTrimSeconds")).toBe(600);
		expect(getDefault("memory.idleTrimMcp")).toBe(true);
	});

	it("exposes idle trim fields on getGroup('memory')", () => {
		const group = Settings.instance.getGroup("memory");
		expect(group.idleTrimEnabled).toBe(true);
		expect(group.idleTrimSeconds).toBe(600);
		expect(group.idleTrimMcp).toBe(true);
	});

	it("registers Memory group on the context tab with UI metadata", () => {
		expect(TAB_GROUPS.context).toContain("Memory");
		expect(SETTINGS_SCHEMA["memory.idleTrimEnabled"].ui).toMatchObject({
			tab: "context",
			group: "Memory",
			label: "Idle Memory Trim",
		});
		expect(SETTINGS_SCHEMA["memory.idleTrimSeconds"].ui).toMatchObject({
			tab: "context",
			group: "Memory",
			label: "Seconds idle before trimming",
		});
		expect(SETTINGS_SCHEMA["memory.idleTrimMcp"].ui).toMatchObject({
			tab: "context",
			group: "Memory",
			label: "Trim MCP servers when idle",
		});
	});
});
