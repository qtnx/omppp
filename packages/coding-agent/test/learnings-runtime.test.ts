import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildLearningDeveloperInstructions,
	clearLearningData,
	startLearningStartupTask,
} from "@oh-my-pi/pi-coding-agent/learnings";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Snowflake } from "@oh-my-pi/pi-utils";

interface LearningFixture {
	agentDir: string;
	cwd: string;
	settings: Settings;
	session: AgentSession;
	modelRegistry: ModelRegistry;
	emit(event: AgentSessionEvent): void;
	refreshBaseSystemPrompt: ReturnType<typeof vi.fn>;
}

const createdDirs = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
	const dir = path.join(os.tmpdir(), `${prefix}-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
	createdDirs.add(dir);
	return dir;
}

function createModel(id: string): Model {
	return {
		provider: "openai",
		id,
		name: id,
		contextWindow: 32_000,
	} as Model;
}

async function createFixture(overrides?: Partial<Record<string, unknown>>): Promise<LearningFixture> {
	const agentDir = await makeTempDir("learnings-runtime-agent");
	const cwd = await makeTempDir("learnings-runtime-repo");
	const smolModel = createModel("smol-model");
	const planModel = createModel("plan-model");
	const models = [smolModel, planModel];
	const settings = Settings.isolated({
		"learning.enabled": true,
		modelRoles: {
			smol: "openai/smol-model",
			plan: "openai/plan-model",
		},
		...(overrides ?? {}),
	});
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const refreshBaseSystemPrompt = vi.fn(async () => undefined);
	const session = {
		sessionId: "session-1",
		sessionManager: {
			getCwd: () => cwd,
			getSessionFile: () => path.join(agentDir, "sessions", "session-1.jsonl"),
		},
		settings,
		model: planModel,
		agent: {
			metadataForProvider: () => undefined,
		},
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		refreshBaseSystemPrompt,
	} as unknown as AgentSession;
	const modelRegistry = {
		getAvailable: vi.fn(() => models),
		getAll: vi.fn(() => models),
		find: vi.fn((provider: string, id: string) =>
			models.find(model => model.provider === provider && model.id === id),
		),
		getApiKey: vi.fn(async () => "test-api-key"),
	} as unknown as ModelRegistry;
	return {
		agentDir,
		cwd,
		settings,
		session,
		modelRegistry,
		emit(event: AgentSessionEvent) {
			for (const listener of [...listeners]) listener(event);
		},
		refreshBaseSystemPrompt,
	};
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	let lastError: unknown;
	while (Date.now() - start < timeoutMs) {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
			await Bun.sleep(25);
		}
	}
	throw lastError;
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai",
		provider: "openai",
		model: "plan-model",
		content: [{ type: "text", text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolUseMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "openai",
		provider: "openai",
		model: "plan-model",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("live learnings runtime", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of createdDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		createdDirs.clear();
	});

	test("stores a repo-scoped guideline from the latest user message only", async () => {
		const fx = await createFixture();
		const completeSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(
				toolUseMessage([
					{
						type: "toolCall",
						id: "decision-1",
						name: "record_learning_decision",
						arguments: {
							store: true,
							scope: "repo",
							trigger: "complaint",
							confidence: 0.92,
							reason: "User corrected a project workflow expectation.",
						},
					},
				]),
			)
			.mockResolvedValueOnce(
				toolUseMessage([
					{
						type: "toolCall",
						id: "learning-1",
						name: "record_learning",
						arguments: {
							content:
								"When the user complains about missing verification, run a fresh real verification before claiming progress.",
						},
					},
				]),
			);

		startLearningStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		fx.emit({
			type: "agent_end",
			messages: [
				{
					role: "user",
					content:
						"Bạn sai rồi. Lần sau khi tôi complain về verification thì phải chạy verification thật trước khi claim.",
					attribution: "user",
					timestamp: Date.now(),
				},
				assistantText("assistant text must not be sent to the learning classifier"),
			],
		});

		await waitFor(async () => {
			const payload = await buildLearningDeveloperInstructions(fx.agentDir, fx.settings);
			expect(payload).toContain("When the user complains about missing verification");
			expect(payload).toContain("Repository-specific learnings");
		});

		expect(completeSpy).toHaveBeenCalledTimes(2);
		expect(completeSpy.mock.calls[0]?.[0].id).toBe("smol-model");
		expect(completeSpy.mock.calls[1]?.[0].id).toBe("plan-model");
		const classifierMessage = completeSpy.mock.calls[0]?.[1].messages[0]?.content;
		expect(String(classifierMessage)).not.toContain("assistant text must not be sent");
		expect(fx.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
	});

	test("skips ordinary user messages and does not call the writer model", async () => {
		const fx = await createFixture();
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			toolUseMessage([
				{
					type: "toolCall",
					id: "decision-1",
					name: "record_learning_decision",
					arguments: {
						store: false,
						scope: "repo",
						trigger: "none",
						confidence: 0.98,
						reason: "Ordinary task request without durable guideline.",
					},
				},
			]),
		);

		startLearningStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		fx.emit({
			type: "agent_end",
			messages: [
				{
					role: "user",
					content: "Add a button to the settings screen.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(() => {
			expect(completeSpy).toHaveBeenCalledTimes(1);
		});
		expect(await buildLearningDeveloperInstructions(fx.agentDir, fx.settings)).toBeUndefined();
		expect(fx.refreshBaseSystemPrompt).not.toHaveBeenCalled();
	});

	test("keeps global learnings separate from repo learnings", async () => {
		const fx = await createFixture();
		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(
				toolUseMessage([
					{
						type: "toolCall",
						id: "decision-1",
						name: "record_learning_decision",
						arguments: {
							store: true,
							scope: "global",
							trigger: "guideline",
							confidence: 0.95,
							reason: "User gave a global communication preference.",
						},
					},
				]),
			)
			.mockResolvedValueOnce(
				toolUseMessage([
					{
						type: "toolCall",
						id: "learning-1",
						name: "record_learning",
						arguments: {
							content: "Keep responses concise when the user asks for direct execution.",
						},
					},
				]),
			);

		startLearningStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});
		fx.emit({
			type: "agent_end",
			messages: [
				{
					role: "user",
					content: "Luôn trả lời ngắn gọn khi tôi yêu cầu execute trực tiếp.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(async () => {
			const payload = await buildLearningDeveloperInstructions(fx.agentDir, fx.settings);
			expect(payload).toContain("Global learnings");
			expect(payload).toContain("Keep responses concise");
		});

		await clearLearningData(fx.agentDir, fx.cwd, "repo");
		expect(await buildLearningDeveloperInstructions(fx.agentDir, fx.settings)).toContain("Keep responses concise");
		await clearLearningData(fx.agentDir, fx.cwd, "global");
		expect(await buildLearningDeveloperInstructions(fx.agentDir, fx.settings)).toBeUndefined();
	});
});
