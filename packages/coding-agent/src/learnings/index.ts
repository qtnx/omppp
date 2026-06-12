import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Model, Tool, UserMessage } from "@oh-my-pi/pi-ai";
import { completeSimple, Effort } from "@oh-my-pi/pi-ai";
import { APP_NAME, getAgentDbPath, getLogPath, getLogsDir, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelOverride, resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import agentWriterSystemPrompt from "../prompts/learnings/agent-writer-system.md" with { type: "text" };
import classifyTemplate from "../prompts/learnings/classify.md" with { type: "text" };
import injectionTemplate from "../prompts/learnings/injection.md" with { type: "text" };
import writeTemplate from "../prompts/learnings/write.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import * as taskExecutor from "../task/executor";
import type { AgentDefinition, SingleResult } from "../task/types";
import { isLowSignalTitleInput } from "../tiny/text";
import {
	createLearningAuditRun,
	finalizeLearningAuditRun,
	type LearningAuditRun,
	type LearningDecisionSnapshot,
	recordLearningAuditCandidate,
	recordLearningClassifierFailure,
	recordLearningClassifierRequest,
	recordLearningClassifierResponse,
	recordLearningWriterRequest,
	recordLearningWriterResult,
	toLearningAuditInsert,
} from "./audit";
import {
	clearLearningData as clearLearningDataInDb,
	closeLearningDb,
	insertLearningAudit,
	type LearningEntry,
	type LearningScope,
	learningMessageHash,
	listLearningEntries,
	openLearningDb,
	upsertLearning,
} from "./storage";

interface LearningRuntimeConfig {
	enabled: boolean;
	minConfidence: number;
	classifierModels: string[];
	classifierTimeoutMs: number;
	writerModels: string[];
	writerTimeoutMs: number;
	maxUserMessageChars: number;
	maxEntriesPerScope: number;
}

interface LearningDecision {
	store: boolean;
	scope: LearningScope;
	trigger: string;
	confidence: number;
	reason: string;
}

type WriterAgentDecision =
	| {
			action: "store";
			content: string;
	  }
	| {
			action: "skip";
			reason?: string;
	  };
type LearningWriteResult =
	| {
			status: "store";
			content: string;
	  }
	| {
			status: "skip" | "failed";
	  };

const DEFAULTS: LearningRuntimeConfig = {
	enabled: false,
	minConfidence: 0.7,
	classifierModels: [],
	classifierTimeoutMs: 8_000,
	writerModels: [],
	writerTimeoutMs: 60_000,
	maxUserMessageChars: 4_000,
	maxEntriesPerScope: 40,
};

const DECISION_TOOL_NAME = "record_learning_decision";
const DEFAULT_CLASSIFIER_ROLES = ["smol", "default"] as const;
const DEFAULT_WRITER_MODELS: string[] = ["pi/plan", "pi/default"];
const CLASSIFIER_MAX_TOKENS = 128;
const REASONING_CLASSIFIER_MAX_TOKENS = 1024;
const SECRET_PATTERNS = [
	/(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/g,
	/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
	/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
];
const LEARNING_LOG_LINE_LIMIT = 50;
const LEARNING_LOG_TAIL_BYTES = 512 * 1024;
const LEARNING_LOG_MARKER = "live-learning:";
const LEARNING_LOG_FILE_LIMIT = 3;
const LEARNING_LOG_FILE_PATTERN = new RegExp(`^${escapeRegExp(APP_NAME)}\\.\\d{4}-\\d{2}-\\d{2}\\.log$`);
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const decisionTool: Tool = {
	name: DECISION_TOOL_NAME,
	description:
		"Decide whether the latest user message contains a durable user complain, reminder, correction, or guideline.",
	parameters: {
		type: "object",
		properties: {
			store: { type: "boolean" },
			scope: { type: "string", enum: ["global", "repo"] },
			trigger: { type: "string", enum: ["complaint", "guideline", "reminder", "correction", "preference", "none"] },
			confidence: { type: "number" },
			reason: { type: "string" },
		},
		required: ["store", "scope", "trigger", "confidence", "reason"],
		additionalProperties: false,
	},
};

const LEARNING_WRITER_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string", enum: ["store", "skip"] },
		content: { type: "string" },
		reason: { type: "string" },
		source: { type: "string", enum: ["latest_user_message", "session_history"] },
		evidence: { type: "string" },
	},
	required: ["action"],
} as const;

