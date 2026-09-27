import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgMemoryIdleTrimEnabled, cfgMemoryIdleTrimMcp, cfgMemoryIdleTrimSeconds } from "../../src/session/settings";
import { TAB_GROUPS } from "@oh-my-pi/pi-tui/overlays/settings-defs";

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
		expect(cfgMemoryIdleTrimEnabled.get(settings)).toBe(true);
		expect(cfgMemoryIdleTrimSeconds.get(settings)).toBe(600);
		expect(cfgMemoryIdleTrimMcp.get(settings)).toBe(true);
		expect(cfgMemoryIdleTrimEnabled.default).toBe(true);
		expect(cfgMemoryIdleTrimSeconds.default).toBe(600);
		expect(cfgMemoryIdleTrimMcp.default).toBe(true);
	});

	it("reads idle trim fields from the registry handles", () => {
		const settings = Settings.instance;
		expect(cfgMemoryIdleTrimEnabled.get(settings)).toBe(true);
		expect(cfgMemoryIdleTrimSeconds.get(settings)).toBe(600);
		expect(cfgMemoryIdleTrimMcp.get(settings)).toBe(true);
	});

	it("registers Memory group on the context tab with UI metadata", () => {
		expect(TAB_GROUPS.context).toContain("Memory");
		expect(cfgMemoryIdleTrimEnabled.ui).toMatchObject({
			tab: "context",
			group: "Memory",
			label: "Idle Memory Trim",
		});
		expect(cfgMemoryIdleTrimSeconds.ui).toMatchObject({
			tab: "context",
			group: "Memory",
			label: "Seconds idle before trimming",
		});
		expect(cfgMemoryIdleTrimMcp.ui).toMatchObject({
			tab: "context",
			group: "Memory",
			label: "Trim MCP servers when idle",
		});
	});
});
