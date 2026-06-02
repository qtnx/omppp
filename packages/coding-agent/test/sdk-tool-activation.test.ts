import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import contextGcExtension from "@oh-my-pi/context-gc-plugin";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CreateAgentSessionResult,
	createAgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";

const toolActivationExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "default_inactive_tool",
		label: "Default Inactive Tool",
		description: "Tool hidden from the initial active set unless explicitly requested.",
		parameters: z.object({}),
		defaultInactive: true,
		async execute() {
			return { content: [{ type: "text", text: "inactive" }] };
		},
	});
	pi.registerTool({
		name: "default_active_tool",
		label: "Default Active Tool",
		description: "Tool included in the initial active set.",
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text", text: "active" }] };
		},
	});
};

describe("createAgentSession defaultInactive tool activation", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}

		vi.restoreAllMocks();
	});

	it("excludes defaultInactive extension tools from the initial active set unless explicitly requested", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [toolActivationExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["default_active_tool", "default_inactive_tool"]),
			);
			expect(session.getActiveToolNames()).toContain("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_inactive_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_active_tool");
			expect(session.systemPrompt.join("\n")).not.toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("loads context GC tools as native bundled extensions without plugin discovery", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-context-gc-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		const previousContextGcDbPath = process.env.OMP_CONTEXT_GC_DB_PATH;

		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			const contextGcToolNames = [
				"context_debug",
				"context_global_stats",
				"context_inventory",
				"context_pin",
				"context_recall",
				"context_stats",
				"context_tree",
				"context_unload",
			];
			expect(result.session.getAllToolNames()).toEqual(expect.arrayContaining(contextGcToolNames));
			expect(result.session.getActiveToolNames()).toEqual(expect.arrayContaining(contextGcToolNames));
			expect(result.extensionsResult.extensions.filter(extension => extension.label === "Context GC")).toHaveLength(
				1,
			);
			expect(fs.existsSync(path.join(tempDir, "context-gc.sqlite"))).toBe(true);
			expect(process.env.OMP_CONTEXT_GC_DB_PATH).toBe(previousContextGcDbPath);
		} finally {
			await result?.session.dispose();
		}
	});

	it("does not double-load native context GC when supplied inline", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-context-gc-inline-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				extensions: [pi => contextGcExtension(pi)],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			expect(result.extensionsResult.extensions.filter(extension => extension.label === "Context GC")).toHaveLength(
				1,
			);
			expect(fs.existsSync(path.join(tempDir, "context-gc.sqlite"))).toBe(true);
		} finally {
			await result?.session.dispose();
		}
	});

	it("applies agentDir DB override before loading configured context GC extensions", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-context-gc-configured-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const configuredContextGcPath = path.resolve(import.meta.dir, "../../context-gc-plugin/src/extension.ts");
		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [configuredContextGcPath],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			expect(result.extensionsResult.extensions.filter(extension => extension.label === "Context GC")).toHaveLength(
				1,
			);
			expect(fs.existsSync(path.join(tempDir, "context-gc.sqlite"))).toBe(true);
		} finally {
			await result?.session.dispose();
		}
	});

	it("keeps context GC DB paths isolated across concurrent session creation", async () => {
		const root = path.join(os.tmpdir(), `pi-sdk-context-gc-concurrent-${Snowflake.next()}`);
		const agentDirA = path.join(root, "agent-a");
		const agentDirB = path.join(root, "agent-b");
		const cwdA = path.join(root, "cwd-a");
		const cwdB = path.join(root, "cwd-b");
		tempDirs.push(root);
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		const configuredContextGcPath = path.resolve(import.meta.dir, "../../context-gc-plugin/src/extension.ts");
		const previousContextGcDbPath = process.env.OMP_CONTEXT_GC_DB_PATH;

		const create = async (cwd: string, agentDir: string): Promise<CreateAgentSessionResult> =>
			await createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [configuredContextGcPath],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

		let resultA: CreateAgentSessionResult | undefined;
		let resultB: CreateAgentSessionResult | undefined;
		try {
			[resultA, resultB] = await Promise.all([create(cwdA, agentDirA), create(cwdB, agentDirB)]);

			expect(fs.existsSync(path.join(agentDirA, "context-gc.sqlite"))).toBe(true);
			expect(fs.existsSync(path.join(agentDirB, "context-gc.sqlite"))).toBe(true);
			expect(process.env.OMP_CONTEXT_GC_DB_PATH).toBe(previousContextGcDbPath);
		} finally {
			await resultA?.session.dispose();
			await resultB?.session.dispose();
		}
	});

	it("keeps sessions usable when native context GC storage cannot open", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-context-gc-bad-db-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(path.join(tempDir, "context-gc.sqlite"), { recursive: true });

		let result: CreateAgentSessionResult | undefined;
		try {
			result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			expect(result.session.getToolByName("read")).toBeDefined();
			expect(result.session.getToolByName("context_inventory")).toBeUndefined();
		} finally {
			await result?.session.dispose();
		}
	});

	it("allows explicitly requested defaultInactive extension tools into the initial active set", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [toolActivationExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "default_inactive_tool"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "default_active_tool", "default_inactive_tool"]),
			);
			expect(session.systemPrompt.join("\n")).toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("activates the yield tool when requireYieldTool is set and toolNames is explicit", async () => {
		// Regression for #1408: plan-mode subagents pass an explicit `toolNames` list
		// (e.g. `["read", "search", "find", "lsp", "web_search"]`). Without this
		// invariant, `yield` ended up registered but not active, and the model
		// could not satisfy the idle-reminder contract that demands a `yield` call.
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			requireYieldTool: true,
			toolNames: ["read", "search", "find", "web_search"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("yield");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the hidden resolve tool registered for plan mode even when no deferrable tool is requested", async () => {
		// Regression for #1428: plan mode submits its finalized plan via
		// `resolve { action: "apply" }` dispatched through a standing handler
		// (interactive-mode.ts: `setStandingResolveHandler`). With an explicit
		// read-only `toolNames` (e.g. `read`, `search`, `find`, `web_search`)
		// the registry has no `deferrable` tool, so the previous gate dropped
		// `resolve` from the registry and plan mode silently activated without
		// it — leaving the agent stuck after drafting the plan.
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search", "find", "web_search"],
		});

		try {
			expect(session.getToolByName("resolve")).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("drops the hidden resolve tool when neither a deferrable tool nor plan mode can use it", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const settings = Settings.isolated();
		settings.set("plan.enabled", false);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search", "find", "web_search"],
		});

		try {
			expect(session.getToolByName("resolve")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not register the xAI TTS tool unless enabled", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(session.getToolByName("tts")).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("registers the xAI TTS tool when enabled", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tts.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(session.getToolByName("tts")).toBeDefined();
			expect(session.getActiveToolNames()).toContain("tts");
		} finally {
			await session.dispose();
		}
	});
});
