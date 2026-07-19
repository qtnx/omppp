import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type ConfigCommandArgs, parseConfigArgs, runConfigCommand } from "@oh-my-pi/pi-coding-agent/cli/config-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

let testAgentDir: TempDir | undefined;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

const getConfigPath = () => path.join(testAgentDir?.path() ?? fallbackAgentDir, "config.yml");

const writeSettings = async (settings: Record<string, unknown>) => {
	await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
};

const readSettings = async (): Promise<Record<string, unknown>> => {
	const content = await Bun.file(getConfigPath()).text();
	const parsed = YAML.parse(content);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	return parsed as Record<string, unknown>;
};

beforeEach(() => {
	resetSettingsForTest();
	testAgentDir = TempDir.createSync("@omp-config-cli-");
	setAgentDir(testAgentDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentStorage.resetInstance();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (testAgentDir) {
		try {
			await testAgentDir.remove();
		} catch {}
		testAgentDir = undefined;
	}
});

describe("config CLI schema coverage", () => {
	it("renders record settings as JSON and with record type in text output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "list", flags: {} });

		const lines = logSpy.mock.calls.map(call => String(call[0] ?? ""));
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const modelRolesLine = plainLines.find(line => line.includes("modelRoles ="));
		expect(modelRolesLine).toBeDefined();
		const plainModelRolesLine = String(modelRolesLine);
		expect(plainModelRolesLine).toContain("modelRoles =");
		expect(plainModelRolesLine).toContain("(record)");
		expect(plainModelRolesLine).toContain("{");
		expect(plainModelRolesLine).toContain("}");
		expect(plainModelRolesLine).not.toContain("[object Object]");
	});

	it("sets and gets record settings as JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const recordValue = '{"default":"claude-opus-4-6"}';

		await runConfigCommand({ action: "set", key: "modelRoles", value: recordValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "modelRoles", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("modelRoles");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ default: "claude-opus-4-6" });
	});

	it("normalizes valid provider in-flight request limits from JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({
			action: "set",
			key: "providers.maxInFlightRequests",
			value: '{"openai":2.8,"anthropic":1}',
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "providers.maxInFlightRequests", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("providers.maxInFlightRequests");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ openai: 2, anthropic: 1 });
	});

	it("rejects invalid provider in-flight request limit entries", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);

		await expect(
			runConfigCommand({
				action: "set",
				key: "providers.maxInFlightRequests",
				value: '{"openai":"2","anthropic":0}',
				flags: { json: true },
			}),
		).rejects.toThrow("process.exit");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Provider request limits must be positive numbers: openai, anthropic"),
		);
	});

	it("sets and gets array settings as JSON arrays", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const arrayValue = '["claude-opus-4-6","gpt-5.3-codex"]';

		await runConfigCommand({ action: "set", key: "enabledModels", value: arrayValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.value).toEqual(["claude-opus-4-6", "gpt-5.3-codex"]);
	});
	it("sets numeric idle compaction settings from CLI values", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleThresholdTokens",
			value: "300000",
			flags: { json: true },
		});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleTimeoutSeconds",
			value: "600",
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "compaction.idleThresholdTokens", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "compaction.idleTimeoutSeconds", flags: { json: true } });

		const thresholdPayload = logSpy.mock.calls.at(-2)?.[0];
		const timeoutPayload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof thresholdPayload).toBe("string");
		expect(typeof timeoutPayload).toBe("string");
		expect(JSON.parse(String(thresholdPayload))).toMatchObject({
			key: "compaction.idleThresholdTokens",
			type: "number",
			value: 300000,
		});
		expect(JSON.parse(String(timeoutPayload))).toMatchObject({
			key: "compaction.idleTimeoutSeconds",
			type: "number",
			value: 600,
		});
	});

	it("accepts max as a persisted default thinking level", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "set", key: "defaultThinkingLevel", value: "max", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "defaultThinkingLevel", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("defaultThinkingLevel");
		expect(parsed.type).toBe("enum");
		expect(parsed.value).toBe("max");
	});
	it("fully flushes JSON larger than a pipe buffer", async () => {
		if (!testAgentDir) throw new Error("Test agent directory was not initialized");
		const proc = Bun.spawn([process.execPath, cliEntry, "config", "list", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: testAgentDir.path(),
			},
		});
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);

		expect(exitCode).toBe(0);
		expect(error).toBe("");
		expect(Buffer.byteLength(output)).toBeGreaterThan(65_536);
		const parsed: unknown = JSON.parse(output);
		expect(parsed).toMatchObject({ modelRoles: { type: "record" } });
	});
});

