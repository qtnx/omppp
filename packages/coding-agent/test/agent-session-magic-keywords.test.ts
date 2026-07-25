import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

const mockTaskTool: AgentTool = {
	name: "task",
	label: "Task",
	description: "Mock task tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

const mockWorkflowTool: AgentTool = {
	name: "workflow",
	label: "Workflow",
	description: "Mock workflow tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

async function createMagicKeywordSession(
	root: string,
	tools: AgentTool[] = [mockTaskTool, mockWorkflowTool],
): Promise<{
	session: AgentSession;
	settings: Settings;
	authStorage: AuthStorage;
}> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Claude Sonnet model");
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
			thinkingLevel: Effort.High,
		},
	});
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const settings = Settings.isolated();
	settings.set("task.eager", "default");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
	});
	return { session, settings, authStorage };
}

describe("AgentSession magic keyword settings", () => {
	let root: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-magic-keywords-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		await removeWithRetries(root).catch(() => undefined);
		session = undefined;
		authStorage = undefined;
	});

	function customTypesFromPrompt(promptSpy: { mock: { calls: unknown[][] } }): string[] {
		const promptMessages = promptSpy.mock.calls[0]![0] as Array<{ customType?: string }>;
		return promptMessages
			.map(message => message.customType)
			.filter(type => type === "ultrathink-notice" || type === "orchestrate-notice" || type === "workflow-notice");
	}

	it("does not append magic keyword notices when disabled", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.enabled", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflow this and ultrathink through it");

		expect(customTypesFromPrompt(promptSpy)).toEqual([]);
	});

	it("honors non-ultrathink per-keyword notice toggles", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.orchestrate", false);
		created.settings.set("magicKeywords.workflow", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflow this");

		expect(customTypesFromPrompt(promptSpy)).toEqual([]);
	});

	it("still appends enabled non-ultrathink notices", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflow this");

		expect(customTypesFromPrompt(promptSpy)).toEqual(["workflow-notice"]);
	});

	it("renders the workflow tool notice", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("task.batch", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflow this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ content?: string; customType?: string }>;
		const notice = promptMessages.find(message => message.customType === "workflow-notice")?.content ?? "";
		expect(notice).toContain("call the `workflow` tool");
		expect(notice).toContain("Scout inline first");
		expect(notice).toContain("NEVER use Python `eval`");
	});

	it("skips workflow notice when the workflow tool is inactive", async () => {
		const created = await createMagicKeywordSession(root, [mockTaskTool]);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflow this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("does not use a disabled ultrathink keyword to force auto thinking", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.ultrathink", false);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		session.setThinkingLevel(AUTO_THINKING);

		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
	});

	it("queues the magic-keyword notice before the user message", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("ultrathink do the thing");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ role?: string; customType?: string }>;
		const noticeIdx = promptMessages.findIndex(m => m.customType === "ultrathink-notice");
		const userIdx = promptMessages.findIndex(m => m.role === "user");
		expect(noticeIdx).toBeGreaterThanOrEqual(0);
		expect(userIdx).toBeGreaterThanOrEqual(0);
		expect(noticeIdx).toBeLessThan(userIdx);
	});

	it("auto-enters orchestrator mode without injecting orchestrate notice", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate these independent changes");

		expect(session.getOrchestratorModeState()?.enabled).toBe(true);
		expect(customTypesFromPrompt(promptSpy)).not.toContain("orchestrate-notice");
	});

	it("keeps plan mode active and injects orchestrate notice without throwing", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.setPlanModeState({ enabled: true, planFilePath: path.join(root, "PLAN.md") });
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await expect(session.prompt("please orchestrate the plan work")).resolves.toBe(true);

		expect(session.getOrchestratorModeState()?.enabled).toBeUndefined();
		expect(customTypesFromPrompt(promptSpy)).toContain("orchestrate-notice");
	});

	it("keeps a paused goal and injects orchestrate notice without switching", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		const goal = {
			id: "goal-1",
			objective: "finish the migration",
			status: "paused" as const,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		session.setGoalModeState({ enabled: false, mode: "active", goal });
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await expect(session.prompt("please orchestrate the remaining goal work")).resolves.toBe(true);

		expect(session.getOrchestratorModeState()?.enabled).not.toBe(true);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		expect(customTypesFromPrompt(promptSpy)).toContain("orchestrate-notice");
	});

	it("keeps paused plan session context from auto-entering orchestrator mode", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		session.sessionManager.appendModeChange("plan_paused");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate the paused plan work");

		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.sessionManager.buildSessionContext().mode).toBe("plan_paused");
		expect(session.getOrchestratorModeState()?.enabled).not.toBe(true);
		expect(customTypesFromPrompt(promptSpy)).toContain("orchestrate-notice");
	});

	it("does not auto-enter or inject notice when orchestrate magic keyword is disabled", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.orchestrate", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate these independent changes");

		expect(session.getOrchestratorModeState()?.enabled).toBeUndefined();
		expect(customTypesFromPrompt(promptSpy)).not.toContain("orchestrate-notice");
	});
});
