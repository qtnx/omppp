import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "bun:test";
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
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";

interface LearningFixture {
	agentDir: string;
	cwd: string;
	settings: Settings;
	session: AgentSession;
	modelRegistry: ModelRegistry;
	emit(event: AgentSessionEvent): void;
	refreshBaseSystemPrompt: Mock<() => Promise<void>>;
}

const createdDirs = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
	const dir = path.join(os.tmpdir(), `${prefix}-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
	createdDirs.add(dir);
	return dir;
}

function createModel(id: string, provider = "openai"): Model {
	return {
		provider,
		id,
		name: id,
		contextWindow: 32_000,
	} as Model;
}

async function createFixture(overrides?: Partial<Record<string, unknown>>): Promise<LearningFixture> {
	const agentDir = await makeTempDir("learnings-runtime-agent");
	const cwd = await makeTempDir("learnings-runtime-repo");
	const smolModel = createModel("smol-model");
	const nanoModel = createModel("gpt-5.4-nano", "openai-codex");
	const planModel = createModel("plan-model");
	const models = [smolModel, nanoModel, planModel];
	const settings = Settings.isolated({
		"learning.enabled": true,
		modelRoles: {
			smol: "openai/smol-model",
			plan: "openai/plan-model",
		},
		...(overrides ?? {}),
	});
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const refreshBaseSystemPrompt: Mock<() => Promise<void>> = vi.fn(async () => undefined);
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

function agentWriterResult(content: string): SingleResult {
	return {
		index: 0,
		id: "learning-writer",
		agent: "learning-writer",
		agentSource: "bundled",
		task: "learning writer",
		exitCode: 0,
		output: JSON.stringify({ action: "store", content, source: "latest_user_message", evidence: "user message" }),
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
	};
}

function agentWriterSkipResult(reason: string): SingleResult {
	return {
		index: 0,
		id: "learning-writer",
		agent: "learning-writer",
		agentSource: "bundled",
		task: "learning writer",
		exitCode: 0,
		output: JSON.stringify({ action: "skip", reason }),
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
	};
}

function agentWriterAbortResult(): SingleResult {
	return {
		index: 0,
		id: "learning-writer",
		agent: "learning-writer",
		agentSource: "bundled",
		task: "learning writer",
		exitCode: 1,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 15_000,
		tokens: 0,
		aborted: true,
		abortReason: "The operation was aborted due to timeout",
		resolvedModel: "anthropic/claude-opus-4-8:high",
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
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
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
		);
		const writerSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValueOnce(
				agentWriterResult(
					"When the user complains about missing verification, run a fresh real verification before claiming progress.",
				),
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
			const payload = await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd);
			expect(payload).toContain("When the user complains about missing verification");
			expect(payload).toContain("Repository-specific learnings");
		});

		expect(completeSpy).toHaveBeenCalledTimes(1);
		expect(completeSpy.mock.calls[0]?.[0].id).toBe("smol-model");
		expect(writerSpy).toHaveBeenCalledTimes(1);
		const writerOptions = writerSpy.mock.calls[0]?.[0];
		expect(writerOptions?.agent.name).toBe("learning-writer");
		expect(writerOptions?.agent.tools).toEqual(["read"]);
		expect(writerOptions?.contextFile).toBe(path.join(fx.agentDir, "sessions", "session-1.jsonl"));
		expect(writerOptions?.task).toContain("Preserve only facts that are explicitly present in the user message.");
		expect(writerOptions?.task).toContain("Do not add details, causes, scope, or examples the user did not state.");
		expect(writerOptions?.task).toContain("When the user blames, claims, or is upset about agent behavior");
		expect(writerOptions?.task).toContain(
			"write the entry as a clear lesson so the agent does not repeat that behavior",
		);
		const classifierMessage = completeSpy.mock.calls[0]?.[1].messages[0]?.content;
		expect(String(classifierMessage)).not.toContain("assistant text must not be sent");
		expect(completeSpy.mock.calls[0]?.[1].systemPrompt?.[0]).toContain(
			"You classify one latest user-authored message",
		);
		expect(completeSpy.mock.calls[0]?.[1].systemPrompt?.[0]).toContain(
			"Treat blame, claims, and upset messages about agent behavior as store-worthy complaints",
		);
		expect(fx.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(debugSpy).toHaveBeenCalledWith(
			"live-learning: attached",
			expect.objectContaining({ cwd: fx.cwd, sessionId: "session-1" }),
		);
		expect(debugSpy).toHaveBeenCalledWith(
			"live-learning: stored",
			expect.objectContaining({ cwd: fx.cwd, scope: "repo", trigger: "complaint" }),
		);
	});

	test("lets the writer agent reject a false-positive classifier decision", async () => {
		const fx = await createFixture();
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			toolUseMessage([
				{
					type: "toolCall",
					id: "decision-false-positive",
					name: "record_learning_decision",
					arguments: {
						store: true,
						scope: "repo",
						trigger: "complaint",
						confidence: 0.91,
						reason: "Classifier over-selected a task request.",
					},
				},
			]),
		);
		const writerSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValueOnce(agentWriterSkipResult("Latest user message contains no durable learning."));

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
					content: "Fix the settings button text.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(() => {
			expect(writerSpy).toHaveBeenCalledTimes(1);
		});

		expect(await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd)).toBeUndefined();
		expect(fx.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		const writerOptions = writerSpy.mock.calls[0]?.[0];
		expect(writerOptions?.thinkingLevel).toBe(ai.Effort.High);
		expect(writerOptions?.agent.thinkingLevel).toBe(ai.Effort.High);
		expect(writerOptions?.outputSchema).toMatchObject({
			required: ["action"],
			properties: {
				action: { type: "string", enum: ["store", "skip"] },
			},
		});
		expect(debugSpy).toHaveBeenCalledWith(
			"live-learning: writer agent skipped",
			expect.objectContaining({
				scope: "repo",
				trigger: "complaint",
				reason: "Latest user message contains no durable learning.",
			}),
		);
	});

	test("uses a longer default writer timeout for high-reasoning writer agents", async () => {
		const fx = await createFixture();
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			toolUseMessage([
				{
					type: "toolCall",
					id: "decision-timeout",
					name: "record_learning_decision",
					arguments: {
						store: true,
						scope: "repo",
						trigger: "complaint",
						confidence: 0.98,
						reason: "User complained about live-learning writer failures.",
					},
				},
			]),
		);
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValueOnce(
			agentWriterResult("Learning writer should have enough time for high reasoning."),
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
					content: "Learning writer vẫn fail vì timeout, cần robust hơn.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(() => {
			expect(taskExecutor.runSubprocess).toHaveBeenCalledTimes(1);
		});

		expect(timeoutSpy).toHaveBeenCalledWith(60_000);
	});

	test("logs writer abort details without reporting a generic no-content failure", async () => {
		const fx = await createFixture();
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			toolUseMessage([
				{
					type: "toolCall",
					id: "decision-aborted-writer",
					name: "record_learning_decision",
					arguments: {
						store: true,
						scope: "repo",
						trigger: "complaint",
						confidence: 0.98,
						reason: "User complained about live-learning writer failures.",
					},
				},
			]),
		);
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValueOnce(agentWriterAbortResult());

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
					content: "Learning writer vẫn fail, log phải cho thấy lý do timeout.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(() => {
			expect(taskExecutor.runSubprocess).toHaveBeenCalledTimes(1);
		});

		expect(debugSpy).toHaveBeenCalledWith(
			"live-learning: writer agent failed",
			expect.objectContaining({
				scope: "repo",
				trigger: "complaint",
				error: "The operation was aborted due to timeout",
				exitCode: 1,
				aborted: true,
				abortReason: "The operation was aborted due to timeout",
				durationMs: 15_000,
				resolvedModel: "anthropic/claude-opus-4-8:high",
			}),
		);
		expect(debugSpy).not.toHaveBeenCalledWith("live-learning: writer returned no content", expect.anything());
		expect(await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd)).toBeUndefined();
	});

	test("stores a learning when the classifier returns fallback JSON text", async () => {
		const fx = await createFixture();
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			assistantText(
				JSON.stringify({
					store: true,
					scope: "repo",
					trigger: "reminder",
					confidence: 0.88,
					reason: "User gave a durable verification reminder.",
				}),
			),
		);
		const writerSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValueOnce(
				agentWriterResult("Treat user reminders about verification as durable repo-level workflow guidance."),
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
					content: "Nhớ lần sau luôn verify thật trước khi nói đã xong.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(async () => {
			const payload = await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd);
			expect(payload).toContain("Treat user reminders about verification");
		});
		expect(completeSpy).toHaveBeenCalledTimes(1);
		expect(writerSpy).toHaveBeenCalledTimes(1);
		expect(fx.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
	});

	test("falls back to the next configured classifier model after an invalid response", async () => {
		const fx = await createFixture({
			"learning.classifierModels": ["openai-codex/gpt-5.4-nano", "pi/smol"],
		});
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const completeSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(assistantText("not json"))
			.mockResolvedValueOnce(
				toolUseMessage([
					{
						type: "toolCall",
						id: "decision-2",
						name: "record_learning_decision",
						arguments: {
							store: true,
							scope: "repo",
							trigger: "complaint",
							confidence: 0.93,
							reason: "User complained about live learning classifier failures.",
						},
					},
				]),
			);
		const writerSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValueOnce(
				agentWriterResult("If the live-learning classifier fails, use the configured classifier fallback chain."),
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
					content: "Learning đang fail classify, lần sau phải fallback model khác.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(async () => {
			const payload = await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd);
			expect(payload).toContain("configured classifier fallback chain");
		});
		expect(completeSpy).toHaveBeenCalledTimes(2);
		expect(completeSpy.mock.calls[0]?.[0].provider).toBe("openai-codex");
		expect(completeSpy.mock.calls[0]?.[0].id).toBe("gpt-5.4-nano");
		expect(completeSpy.mock.calls[1]?.[0].id).toBe("smol-model");
		expect(writerSpy).toHaveBeenCalledTimes(1);
		expect(debugSpy).toHaveBeenCalledWith(
			"live-learning: classifier response invalid",
			expect.objectContaining({ model: "openai-codex/gpt-5.4-nano" }),
		);
	});

	test("skips ordinary user messages and does not call the writer model", async () => {
		const fx = await createFixture();
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
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
		const writerSpy = vi.spyOn(taskExecutor, "runSubprocess");

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
		expect(await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd)).toBeUndefined();
		expect(fx.refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(debugSpy).toHaveBeenCalledWith(
			"live-learning: classifier skipped",
			expect.objectContaining({
				cwd: fx.cwd,
				scope: "repo",
				trigger: "none",
				confidence: 0.98,
			}),
		);
		expect(writerSpy).not.toHaveBeenCalled();
	});

	test("keeps global learnings separate from repo learnings", async () => {
		const fx = await createFixture();
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
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
		);
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValueOnce(
			agentWriterResult("Keep responses concise when the user asks for direct execution."),
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
			const payload = await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd);
			expect(payload).toContain("Global learnings");
			expect(payload).toContain("Keep responses concise");
		});

		await clearLearningData(fx.agentDir, fx.cwd, "repo");
		expect(await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd)).toContain(
			"Keep responses concise",
		);
		await clearLearningData(fx.agentDir, fx.cwd, "global");
		expect(await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd)).toBeUndefined();
	});
});