const LEARNING_WRITER_AGENT: AgentDefinition = {
	name: "learning-writer",
	description: "Writes durable live-learning entries from user complaints and reminders",
	systemPrompt: agentWriterSystemPrompt,
	tools: ["read"],
	model: DEFAULT_WRITER_MODELS,
	thinkingLevel: Effort.High,
	output: LEARNING_WRITER_OUTPUT_SCHEMA,
	source: "bundled",
};

export function startLearningStartupTask(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
}): void {
	const { session, settings, modelRegistry, agentDir, taskDepth } = options;
	const config = loadLearningConfig(settings);
	const cwd = session.sessionManager.getCwd();
	if (!config.enabled) {
		logger.debug("live-learning: disabled", { cwd });
		return;
	}
	if (taskDepth > 0) {
		logger.debug("live-learning: skipped subagent", { cwd, taskDepth, sessionId: session.sessionId });
		return;
	}

	logger.debug("live-learning: attached", { cwd, sessionId: session.sessionId });

	let queue = Promise.resolve();
	session.subscribe(event => {
		if (event.type !== "agent_end") return;
		const userText = extractLatestUserText(event);
		if (!userText) {
			logger.debug("live-learning: no latest user message", { cwd, sessionId: session.sessionId });
			return;
		}
		if (isLowSignalTitleInput(userText)) {
			logger.debug("live-learning: skipped low-signal input", { cwd, sessionId: session.sessionId });
			return;
		}
		logger.debug("live-learning: candidate", { cwd, sessionId: session.sessionId, chars: userText.length });
		queue = queue
			.then(async () => {
				const stored = await processLearningFromUserMessage({
					userText,
					session,
					settings,
					modelRegistry,
					agentDir,
					config,
				});
				if (stored) await session.refreshBaseSystemPrompt?.();
			})
			.catch(error => {
				logger.debug("live-learning: processing failed", {
					cwd,
					sessionId: session.sessionId,
					error: String(error),
				});
			});
	});
}

export async function buildLearningDeveloperInstructions(
	agentDir: string,
	settings: Settings,
	cwd = settings.getCwd(),
): Promise<string | undefined> {
	const config = loadLearningConfig(settings);
	if (!config.enabled) return undefined;
	const db = openLearningDb(getAgentDbPath(agentDir));
	try {
		const entries = listLearningEntries(db, cwd, config.maxEntriesPerScope);
		if (entries.length === 0) return undefined;
		const global = entries.filter(entry => entry.scope === "global");
		const repo = entries.filter(entry => entry.scope === "repo");
		if (global.length === 0 && repo.length === 0) return undefined;
		return prompt
			.render(injectionTemplate, {
				global_section: renderLearningSection("Global learnings", global),
				repo_section: renderLearningSection("Repository-specific learnings", repo),
			})
			.trim();
	} finally {
		closeLearningDb(db);
	}
}

export async function clearLearningData(
	agentDir: string,
	cwd: string,
	scope: LearningScope | "all" = "all",
): Promise<void> {
	const db = openLearningDb(getAgentDbPath(agentDir));
	try {
		clearLearningDataInDb(db, cwd, scope);
	} finally {
		closeLearningDb(db);
	}
}

