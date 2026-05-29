import type { AssistantMessage, Model, Tool, UserMessage } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel, completeSimple, Effort } from "@oh-my-pi/pi-ai";
import { getAgentDbPath, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import classifyTemplate from "../prompts/learnings/classify.md" with { type: "text" };
import injectionTemplate from "../prompts/learnings/injection.md" with { type: "text" };
import writeTemplate from "../prompts/learnings/write.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import {
	clearLearningData as clearLearningDataInDb,
	closeLearningDb,
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
	classifierTimeoutMs: number;
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

const DEFAULTS: LearningRuntimeConfig = {
	enabled: false,
	minConfidence: 0.7,
	classifierTimeoutMs: 8_000,
	writerTimeoutMs: 15_000,
	maxUserMessageChars: 4_000,
	maxEntriesPerScope: 40,
};

const DECISION_TOOL_NAME = "record_learning_decision";
const WRITER_TOOL_NAME = "record_learning";
const CLASSIFIER_MAX_TOKENS = 128;
const REASONING_CLASSIFIER_MAX_TOKENS = 1024;
const WRITER_MAX_TOKENS = 1024;

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

const writerTool: Tool = {
	name: WRITER_TOOL_NAME,
	description: "Return the durable learning guideline to store.",
	parameters: {
		type: "object",
		properties: {
			content: { type: "string" },
		},
		required: ["content"],
		additionalProperties: false,
	},
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
	if (!config.enabled) return;
	if (taskDepth > 0) return;

	let queue = Promise.resolve();
	session.subscribe(event => {
		if (event.type !== "agent_end") return;
		const userText = extractLatestUserText(event);
		if (!userText) return;
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
				logger.debug("live-learning: processing failed", { error: String(error) });
			});
	});
}