describe("config update", () => {
	it("persists setupVersion 4 diff-only migration values and preserves explicit custom values", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await writeSettings({
			setupVersion: 0,
			modelRoles: {
				default: "custom/default",
			},
			task: {
				agentModelOverrides: {
					qa: "custom/qa",
				},
			},
			memory: {
				backend: "local",
			},
			theme: {
				dark: "custom-dark",
			},
			retry: {
				fallbackChains: {
					task: ["custom/task-primary", "custom/task-secondary"],
				},
			},
		});

		await runConfigCommand({ action: "update" as ConfigCommandArgs["action"], flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		expect(JSON.parse(String(payload))).toMatchObject({
			changed: true,
			setupVersion: 4,
			currentVersion: 4,
		});

		const onDisk = await readSettings();
		expect(onDisk.setupVersion).toBe(4);
		expect(onDisk.modelRoles).toEqual({
			default: "custom/default",
			task: "openai-codex/gpt-5.6-terra:medium",
			smol: "cerebras/gpt-oss-120b",
			slow: "openai-codex/gpt-5.6-sol:high",
			plan: "openai-codex/gpt-5.6-sol:xhigh",
			designer: "tnx/designer",
			commit: "openai-codex/gpt-5.6-luna:high",
		});
		expect((onDisk.task as Record<string, unknown>).agentModelOverrides).toEqual({
			designer: "tnx/designer",
			explore: "pi/smol",
			frontend_ui: "tnx/designer",
			heavy_task: "openai-codex/gpt-5.6-sol:high",
			oracle: "openai-codex/gpt-5.6-sol:high",
			plan: "anthropic/claude-fable-5:high",
			qa: "custom/qa",
			tester: "openai-codex/gpt-5.6-sol:medium",
			quick_task: "openai-codex/gpt-5.6-luna:high",
			reviewer: "openai-codex/gpt-5.6-sol:high",
			task: "openai-codex/gpt-5.6-terra:medium",
		});
		expect(onDisk.memory).toEqual({ backend: "local" });
		expect(onDisk.theme).toEqual({ dark: "custom-dark" });
		expect(onDisk.retry).toEqual({
			fallbackChains: {
				task: ["custom/task-primary", "custom/task-secondary"],
				smol: ["openai-codex/gpt-5.3-codex-spark", "anthropic/claude-haiku-4-5"],
				plan: ["anthropic/claude-fable-5:high", "anthropic/claude-opus-4-8:max", "openai-codex/gpt-5.5:xhigh"],
			},
		});
		expect(onDisk.workflow).toBeUndefined();
		expect(onDisk.hindsight).toBeUndefined();
		expect(onDisk.hideThinkingBlock).toBeUndefined();
		expect(onDisk.symbolPreset).toBeUndefined();
		expect((onDisk.task as Record<string, unknown>).showResolvedModelBadge).toBeUndefined();
	});

	it("updates an existing empty config file", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await Bun.write(path.join(testAgentDir!.path(), "config.yml"), "");

		await runConfigCommand({ action: "update", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		expect(JSON.parse(String(payload))).toMatchObject({
			changed: true,
			setupVersion: 4,
			currentVersion: 4,
		});
		expect((await readSettings()).setupVersion).toBe(4);
	});

	it("reports unchanged JSON and leaves config stable on a second run", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await writeSettings({
			setupVersion: 0,
			modelRoles: {
				default: "custom/default",
			},
		});

		await runConfigCommand({ action: "update" as ConfigCommandArgs["action"], flags: { json: true } });
		const firstMigration = await readSettings();
		await runConfigCommand({ action: "update" as ConfigCommandArgs["action"], flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		expect(JSON.parse(String(payload))).toMatchObject({
			changed: false,
			setupVersion: 4,
			currentVersion: 4,
		});
		expect(await readSettings()).toEqual(firstMigration);
	});

	it("updates setupVersion 3 routes once and reports the migrated public paths", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await writeSettings({
			setupVersion: 3,
			modelRoles: {
				default: "openai-codex/gpt-5.5:xhigh",
				smol: "tnx/smol",
				designer: "tnx/designer:medium",
				custom_role: "custom/role-model",
			},
			task: {
				agentModelOverrides: {
					quick_task: "openai-codex/gpt-5.5:low",
					qa: "openai-codex/gpt-5.5:high",
					custom_agent: "custom/agent-model",
				},
			},
		});

		await runConfigCommand({ action: "update", flags: { json: true } });

		const firstPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(firstPayload).toEqual({
			changed: true,
			setupVersion: 4,
			currentVersion: 4,
			changedPaths: [
				"dev.autoqaConsent",
				"display.syntaxHighlighting",
				"learning.classifierModels",
				"learning.enabled",
				"memory.backend",
				"modelRoles",
				"providers.webSearch",
				"retry.fallbackChains",
				"setupVersion",
				"task.agentModelOverrides",
			],
		});
		const firstMigration = await readSettings();
		expect(firstMigration.setupVersion).toBe(4);
		expect(firstMigration.modelRoles).toEqual({
			default: "openai-codex/gpt-5.6-sol:xhigh",
			task: "openai-codex/gpt-5.6-terra:medium",
			smol: "cerebras/gpt-oss-120b",
			slow: "openai-codex/gpt-5.6-sol:high",
			plan: "openai-codex/gpt-5.6-sol:xhigh",
			designer: "tnx/designer",
			commit: "openai-codex/gpt-5.6-luna:high",
			custom_role: "custom/role-model",
		});
		expect((firstMigration.task as Record<string, unknown>).agentModelOverrides).toEqual({
			designer: "tnx/designer",
			explore: "pi/smol",
			frontend_ui: "tnx/designer",
			heavy_task: "openai-codex/gpt-5.6-sol:high",
			oracle: "openai-codex/gpt-5.6-sol:high",
			plan: "anthropic/claude-fable-5:high",
			qa: "openai-codex/gpt-5.6-sol:high",
			tester: "openai-codex/gpt-5.6-sol:medium",
			quick_task: "openai-codex/gpt-5.6-luna:high",
			reviewer: "openai-codex/gpt-5.6-sol:high",
			task: "openai-codex/gpt-5.6-terra:medium",
			custom_agent: "custom/agent-model",
		});

		await runConfigCommand({ action: "update", flags: { json: true } });

		const secondPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(secondPayload).toEqual({
			changed: false,
			setupVersion: 4,
			currentVersion: 4,
			changedPaths: [],
		});
		expect(await readSettings()).toEqual(firstMigration);
	});

	it("parses update as a config action without requiring a key or value", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);

		let parsed: ConfigCommandArgs | undefined;
		expect(() => {
			parsed = parseConfigArgs(["config", "update", "--json"]);
		}).not.toThrow();
		expect(parsed).toEqual({
			action: "update",
			flags: { json: true },
		});
	});
});
