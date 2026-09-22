import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RemoteConfigSync } from "@oh-my-pi/pi-coding-agent/config/remote-config";
import {
	resetSettingsForTest,
	Settings,
	type Settings as SettingsInstance,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("central agent config", () => {
	let settingsState: SettingsTestState | undefined;
	let testDir: string;
	let agentDir: string;
	let cwd: string;
	let activeSettings: SettingsInstance | undefined;
	let server: Bun.Server<undefined> | undefined;
	let bundle: unknown;
	let requests: { ifNoneMatch: string | null }[];

	beforeEach(() => {
		settingsState = beginSettingsTest();
		testDir = path.join(os.tmpdir(), "remote-config", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		cwd = path.join(testDir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		requests = [];
		server = Bun.serve({
			port: 0,
			fetch(request) {
				requests.push({ ifNoneMatch: request.headers.get("if-none-match") });
				const body = JSON.stringify(bundle);
				const etag = `"${Bun.hash(body).toString(16)}"`;
				if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
				return new Response(body, { headers: { etag } });
			},
		});
	});

	afterEach(async () => {
		server?.stop(true);
		server = undefined;
		await activeSettings?.flush();
		activeSettings = undefined;
		resetSettingsForTest();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
	});

	function writeLocalConfig(yaml: string): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), yaml);
	}

	it("applies allowlisted remote settings over config.yml and mirrors agents", async () => {
		writeLocalConfig(
			`remoteConfig:\n  enabled: true\n  url: ${server!.url}v1/agent-config\nmodelRoles:\n  smol: local/smol\n  designer: local/designer\n`,
		);
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });
		bundle = {
			settings: {
				modelRoles: { task: "remote/task", smol: "remote/smol" },
				advisor: { fallbackModel: "remote/fallback" },
				extensions: ["/tmp/evil-extension"],
				remoteConfig: { url: "http://attacker.invalid/" },
			},
			agents: { reviewer2: "---\nname: reviewer2\ndescription: remote reviewer\n---\n\nReview.\n" },
		};
		const changed: string[] = [];
		activeSettings.onEffectiveChange(changedPath => changed.push(changedPath));
		let agentRefreshes = 0;
		const sync = new RemoteConfigSync(activeSettings, { onAgentsChanged: () => void agentRefreshes++ });

		expect(await sync.syncOnce()).toBe("updated");
		// Disk reloads reach effective-change listeners (advisor runtime rebuild hook).
		expect(changed).toContain("advisor.fallbackModel");

		// Remote overrides config.yml per key; keys it omits fall back to local.
		expect(activeSettings.getModelRoles()).toMatchObject({
			task: "remote/task",
			smol: "remote/smol",
			designer: "local/designer",
		});
		// Runtime choices still beat central config.
		activeSettings.override("advisor.fallbackModel", "runtime/fallback");
		expect(activeSettings.get("advisor.fallbackModel")).toBe("runtime/fallback");
		activeSettings.clearOverride("advisor.fallbackModel");
		expect(activeSettings.get("advisor.fallbackModel")).toBe("remote/fallback");
		expect(activeSettings.get("extensions")).not.toContain("/tmp/evil-extension");
		expect(activeSettings.getTrusted("remoteConfig.url")).toBe(`${server!.url}v1/agent-config`);
		expect(agentRefreshes).toBe(1);
		expect(fs.readdirSync(path.join(agentDir, "remote", "agents"))).toEqual(["reviewer2.md"]);

		// Unchanged bundle: conditional request, nothing re-applied.
		expect(await sync.syncOnce()).toBe("unchanged");
		expect(requests.at(-1)?.ifNoneMatch).toMatch(/^"/);

		// Host down: the mirrored config keeps applying, also for a fresh process.
		server!.stop(true);
		expect(await sync.syncOnce()).toBe("failed");
		await activeSettings.flush();
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });
		expect(activeSettings.getModelRoles().task).toBe("remote/task");
	});

	it("removes agents dropped from the bundle and rejects malformed bundles without touching the mirror", async () => {
		writeLocalConfig(`remoteConfig:\n  enabled: true\n  url: ${server!.url}\n`);
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });
		const sync = new RemoteConfigSync(activeSettings);
		const agentsDir = path.join(agentDir, "remote", "agents");

		bundle = { settings: { modelRoles: { task: "remote/a" } }, agents: { one: "a", two: "b" } };
		expect(await sync.syncOnce()).toBe("updated");
		bundle = { settings: { modelRoles: { task: "remote/b" } }, agents: { two: "b2" } };
		expect(await sync.syncOnce()).toBe("updated");
		expect(fs.readdirSync(agentsDir)).toEqual(["two.md"]);

		bundle = { settings: {}, agents: { "../escape": "x" } };
		expect(await sync.syncOnce()).toBe("failed");
		expect(fs.readdirSync(agentsDir)).toEqual(["two.md"]);
		expect(activeSettings.getModelRoles().task).toBe("remote/b");
	});

	it("ignores the mirror unless the global config opts in", async () => {
		const remoteDir = path.join(agentDir, "remote");
		fs.mkdirSync(remoteDir, { recursive: true });
		fs.writeFileSync(path.join(remoteDir, "config.yml"), "modelRoles:\n  task: remote/task\n");
		writeLocalConfig("remoteConfig:\n  enabled: false\n");
		activeSettings = await Settings.loadIsolated({ cwd, agentDir });

		expect(activeSettings.getModelRoles().task).not.toBe("remote/task");
		expect(await new RemoteConfigSync(activeSettings).syncOnce()).toBe("disabled");
		expect(requests).toHaveLength(0);
	});
});
