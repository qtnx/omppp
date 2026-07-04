import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	onAppendOnlyModeChanged,
	resetSettingsForTest,
	Settings,
	type Settings as SettingsInstance,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("Settings live reload", () => {
	let settingsState: SettingsTestState | undefined;
	let testDir: string;
	let agentDir: string;
	let cwd: string;
	let activeSettings: SettingsInstance | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		testDir = path.join(os.tmpdir(), "settings-live-reload", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		cwd = path.join(testDir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		activeSettings?.stopWatching();
		await activeSettings?.flush();
		activeSettings = undefined;
		resetSettingsForTest();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		if (fs.existsSync(testDir)) {
			removeSyncWithRetries(testDir);
		}
	});

	it("reloadFromDisk applies an external global config edit and fires only changed hooks", async () => {
		const configPath = path.join(agentDir, "config.yml");
		fs.writeFileSync(configPath, "provider:\n  appendOnlyContext: auto\ncompaction:\n  enabled: true\n");
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });

		const appendOnlyEvents: string[] = [];
		const unsubscribe = onAppendOnlyModeChanged(value => appendOnlyEvents.push(value));
		try {
			fs.writeFileSync(configPath, "provider:\n  appendOnlyContext: off\ncompaction:\n  enabled: true\n");

			await activeSettings.reloadFromDisk();

			expect(activeSettings.get("provider.appendOnlyContext")).toBe("off");
			expect(appendOnlyEvents).toEqual(["off"]);

			appendOnlyEvents.length = 0;
			fs.writeFileSync(configPath, "provider:\n  appendOnlyContext: off\ncompaction:\n  enabled: false\n");
			await activeSettings.reloadFromDisk();

			expect(activeSettings.get("compaction.enabled")).toBe(false);
			expect(appendOnlyEvents).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	it("keeps in-memory overrides above disk values when reloading", async () => {
		const configPath = path.join(agentDir, "config.yml");
		fs.writeFileSync(configPath, "compaction:\n  enabled: true\n");
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });
		activeSettings.override("compaction.enabled", false);

		fs.writeFileSync(configPath, "compaction:\n  enabled: true\n");
		await activeSettings.reloadFromDisk();

		expect(activeSettings.get("compaction.enabled")).toBe(false);
	});

	it("reloads OpenCode project settings after an atomic rename through the watcher reload path", async () => {
		const projectSettingsPath = path.join(cwd, "opencode.json");
		fs.writeFileSync(projectSettingsPath, JSON.stringify({ provider: { appendOnlyContext: "auto" } }));
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });
		expect(activeSettings.getProjectSettingsPaths()).toContain(path.normalize(projectSettingsPath));

		const appendOnlyEvents: string[] = [];
		const unsubscribe = onAppendOnlyModeChanged(value => appendOnlyEvents.push(value));
		try {
			const tempConfigPath = path.join(cwd, "opencode.json.tmp");
			fs.writeFileSync(tempConfigPath, JSON.stringify({ provider: { appendOnlyContext: "on" } }));
			fs.renameSync(tempConfigPath, projectSettingsPath);
			await activeSettings.reloadFromDisk({ source: "watcher", changedPath: projectSettingsPath });

			expect(activeSettings.get("provider.appendOnlyContext")).toBe("on");
			expect(appendOnlyEvents).toEqual(["on"]);
		} finally {
			unsubscribe();
		}
	});

	it("observes an OpenCode project settings file created after watching starts", async () => {
		const projectSettingsPath = path.join(cwd, "opencode.json");
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });
		expect(activeSettings.getProjectSettingsPaths()).not.toContain(path.normalize(projectSettingsPath));
		activeSettings.startWatching();

		const changed = Promise.withResolvers<string>();
		const unsubscribe = onAppendOnlyModeChanged(value => {
			if (value === "on") {
				changed.resolve(value);
			}
		});
		try {
			fs.writeFileSync(projectSettingsPath, JSON.stringify({ provider: { appendOnlyContext: "on" } }));

			expect(await changed.promise).toBe("on");
			expect(activeSettings.get("provider.appendOnlyContext")).toBe("on");
			expect(activeSettings.getProjectSettingsPaths()).toContain(path.normalize(projectSettingsPath));
		} finally {
			unsubscribe();
		}
	});

	it("does not drop a project settings edit when an own save is pending", async () => {
		const projectSettingsPath = path.join(cwd, "opencode.json");
		fs.writeFileSync(projectSettingsPath, JSON.stringify({ provider: { appendOnlyContext: "auto" } }));
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });
		activeSettings.startWatching();

		const changed = Promise.withResolvers<string>();
		const unsubscribe = onAppendOnlyModeChanged(value => {
			if (value === "on") {
				changed.resolve(value);
			}
		});
		try {
			fs.writeFileSync(projectSettingsPath, JSON.stringify({ provider: { appendOnlyContext: "on" } }));
			activeSettings.set("compaction.enabled", false);

			expect(await changed.promise).toBe("on");
			expect(activeSettings.get("provider.appendOnlyContext")).toBe("on");
			expect(activeSettings.get("compaction.enabled")).toBe(false);
		} finally {
			unsubscribe();
		}
	});

	it("suppresses watcher reloads caused by its own debounced save", async () => {
		const configPath = path.join(agentDir, "config.yml");
		fs.writeFileSync(configPath, "provider:\n  appendOnlyContext: auto\n");
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });
		activeSettings.startWatching();

		const appendOnlyEvents: string[] = [];
		const unsubscribe = onAppendOnlyModeChanged(value => appendOnlyEvents.push(value));
		try {
			activeSettings.set("provider.appendOnlyContext", "off");
			await activeSettings.flush();
			await activeSettings.reloadFromDisk({ source: "watcher", changedPath: configPath });

			expect(activeSettings.get("provider.appendOnlyContext")).toBe("off");
			expect(appendOnlyEvents.filter(value => value === "off")).toEqual(["off"]);
		} finally {
			unsubscribe();
		}
	});
});
