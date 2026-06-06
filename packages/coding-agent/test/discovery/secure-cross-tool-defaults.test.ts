import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Hook, hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

describe("secure cross-tool discovery defaults", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secure-cross-tool-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fs.rm(root, { recursive: true, force: true });
	});

	async function writeClaudeHooks(): Promise<{ userHook: string; projectHook: string }> {
		const userHook = path.join(home, ".claude", "hooks", "pre", "user-session-start.ts");
		const projectHook = path.join(project, ".claude", "hooks", "pre", "project-session-start.ts");
		await writeFile(userHook, "export default function(pi) { pi.on('session_start', () => {}); }\n");
		await writeFile(projectHook, "export default function(pi) { pi.on('session_start', () => {}); }\n");
		return { userHook, projectHook };
	}

	async function loadClaudeHooks(): Promise<Hook[]> {
		const result = await loadCapability<Hook>(hookCapability.id, { cwd: project, providers: ["claude"] });
		return result.items;
	}

	async function writeCursorRules(): Promise<{ userRule: string; projectRule: string }> {
		const userRule = path.join(home, ".cursor", "rules", "global.mdc");
		const projectRule = path.join(project, ".cursor", "rules", "project.mdc");
		await writeFile(userRule, "---\nalwaysApply: true\n---\nUser Cursor rule\n");
		await writeFile(projectRule, "---\nalwaysApply: true\n---\nProject Cursor rule\n");
		return { userRule, projectRule };
	}

	async function loadCursorRules(): Promise<Rule[]> {
		const result = await loadCapability<Rule>(ruleCapability.id, { cwd: project, providers: ["cursor"] });
		return result.items;
	}

	test("does not discover executable Claude hooks unless explicitly enabled", async () => {
		await writeClaudeHooks();
		await Settings.init({ inMemory: true, cwd: project });

		expect(Settings.instance.get("hooks.enableClaudeProject")).toBe(false);

		expect(await loadClaudeHooks()).toEqual([]);
	});

	test("does not let project Claude settings self-enable executable hooks", async () => {
		await writeClaudeHooks();
		await writeFile(
			path.join(project, ".claude", "settings.json"),
			JSON.stringify({ hooks: { enableClaudeProject: true } }),
		);
		await Settings.init({ inMemory: true, cwd: project });
		expect(Settings.instance.get("hooks.enableClaudeProject")).toBe(true);
		expect(Settings.instance.getTrusted("hooks.enableClaudeProject")).toBe(false);
		expect(await loadClaudeHooks()).toEqual([]);
	});

	test("discovers only user Claude hooks after trusted user-scope opt-in", async () => {
		const { userHook } = await writeClaudeHooks();
		await Settings.init({ inMemory: true, overrides: { "hooks.enableClaudeUser": true } });

		const hooks = await loadClaudeHooks();

		expect(hooks).toHaveLength(1);
		expect(hooks[0]?.path).toBe(userHook);
		expect(hooks[0]?.level).toBe("user");
		expect(hooks[0]?.type).toBe("pre");
	});

	test("discovers only project Claude hooks after trusted project-scope opt-in", async () => {
		const { projectHook } = await writeClaudeHooks();
		await Settings.init({ inMemory: true, overrides: { "hooks.enableClaudeProject": true } });

		const hooks = await loadClaudeHooks();

		expect(hooks).toHaveLength(1);
		expect(hooks[0]?.path).toBe(projectHook);
		expect(hooks[0]?.level).toBe("project");
		expect(hooks[0]?.type).toBe("pre");
	});

	test("does not discover Cursor rules for prompt injection unless explicitly enabled", async () => {
		await writeCursorRules();
		await Settings.init({ inMemory: true, cwd: project });

		expect(Settings.instance.get("rules.enableCursorProject")).toBe(false);

		expect(await loadCursorRules()).toEqual([]);
	});

	test("does not let project Cursor settings self-enable rule prompt injection", async () => {
		await writeCursorRules();
		await writeFile(
			path.join(project, ".cursor", "settings.json"),
			JSON.stringify({ rules: { enableCursorProject: true } }),
		);
		await Settings.init({ inMemory: true, cwd: project });
		expect(Settings.instance.get("rules.enableCursorProject")).toBe(true);
		expect(Settings.instance.getTrusted("rules.enableCursorProject")).toBe(false);
		expect(await loadCursorRules()).toEqual([]);
	});

	test("discovers only user Cursor rules after trusted user-scope opt-in", async () => {
		const { userRule } = await writeCursorRules();
		await Settings.init({ inMemory: true, overrides: { "rules.enableCursorUser": true } });

		const rules = await loadCursorRules();

		expect(rules).toHaveLength(1);
		expect(rules[0]?.path).toBe(userRule);
		expect(rules[0]?._source.level).toBe("user");
		expect(rules[0]?.content).toBe("User Cursor rule");
		expect(rules[0]?.alwaysApply).toBe(true);
	});

	test("discovers only project Cursor rules after trusted project-scope opt-in", async () => {
		const { projectRule } = await writeCursorRules();
		await Settings.init({ inMemory: true, overrides: { "rules.enableCursorProject": true } });

		const rules = await loadCursorRules();

		expect(rules).toHaveLength(1);
		expect(rules[0]?.path).toBe(projectRule);
		expect(rules[0]?._source.level).toBe("project");
		expect(rules[0]?.content).toBe("Project Cursor rule");
		expect(rules[0]?.alwaysApply).toBe(true);
	});
});
