import { Database } from "bun:sqlite";
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
import * as consolidation from "@oh-my-pi/pi-coding-agent/learnings/consolidate";
import { openLearningDb, recordLearningFeedback, upsertLearning } from "@oh-my-pi/pi-coding-agent/learnings/storage";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";

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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
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
		requests: 0,
	};
}

function agentWriterReinforceResult(target: string): SingleResult {
	return {
		index: 0,
		id: "learning-writer",
		agent: "learning-writer",
		agentSource: "bundled",
		task: "learning writer",
		exitCode: 0,
		output: JSON.stringify({ action: "reinforce", target }),
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
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
		requests: 0,
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
		requests: 0,
		aborted: true,
		abortReason: "The operation was aborted due to timeout",
		resolvedModel: "anthropic/claude-opus-4-8:high",
	};
}

interface LearningAuditTestRow {
	id: string;
	session_id: string;
	cwd: string;
	outcome: string;
	classifier_status: string;
	writer_status: string;
	stored: number;
	audit_dir: string;
	audit_json_path: string;
	classifier_request_path: string;
	classifier_response_path: string;
	writer_request_path: string;
	writer_result_path: string;
	writer_session_path: string;
	writer_output_path: string;
}

function readLearningAuditRows(agentDir: string): LearningAuditTestRow[] {
	const db = new Database(getAgentDbPath(agentDir));
	try {
		return db
			.prepare("SELECT * FROM live_learning_audit_events ORDER BY created_at DESC")
			.all() as LearningAuditTestRow[];
	} finally {
		db.close();
	}
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
	return (await Bun.file(filePath).json()) as Record<string, unknown>;
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
		expect(writerOptions?.modelOverride).toEqual(["pi/plan", "pi/default"]);
		expect(writerOptions?.contextFiles?.[0]?.path).toBe(path.join(fx.agentDir, "sessions", "session-1.jsonl"));
		expect(writerOptions?.task).toContain("Extract the GENERAL principle the user is teaching.");
		expect(writerOptions?.task).toContain(
			"Strip incidental task specifics such as file names and one-off values unless the specific is the preference.",
		);
		expect(writerOptions?.task).toContain('{"action":"reinforce","target":"<alias>"}');
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

	test("skips low-signal user messages without starting the classifier", async () => {
		const fx = await createFixture();
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			toolUseMessage([
				{
					type: "toolCall",
					id: "decision-low-signal",
					name: "record_learning_decision",
					arguments: {
						store: false,
						scope: "repo",
						trigger: "none",
						confidence: 0.99,
						reason: "low-signal",
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
					content: "ok",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await Bun.sleep(50);

		expect(completeSpy).not.toHaveBeenCalled();
		expect(writerSpy).not.toHaveBeenCalled();
		expect(fx.refreshBaseSystemPrompt).not.toHaveBeenCalled();
	});

	test("writes classifier and writer audit artifacts for each learning run", async () => {
		const fx = await createFixture();
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			toolUseMessage([
				{
					type: "toolCall",
					id: "decision-audit",
					name: "record_learning_decision",
					arguments: {
						store: true,
						scope: "repo",
						trigger: "guideline",
						confidence: 0.94,
						reason: "User asked for auditable learning logs.",
					},
				},
			]),
		);
		const writerSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValueOnce(agentWriterResult("Persist raw learning classifier and writer artifacts for audit."));

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
					content: "Audit this learning path: dump classifier and writer raw messages so I can inspect them.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(() => {
			expect(readLearningAuditRows(fx.agentDir)).toHaveLength(1);
		});
		const [audit] = readLearningAuditRows(fx.agentDir);
		expect(audit).toMatchObject({
			session_id: "session-1",
			cwd: fx.cwd,
			outcome: "stored",
			classifier_status: "success",
			writer_status: "store",
			stored: 1,
		});
		expect(writerSpy.mock.calls[0]?.[0]?.artifactsDir).toBe(audit.audit_dir);
		expect(writerSpy.mock.calls[0]?.[0]?.persistArtifacts).toBe(true);

		const candidate = await readJsonFile(path.join(audit.audit_dir, "candidate.json"));
		const classifierRequest = await readJsonFile(audit.classifier_request_path);
		const classifierResponse = await readJsonFile(audit.classifier_response_path);
		const writerRequest = await readJsonFile(audit.writer_request_path);
		const writerResult = await readJsonFile(audit.writer_result_path);
		const auditJson = await readJsonFile(audit.audit_json_path);

		expect(JSON.stringify(candidate)).toContain("Audit this learning path");
		expect(JSON.stringify(classifierRequest)).toContain("You classify one latest user-authored message");
		expect(JSON.stringify(classifierResponse)).toContain("User asked for auditable learning logs");
		expect(JSON.stringify(writerRequest)).toContain("Audit this learning path");
		expect(writerResult.status).toBe("store");
		expect(auditJson.outcome).toBe("stored");
		expect(audit.writer_session_path).toBe(path.join(audit.audit_dir, "learning-writer.jsonl"));
		expect(audit.writer_output_path).toBe(path.join(audit.audit_dir, "learning-writer.md"));
	});

	test("routes the writer agent through the configured learning.writerModels chain", async () => {
		const fx = await createFixture({ "learning.writerModels": ["openai/plan-model", "openai/smol-model"] });
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			toolUseMessage([
				{
					type: "toolCall",
					id: "decision-writer-model",
					name: "record_learning_decision",
					arguments: {
						store: true,
						scope: "repo",
						trigger: "guideline",
						confidence: 0.95,
						reason: "User set a durable guideline.",
					},
				},
			]),
		);
		const writerSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValueOnce(agentWriterResult("Always rebuild the global OMPx binary after applying a fix."));

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
					content: "Sau khi fix xong thì luôn rebuild lại global OMPx binary.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(() => {
			expect(writerSpy).toHaveBeenCalledTimes(1);
		});

		expect(writerSpy.mock.calls[0]?.[0]?.modelOverride).toEqual(["openai/plan-model", "openai/smol-model"]);
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
				action: { type: "string", enum: ["store", "skip", "reinforce"] },
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

	test("reinforces an existing aliased learning without creating another row", async () => {
		const fx = await createFixture();
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		const db = openLearningDb(getAgentDbPath(fx.agentDir));
		try {
			expect(
				upsertLearning(db, {
					scope: "repo",
					cwd: fx.cwd,
					repoKey: fx.cwd,
					content: "Run real verification before claiming a task is complete.",
					sourceMessageHash: "seed",
					trigger: "guideline",
					confidence: 0.9,
					nowSec: 1,
				}),
			).toBe(true);
		} finally {
			db.close();
		}
		const seededDb = new Database(getAgentDbPath(fx.agentDir));
		const seeded = seededDb
			.prepare("SELECT id, content_hash, strength FROM live_learnings WHERE content = ?")
			.get("Run real verification before claiming a task is complete.") as {
			id: string;
			content_hash: string;
			strength: number;
		} | null;
		seededDb.close();
		expect(seeded).not.toBeNull();
		if (!seeded) throw new Error("Seeded learning was not found");
		const alias = seeded.content_hash.slice(0, 12);
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			toolUseMessage([
				{
					type: "toolCall",
					id: "reinforce-decision",
					name: "record_learning_decision",
					arguments: {
						store: true,
						scope: "repo",
						trigger: "guideline",
						confidence: 0.9,
						reason: "The existing verification guideline applies.",
					},
				},
			]),
		);
		const writerSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValueOnce(agentWriterReinforceResult(alias));

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
					content: "Nhớ phải verify thật trước khi claim xong.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(() => {
			const resultDb = new Database(getAgentDbPath(fx.agentDir));
			try {
				const row = resultDb.prepare("SELECT strength FROM live_learnings WHERE id = ?").get(seeded.id) as {
					strength: number;
				} | null;
				expect(row?.strength).toBe(2);
				expect(resultDb.prepare("SELECT COUNT(*) AS count FROM live_learnings").get()).toEqual({ count: 1 });
			} finally {
				resultDb.close();
			}
		});
		expect(writerSpy.mock.calls[0]?.[0]?.task).toContain(`[l:${alias}]`);
		expect(fx.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
	});

	test("skips an unknown reinforce alias", async () => {
		const fx = await createFixture();
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(
			toolUseMessage([
				{
					type: "toolCall",
					id: "unknown-reinforce-decision",
					name: "record_learning_decision",
					arguments: {
						store: true,
						scope: "repo",
						trigger: "guideline",
						confidence: 0.9,
						reason: "The existing guideline applies.",
					},
				},
			]),
		);
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValueOnce(agentWriterReinforceResult("abcdef123456"));

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
					content: "Nhớ phải verify thật trước khi claim xong.",
					attribution: "user",
					timestamp: Date.now(),
				},
			],
		});

		await waitFor(() => {
			expect(taskExecutor.runSubprocess).toHaveBeenCalledTimes(1);
			expect(debugSpy).toHaveBeenCalledWith(
				"live-learning: writer reinforce target unresolved",
				expect.objectContaining({ target: "abcdef123456" }),
			);
		});
		expect(await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, fx.cwd)).toBeUndefined();
		expect(fx.refreshBaseSystemPrompt).not.toHaveBeenCalled();
	});

	test("renders ranked aliases, hides not-useful entries, and uses the repository keyspace", async () => {
		const fx = await createFixture();
		const repoRoot = await makeTempDir("learnings-runtime-git");
		const nestedCwd = path.join(repoRoot, "nested");
		await fs.mkdir(nestedCwd);
		const git = Bun.spawn(["git", "init", "-q", repoRoot]);
		expect(await git.exited).toBe(0);
		const nowSec = Math.floor(Date.now() / 1000);
		const db = openLearningDb(getAgentDbPath(fx.agentDir));
		try {
			upsertLearning(db, {
				scope: "repo",
				cwd: nestedCwd,
				repoKey: repoRoot,
				content: "High-ranked repository learning.",
				sourceMessageHash: "high",
				trigger: "guideline",
				confidence: 0.9,
				nowSec,
			});
			upsertLearning(db, {
				scope: "repo",
				cwd: nestedCwd,
				repoKey: repoRoot,
				content: "Lower-ranked repository learning.",
				sourceMessageHash: "low",
				trigger: "guideline",
				confidence: 0.9,
				nowSec,
			});
			upsertLearning(db, {
				scope: "repo",
				cwd: nestedCwd,
				repoKey: repoRoot,
				content: "Hidden repository learning.",
				sourceMessageHash: "hidden",
				trigger: "guideline",
				confidence: 0.9,
				nowSec,
			});
			const hidden = db
				.prepare("SELECT id FROM live_learnings WHERE content = ?")
				.get("Hidden repository learning.") as { id: string };
			const high = db
				.prepare("SELECT id FROM live_learnings WHERE content = ?")
				.get("High-ranked repository learning.") as { id: string };
			recordLearningFeedback(db, {
				learningId: high.id,
				sessionId: "high-rank-session",
				verdict: "useful",
				nowSec: nowSec + 1,
			});
			for (let i = 0; i < 3; i++) {
				recordLearningFeedback(db, {
					learningId: hidden.id,
					sessionId: `session-${i}`,
					verdict: "not_useful",
					nowSec: nowSec + i + 1,
				});
			}
		} finally {
			db.close();
		}

		const payload = await buildLearningDeveloperInstructions(fx.agentDir, fx.settings, nestedCwd);
		if (!payload) throw new Error("Expected repository learning payload");
		expect(payload).toContain("- [l:");
		expect(payload).toContain("High-ranked repository learning.");
		expect(payload).not.toContain("Hidden repository learning.");
		expect(payload).toContain("Lower-ranked repository learning.");
		expect(payload.indexOf("High-ranked repository learning.")).toBeLessThan(
			payload.indexOf("Lower-ranked repository learning."),
		);
		expect(payload).toContain("Call `rate_learning` with an entry's id");
	});

	test("uses learning and consolidation defaults and starts consolidation once", async () => {
		const fx = await createFixture();
		const consolidationSpy = vi.spyOn(consolidation, "maybeRunLearningConsolidation").mockResolvedValueOnce([]);

		expect(fx.settings.get("learning.halfLifeDays")).toBe(45);
		expect(fx.settings.get("learning.consolidation.enabled")).toBe(true);
		expect(fx.settings.get("learning.consolidation.intervalDays")).toBe(7);
		expect(fx.settings.get("learning.consolidation.minEntries")).toBe(15);
		expect(fx.settings.get("learning.consolidation.timeoutMs")).toBe(240_000);
		expect(fx.settings.get("learning.consolidation.models")).toEqual([]);

		startLearningStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await waitFor(() => {
			expect(consolidationSpy).toHaveBeenCalledTimes(1);
		});
		expect(consolidationSpy).toHaveBeenCalledWith({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
		});
		expect(fx.refreshBaseSystemPrompt).not.toHaveBeenCalled();
	});

	test("refreshes the prompt after startup consolidation applies operations", async () => {
		const fx = await createFixture();
		vi.spyOn(consolidation, "maybeRunLearningConsolidation").mockResolvedValueOnce([
			{ target: "global", outcome: "applied", opsApplied: 1, opsSkippedStale: 0 },
		]);

		startLearningStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await waitFor(() => {
			expect(fx.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		});
	});
});