export async function getLearningLogText(maxLines = LEARNING_LOG_LINE_LIMIT): Promise<string> {
	const lineLimit = Math.max(1, Math.floor(maxLines));
	const logPaths = await listRecentLogPaths();
	const learningLines: string[] = [];
	for (let i = logPaths.length - 1; i >= 0; i--) {
		learningLines.push(...(await readLearningLogLines(logPaths[i])));
	}
	return learningLines.slice(-lineLimit).join("\n");
}

async function listRecentLogPaths(): Promise<string[]> {
	try {
		const logsDir = getLogsDir();
		const entries = await fs.readdir(logsDir, { withFileTypes: true });
		const datedPaths = entries
			.filter(entry => entry.isFile() && LEARNING_LOG_FILE_PATTERN.test(entry.name))
			.map(entry => path.join(logsDir, entry.name))
			.sort((left, right) => path.basename(right).localeCompare(path.basename(left)));
		const logPaths = datedPaths.slice(0, LEARNING_LOG_FILE_LIMIT);
		return logPaths.length > 0 ? logPaths : [getLogPath()];
	} catch (error) {
		if (isEnoent(error)) return [getLogPath()];
		throw error;
	}
}

async function readLearningLogLines(logPath: string): Promise<string[]> {
	try {
		const file = Bun.file(logPath);
		const size = file.size;
		const start = Math.max(0, size - LEARNING_LOG_TAIL_BYTES);
		const text = start > 0 ? await file.slice(start, size).text() : await file.text();
		const lines = text.split("\n");
		if (start > 0 && lines.length > 0) {
			lines.shift();
		}
		return lines.filter(line => line.includes(LEARNING_LOG_MARKER));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function processLearningFromUserMessage(options: {
	userText: string;
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	config: LearningRuntimeConfig;
}): Promise<boolean> {
	const { userText, session, settings, modelRegistry, agentDir, config } = options;
	const cwd = session.sessionManager.getCwd();
	const sanitizedUserText = redactSecrets(userText).trim();
	const sessionId = session.sessionId;
	if (!sanitizedUserText) return false;
	const boundedUserText = truncateChars(sanitizedUserText, config.maxUserMessageChars);
	const sourceMessageHash = learningMessageHash(boundedUserText);
	const audit = createLearningAuditRun({
		session,
		agentDir,
		cwd,
		userText: boundedUserText,
		sourceMessageHash,
		nowSec: unixNow(),
	});
	await recordLearningAuditCandidate(audit, boundedUserText);
	const decision = await classifyLearning({
		userText: boundedUserText,
		cwd,
		session,
		settings,
		modelRegistry,
		config,
		audit,
	});
	if (!decision) {
		logger.debug("live-learning: classifier unavailable", { cwd, sessionId });
		await persistLearningAudit(agentDir, audit, "classifier_unavailable", false);
		return false;
	}
	const decisionSnapshot = snapshotLearningDecision(decision);
	const decisionLogContext = {
		cwd,
		sessionId,
		scope: decision.scope,
		trigger: decision.trigger,
		confidence: decision.confidence,
	};
	logger.debug("live-learning: classifier verdict", {
		cwd,
		sessionId,
		store: decision.store,
		scope: decision.scope,
		trigger: decision.trigger,
		confidence: decision.confidence,
	});
	if (!decision.store) {
		logger.debug("live-learning: classifier skipped", decisionLogContext);
		await persistLearningAudit(agentDir, audit, "classifier_skipped", false, decisionSnapshot);
		return false;
	}
	if (decision.confidence < config.minConfidence) {
		logger.debug("live-learning: confidence below threshold", {
			...decisionLogContext,
			minConfidence: config.minConfidence,
		});
		await persistLearningAudit(agentDir, audit, "confidence_below_threshold", false, decisionSnapshot);
		return false;
	}

	const db = openLearningDb(getAgentDbPath(agentDir));
	try {
		const existing = listLearningEntries(db, cwd, config.maxEntriesPerScope).filter(
			entry => entry.scope === decision.scope,
		);
		const writeResult = await writeLearning({
			userText: boundedUserText,
			decision,
			existing,
			session,
			settings,
			modelRegistry,
			config,
			audit,
		});
		if (writeResult.status !== "store") {
			await persistLearningAuditInDb(
				db,
				audit,
				writeResult.status === "skip" ? "writer_skipped" : "writer_failed",
				false,
				decisionSnapshot,
			);
			return false;
		}
		const stored = upsertLearning(db, {
			scope: decision.scope,
			cwd,
			content: writeResult.content,
			sourceMessageHash,
			trigger: decision.trigger,
			confidence: decision.confidence,
			nowSec: unixNow(),
		});
		logger.debug(stored ? "live-learning: stored" : "live-learning: store no-op", decisionLogContext);
		await persistLearningAuditInDb(db, audit, stored ? "stored" : "store_noop", stored, decisionSnapshot);
		return stored;
	} finally {
		closeLearningDb(db);
	}
}

async function persistLearningAudit(
	agentDir: string,
	audit: LearningAuditRun,
	outcome: string,
	stored: boolean,
	decision?: LearningDecisionSnapshot,
): Promise<void> {
	const db = openLearningDb(getAgentDbPath(agentDir));
	try {
		await persistLearningAuditInDb(db, audit, outcome, stored, decision);
	} finally {
		closeLearningDb(db);
	}
}

async function persistLearningAuditInDb(
	db: Database,
	audit: LearningAuditRun,
	outcome: string,
	stored: boolean,
	decision?: LearningDecisionSnapshot,
): Promise<void> {
	await finalizeLearningAuditRun(audit, outcome, stored, decision);
	insertLearningAudit(db, toLearningAuditInsert(audit));
	logger.debug("live-learning: audit stored", {
		auditId: audit.id,
		sessionId: audit.sessionId,
		outcome,
		auditDir: audit.auditDir,
	});
}

async function classifyLearning(options: {
	userText: string;
	cwd: string;
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	config: LearningRuntimeConfig;
	audit: LearningAuditRun;
}): Promise<LearningDecision | undefined> {
	const { userText, cwd, session, settings, modelRegistry, config, audit } = options;
	const sessionId = session.sessionId;
	const models = resolveLearningClassifierModels(modelRegistry, settings, config, session.model);
	if (models.length === 0) {
		logger.debug("live-learning: classifier model unavailable", {
			cwd,
			sessionId,
		});
		await recordLearningClassifierFailure(audit, undefined, "model_unavailable", "No classifier model resolved");
		return undefined;
	}
	const input = prompt.render(classifyTemplate, {
		cwd,
		user_message: userText,
	});
	for (const model of models) {
		const modelId = formatModelId(model);
		const decision = await classifyLearningWithModel({
			model,
			modelId,
			input,
			cwd,
			session,
			modelRegistry,
			config,
			audit,
		});
		if (decision) return decision;
	}
	return undefined;
}

async function classifyLearningWithModel(options: {
	model: Model;
	modelId: string;
	input: string;
	cwd: string;
	session: AgentSession;
	modelRegistry: ModelRegistry;
	config: LearningRuntimeConfig;
	audit: LearningAuditRun;
}): Promise<LearningDecision | undefined> {
	const { model, modelId, input, cwd, session, modelRegistry, config, audit } = options;
	const sessionId = session.sessionId;
	try {
		const apiKey = await modelRegistry.getApiKey(model, sessionId);
		if (!apiKey) {
			logger.debug("live-learning: classifier api key unavailable", {
				cwd,
				sessionId,
				model: modelId,
			});
			await recordLearningClassifierFailure(audit, model, "api_key_unavailable", "Classifier API key unavailable");
			return undefined;
		}

		const classifierRequest = {
			systemPrompt: [input],
			messages: [{ role: "user" as const, content: input, timestamp: Date.now() }],
			tools: [decisionTool],
			options: {
				maxTokens: model.reasoning ? REASONING_CLASSIFIER_MAX_TOKENS : CLASSIFIER_MAX_TOKENS,
				disableReasoning: true,
				toolChoice: { type: "tool", name: DECISION_TOOL_NAME },
				timeoutMs: config.classifierTimeoutMs,
			},
		};
		const auditAttempt = await recordLearningClassifierRequest(audit, model, classifierRequest);
		const response = await completeSimple(
			model,
			{
				systemPrompt: classifierRequest.systemPrompt,
				messages: classifierRequest.messages,
				tools: classifierRequest.tools,
			},
			{
				apiKey,
				maxTokens: classifierRequest.options.maxTokens,
				disableReasoning: true,
				toolChoice: { type: "tool", name: DECISION_TOOL_NAME },
				metadata: session.agent?.metadataForProvider(model.provider),
				signal: AbortSignal.timeout(config.classifierTimeoutMs),
			},
		);
		if (response.stopReason === "error") {
			logger.debug("live-learning: classifier response error", {
				cwd,
				sessionId,
				model: modelId,
				error: response.errorMessage,
			});
			await recordLearningClassifierResponse(audit, auditAttempt, response, undefined, "request_failed");
			return undefined;
		}
		const decision = parseLearningDecisionFromContent(response.content);
		await recordLearningClassifierResponse(
			audit,
			auditAttempt,
			response,
			decision ? snapshotLearningDecision(decision) : undefined,
		);
		if (decision) return decision;
		logger.debug("live-learning: classifier response invalid", {
			cwd,
			sessionId,
			model: modelId,
			stopReason: response.stopReason,
		});
		return undefined;
	} catch (error) {
		logger.debug("live-learning: classifier request failed", {
			cwd,
			sessionId,
			model: modelId,
			error: String(error),
		});
		await recordLearningClassifierFailure(audit, model, "request_failed", String(error));
		return undefined;
	}
}

async function writeLearning(options: {
	userText: string;
	decision: LearningDecision;
	existing: LearningEntry[];
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	config: LearningRuntimeConfig;
	audit: LearningAuditRun;
}): Promise<LearningWriteResult> {
	const { userText, decision, existing, session, settings, modelRegistry, config, audit } = options;
	const cwd = session.sessionManager.getCwd();
	const sessionId = session.sessionId;
	const input = prompt.render(writeTemplate, {
		scope: decision.scope,
		trigger: decision.trigger,
		reason: decision.reason,
		existing_learnings: renderExistingLearnings(existing),
		user_message: userText,
	});
	const writerModels = config.writerModels.length > 0 ? config.writerModels : DEFAULT_WRITER_MODELS;
	const contextFile = session.sessionManager.getSessionFile() ?? undefined;
	const contextFiles = contextFile ? [{ path: contextFile, content: "" }] : undefined;
	await recordLearningWriterRequest(audit, input, writerModels, contextFile);
	const signal = AbortSignal.timeout(config.writerTimeoutMs);
	const result = await taskExecutor.runSubprocess({
		cwd: session.sessionManager.getCwd(),
		agent: LEARNING_WRITER_AGENT,
		task: input,
		index: 0,
		id: "learning-writer",
		modelOverride: writerModels,
		parentActiveModelPattern: session.model ? formatModelId(session.model) : undefined,
		thinkingLevel: Effort.High,
		outputSchema: LEARNING_WRITER_OUTPUT_SCHEMA,
		taskDepth: 0,
		enableLsp: false,
		signal,
		contextFiles,
		artifactsDir: audit.auditDir,
		persistArtifacts: true,
		modelRegistry,
		settings,
	});
	if (result.exitCode !== 0) {
		await recordLearningWriterResult(audit, result, undefined, "failed");
		logger.debug("live-learning: writer agent failed", {
			cwd,
			sessionId,
			scope: decision.scope,
			trigger: decision.trigger,
			error: writerFailureMessage(result),
			exitCode: result.exitCode,
			aborted: result.aborted,
			abortReason: result.abortReason,
			durationMs: result.durationMs,
			resolvedModel: result.resolvedModel,
			retryFailure: result.retryFailure,
		});
		return { status: "failed" };
	}
	const writerDecision = parseWriterAgentDecision(result.output);
	if (!writerDecision) {
		await recordLearningWriterResult(audit, result, undefined, "failed");
		logger.debug("live-learning: writer agent response invalid", {
			cwd,
			sessionId,
			scope: decision.scope,
			trigger: decision.trigger,
			output: truncateChars(result.output, 500),
		});
		return { status: "failed" };
	}
	if (writerDecision.action === "skip") {
		await recordLearningWriterResult(audit, result, writerDecision, "skip");
		logger.debug("live-learning: writer agent skipped", {
			cwd,
			sessionId,
			scope: decision.scope,
			trigger: decision.trigger,
			reason: writerDecision.reason,
		});
		return { status: "skip" };
	}
	await recordLearningWriterResult(audit, result, writerDecision, "store");
	return { status: "store", content: truncateChars(writerDecision.content, 800) };
}

function writerFailureMessage(result: SingleResult): string {
	const message =
		result.stderr ||
		result.error ||
		result.abortReason ||
		result.retryFailure?.errorMessage ||
		result.output ||
		"Unknown writer agent failure";
	return truncateChars(message, 500);
}

function parseWriterAgentDecision(output: string): WriterAgentDecision | undefined {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const writerOutput = parsed as { action?: unknown; content?: unknown; reason?: unknown };
		if (writerOutput.action === "skip") {
			const reason = typeof writerOutput.reason === "string" ? redactSecrets(writerOutput.reason).trim() : "";
			return reason ? { action: "skip", reason } : { action: "skip" };
		}
		if (writerOutput.action !== "store") return undefined;
		if (typeof writerOutput.content !== "string") return undefined;
		const content = redactSecrets(writerOutput.content).trim();
		return content ? { action: "store", content } : undefined;
	} catch {
		return undefined;
	}
}

function resolveLearningClassifierModels(
	modelRegistry: ModelRegistry,
	settings: Settings,
	config: LearningRuntimeConfig,
	currentModel?: Model,
): Model[] {
	const models: Model[] = [];
	if (config.classifierModels.length > 0) {
		for (const pattern of config.classifierModels) {
			pushModelIfUnique(models, resolveConfiguredClassifierModel(pattern, modelRegistry, settings));
		}
	} else {
		const available = modelRegistry.getAvailable();
		for (const role of DEFAULT_CLASSIFIER_ROLES) {
			pushModelIfUnique(models, resolveRoleSelection([role], settings, available, modelRegistry)?.model);
		}
	}
	pushModelIfUnique(models, currentModel);
	pushModelIfUnique(models, modelRegistry.getAll()[0]);
	return models;
}

function resolveConfiguredClassifierModel(
	pattern: string,
	modelRegistry: ModelRegistry,
	settings: Settings,
): Model | undefined {
	const available = modelRegistry.getAvailable();
	return (
		resolveRoleSelection([pattern], settings, available, modelRegistry)?.model ??
		resolveModelOverride([pattern], modelRegistry, settings).model
	);
}

function snapshotLearningDecision(decision: LearningDecision): LearningDecisionSnapshot {
	return {
		store: decision.store,
		scope: decision.scope,
		trigger: decision.trigger,
		confidence: decision.confidence,
		reason: decision.reason,
	};
}

function pushModelIfUnique(models: Model[], model: Model | undefined): void {
	if (!model) return;
	if (models.some(candidate => isSameModel(candidate, model))) return;
	models.push(model);
}

function isSameModel(left: Model, right: Model): boolean {
	return left.provider === right.provider && left.id === right.id;
}

function formatModelId(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function extractLatestUserText(event: Extract<AgentSessionEvent, { type: "agent_end" }>): string | undefined {
	for (let i = event.messages.length - 1; i >= 0; i--) {
		const message = event.messages[i];
		if (message.role !== "user") continue;
		const user = message as UserMessage;
		if (user.synthetic) continue;
		if (user.attribution === "agent") continue;
		const text = extractMessageText(user);
		if (text.trim()) return text.trim();
	}
	return undefined;
}

function extractMessageText(message: UserMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter(item => item.type === "text")
		.map(item => item.text)
		.join("\n");
}

function extractToolArguments(
	contentBlocks: AssistantMessage["content"],
	toolName: string,
): Record<string, unknown> | undefined {
	for (const content of contentBlocks) {
		if (content.type !== "toolCall" || content.name !== toolName) continue;
		if (!content.arguments || typeof content.arguments !== "object" || Array.isArray(content.arguments)) {
			return undefined;
		}
		return content.arguments as Record<string, unknown>;
	}
	return undefined;
}

function parseLearningDecisionFromContent(contentBlocks: AssistantMessage["content"]): LearningDecision | undefined {
	return parseLearningDecision(
		extractToolArguments(contentBlocks, DECISION_TOOL_NAME) ?? extractJsonArguments(contentBlocks),
	);
}

function extractJsonArguments(contentBlocks: AssistantMessage["content"]): Record<string, unknown> | undefined {
	const text = extractAssistantText(contentBlocks).trim();
	if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function extractAssistantText(contentBlocks: AssistantMessage["content"]): string {
	return contentBlocks
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function parseLearningDecision(args: Record<string, unknown> | undefined): LearningDecision | undefined {
	if (!args) return undefined;
	if (typeof args.store !== "boolean") return undefined;
	if (args.scope !== "global" && args.scope !== "repo") return undefined;
	if (typeof args.trigger !== "string") return undefined;
	if (typeof args.confidence !== "number" || !Number.isFinite(args.confidence)) return undefined;
	if (typeof args.reason !== "string") return undefined;
	return {
		store: args.store,
		scope: args.scope,
		trigger: redactSecrets(args.trigger).trim() || "none",
		confidence: Math.max(0, Math.min(1, args.confidence)),
		reason: redactSecrets(args.reason).trim(),
	};
}

function renderLearningSection(title: string, entries: LearningEntry[]): string {
	if (entries.length === 0) return `## ${title}\nNo live learnings stored.`;
	const lines = entries.map(entry => `- ${entry.content.trim()}`).filter(line => line.length > 2);
	return `## ${title}\n${lines.join("\n")}`;
}

function renderExistingLearnings(entries: LearningEntry[]): string {
	if (entries.length === 0) return "No existing live learnings for this scope.";
	return entries.map(entry => `- ${entry.content.trim()}`).join("\n");
}

function truncateChars(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…`;
}

function redactSecrets(input: string): string {
	let out = input;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

function loadLearningConfig(settings: Settings): LearningRuntimeConfig {
	return {
		enabled: settings.get("learning.enabled") ?? DEFAULTS.enabled,
		minConfidence: settings.get("learning.minConfidence") ?? DEFAULTS.minConfidence,
		classifierModels: settings.get("learning.classifierModels") ?? DEFAULTS.classifierModels,
		classifierTimeoutMs: settings.get("learning.classifierTimeoutMs") ?? DEFAULTS.classifierTimeoutMs,
		writerModels: settings.get("learning.writerModels") ?? DEFAULTS.writerModels,
		writerTimeoutMs: settings.get("learning.writerTimeoutMs") ?? DEFAULTS.writerTimeoutMs,
		maxUserMessageChars: settings.get("learning.maxUserMessageChars") ?? DEFAULTS.maxUserMessageChars,
		maxEntriesPerScope: settings.get("learning.maxEntriesPerScope") ?? DEFAULTS.maxEntriesPerScope,
	};
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}