export async function buildLearningDeveloperInstructions(
	agentDir: string,
	settings: Settings,
): Promise<string | undefined> {
	const config = loadLearningConfig(settings);
	if (!config.enabled) return undefined;
	const db = openLearningDb(getAgentDbPath(agentDir));
	try {
		const entries = listLearningEntries(db, settings.getCwd(), config.maxEntriesPerScope);
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

async function processLearningFromUserMessage(options: {
	userText: string;
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	config: LearningRuntimeConfig;
}): Promise<boolean> {
	const { userText, session, settings, modelRegistry, agentDir, config } = options;
	const cwd = settings.getCwd();
	const sanitizedUserText = redactSecrets(userText).trim();
	if (!sanitizedUserText) return false;
	const boundedUserText = truncateChars(sanitizedUserText, config.maxUserMessageChars);
	const decision = await classifyLearning({
		userText: boundedUserText,
		cwd,
		session,
		settings,
		modelRegistry,
		config,
	});
	if (!decision?.store) return false;
	if (decision.confidence < config.minConfidence) return false;

	const db = openLearningDb(getAgentDbPath(agentDir));
	try {
		const existing = listLearningEntries(db, cwd, config.maxEntriesPerScope).filter(
			entry => entry.scope === decision.scope,
		);
		const content = await writeLearning({
			userText: boundedUserText,
			decision,
			existing,
			session,
			settings,
			modelRegistry,
			config,
		});
		if (!content) return false;
		return upsertLearning(db, {
			scope: decision.scope,
			cwd,
			content,
			sourceMessageHash: learningMessageHash(boundedUserText),
			trigger: decision.trigger,
			confidence: decision.confidence,
			nowSec: unixNow(),
		});
	} finally {
		closeLearningDb(db);
	}
}

async function classifyLearning(options: {
	userText: string;
	cwd: string;
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	config: LearningRuntimeConfig;
}): Promise<LearningDecision | undefined> {
	const model = resolveLearningModel(
		["smol", "default"],
		options.modelRegistry,
		options.settings,
		options.session.model,
	);
	if (!model) return undefined;
	const apiKey = await options.modelRegistry.getApiKey(model, options.session.sessionId);
	if (!apiKey) return undefined;
	const input = prompt.render(classifyTemplate, {
		cwd: options.cwd,
		user_message: options.userText,
	});
	const response = await completeSimple(
		model,
		{
			messages: [{ role: "user", content: input, timestamp: Date.now() }],
			tools: [decisionTool],
		},
		{
			apiKey,
			maxTokens: model.reasoning ? REASONING_CLASSIFIER_MAX_TOKENS : CLASSIFIER_MAX_TOKENS,
			disableReasoning: true,
			toolChoice: { type: "tool", name: DECISION_TOOL_NAME },
			metadata: options.session.agent?.metadataForProvider(model.provider),
			signal: AbortSignal.timeout(options.config.classifierTimeoutMs),
		},
	);
	if (response.stopReason === "error") return undefined;
	return parseLearningDecision(extractToolArguments(response.content, DECISION_TOOL_NAME));
}

async function writeLearning(options: {
	userText: string;
	decision: LearningDecision;
	existing: LearningEntry[];
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	config: LearningRuntimeConfig;
}): Promise<string | undefined> {
	const model = resolveLearningModel(
		["plan", "default"],
		options.modelRegistry,
		options.settings,
		options.session.model,
	);
	if (!model) return undefined;
	const apiKey = await options.modelRegistry.getApiKey(model, options.session.sessionId);
	if (!apiKey) return undefined;
	const input = prompt.render(writeTemplate, {
		scope: options.decision.scope,
		trigger: options.decision.trigger,
		reason: options.decision.reason,
		existing_learnings: renderExistingLearnings(options.existing),
		user_message: options.userText,
	});
	const response = await completeSimple(
		model,
		{
			messages: [{ role: "user", content: input, timestamp: Date.now() }],
			tools: [writerTool],
		},
		{
			apiKey,
			maxTokens: WRITER_MAX_TOKENS,
			reasoning: clampThinkingLevelForModel(model, Effort.Low),
			toolChoice: { type: "tool", name: WRITER_TOOL_NAME },
			metadata: options.session.agent?.metadataForProvider(model.provider),
			signal: AbortSignal.timeout(options.config.writerTimeoutMs),
		},
	);
	if (response.stopReason === "error") return undefined;
	const args = extractToolArguments(response.content, WRITER_TOOL_NAME);
	const raw = typeof args?.content === "string" ? args.content : undefined;
	if (!raw) return undefined;
	const content = redactSecrets(raw).trim();
	if (!content) return undefined;
	return truncateChars(content, 800);
}

function resolveLearningModel(
	roles: readonly string[],
	modelRegistry: ModelRegistry,
	settings: Settings,
	currentModel?: Model,
): Model | undefined {
	const available = modelRegistry.getAvailable();
	return (
		resolveRoleSelection(roles, settings, available, modelRegistry)?.model ??
		currentModel ??
		modelRegistry.getAll()[0]
	);
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
		if (!content.arguments || typeof content.arguments !== "object" || Array.isArray(content.arguments))
			return undefined;
		return content.arguments as Record<string, unknown>;
	}
	return undefined;
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
	const patterns = [
		/(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/g,
		/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
		/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
	];
	for (const pattern of patterns) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

function loadLearningConfig(settings: Settings): LearningRuntimeConfig {
	return {
		enabled: settings.get("learning.enabled") ?? DEFAULTS.enabled,
		minConfidence: settings.get("learning.minConfidence") ?? DEFAULTS.minConfidence,
		classifierTimeoutMs: settings.get("learning.classifierTimeoutMs") ?? DEFAULTS.classifierTimeoutMs,
		writerTimeoutMs: settings.get("learning.writerTimeoutMs") ?? DEFAULTS.writerTimeoutMs,
		maxUserMessageChars: settings.get("learning.maxUserMessageChars") ?? DEFAULTS.maxUserMessageChars,
		maxEntriesPerScope: settings.get("learning.maxEntriesPerScope") ?? DEFAULTS.maxEntriesPerScope,
	};
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}
