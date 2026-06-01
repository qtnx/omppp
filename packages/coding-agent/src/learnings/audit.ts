import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getLogsDir, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { SingleResult } from "../task/types";
import type {
	LearningAuditClassifierStatus,
	LearningAuditInsert,
	LearningAuditWriterStatus,
	LearningScope,
} from "./storage";

export interface LearningDecisionSnapshot {
	store: boolean;
	scope: LearningScope;
	trigger: string;
	confidence: number;
	reason: string;
}

export interface LearningAuditRun {
	id: string;
	createdAt: number;
	updatedAt: number;
	sessionId: string;
	cwd: string;
	sourceMessageHash: string;
	userMessagePreview: string;
	auditDir: string;
	auditJsonPath: string;
	classifierAttempts: LearningAuditClassifierAttempt[];
	classifierStatus: LearningAuditClassifierStatus;
	writerStatus: LearningAuditWriterStatus;
	writerRequestPath: string;
	writerResultPath: string;
	writerSessionPath: string;
	writerOutputPath: string;
	writerModel: string;
	writerExitCode: number | null;
	stored: boolean;
	outcome: string;
	decision?: LearningDecisionSnapshot;
	writeFailures: string[];
}

export interface LearningAuditClassifierAttempt {
	model: string;
	status: LearningAuditClassifierStatus;
	requestPath: string;
	responsePath: string;
	stopReason: string;
	error: string;
	decision?: LearningDecisionSnapshot;
}

interface CreateLearningAuditRunOptions {
	session: AgentSession;
	agentDir: string;
	cwd: string;
	userText: string;
	sourceMessageHash: string;
	nowSec: number;
}

interface ClassifierRequestDump {
	model: string;
	request: unknown;
}

interface ClassifierResponseDump {
	model: string;
	response?: AssistantMessage;
	decision?: LearningDecisionSnapshot;
	status: LearningAuditClassifierStatus;
	error?: string;
}

interface WriterRequestDump {
	task: string;
	modelOverride: string[];
	contextFile: string | undefined;
	writerSessionPath: string;
	writerOutputPath: string;
}

interface WriterResultDump {
	result: SingleResult;
	writerDecision: unknown;
	status: LearningAuditWriterStatus;
}

const AUDIT_DIR_NAME = "learning-audit";
const WRITER_ID = "learning-writer";

export function createLearningAuditRun(options: CreateLearningAuditRunOptions): LearningAuditRun {
	const { session, cwd, userText, sourceMessageHash, nowSec } = options;
	const id = `learning-audit-${nowSec}-${Snowflake.next()}`;
	const auditRoot = resolveLearningAuditRoot(session, options.agentDir);
	const auditDir = path.join(auditRoot, AUDIT_DIR_NAME, id);
	return {
		id,
		createdAt: nowSec,
		updatedAt: nowSec,
		sessionId: session.sessionId,
		cwd,
		sourceMessageHash,
		userMessagePreview: truncateForPreview(userText),
		auditDir,
		auditJsonPath: path.join(auditDir, "audit.json"),
		classifierAttempts: [],
		classifierStatus: "not_run",
		writerStatus: "not_run",
		writerRequestPath: "",
		writerResultPath: "",
		writerSessionPath: path.join(auditDir, `${WRITER_ID}.jsonl`),
		writerOutputPath: path.join(auditDir, `${WRITER_ID}.md`),
		writerModel: "",
		writerExitCode: null,
		stored: false,
		outcome: "candidate",
		writeFailures: [],
	};
}

export async function recordLearningAuditCandidate(run: LearningAuditRun, userText: string): Promise<void> {
	await writeAuditJson(run, "candidate.json", {
		id: run.id,
		createdAt: run.createdAt,
		sessionId: run.sessionId,
		cwd: run.cwd,
		sourceMessageHash: run.sourceMessageHash,
		userMessage: userText,
	});
}

export async function recordLearningClassifierRequest(
	run: LearningAuditRun,
	model: Model,
	request: ClassifierRequestDump["request"],
): Promise<LearningAuditClassifierAttempt> {
	const modelId = formatModelId(model);
	const attemptNumber = run.classifierAttempts.length + 1;
	const stem = `classifier-${attemptNumber}-${sanitizeFilePart(modelId)}`;
	const attempt: LearningAuditClassifierAttempt = {
		model: modelId,
		status: "not_run",
		requestPath: path.join(run.auditDir, `${stem}-request.json`),
		responsePath: path.join(run.auditDir, `${stem}-response.json`),
		stopReason: "",
		error: "",
	};
	run.classifierAttempts.push(attempt);
	run.classifierStatus = "not_run";
	await writeAuditJsonToPath(run, attempt.requestPath, { model: modelId, request } satisfies ClassifierRequestDump);
	return attempt;
}

export async function recordLearningClassifierResponse(
	run: LearningAuditRun,
	attempt: LearningAuditClassifierAttempt,
	response: AssistantMessage,
	decision: LearningDecisionSnapshot | undefined,
	statusOverride?: LearningAuditClassifierStatus,
): Promise<void> {
	attempt.status = statusOverride ?? (decision ? "success" : "invalid_response");
	attempt.stopReason = response.stopReason;
	attempt.error = response.errorMessage ?? "";
	attempt.decision = decision;
	run.classifierStatus = attempt.status;
	if (decision) run.decision = decision;
	await writeAuditJsonToPath(run, attempt.responsePath, {
		model: attempt.model,
		response,
		decision,
		status: attempt.status,
		error: attempt.error || undefined,
	} satisfies ClassifierResponseDump);
}

export async function recordLearningClassifierFailure(
	run: LearningAuditRun,
	model: Model | undefined,
	status: Exclude<LearningAuditClassifierStatus, "not_run" | "success" | "invalid_response">,
	error: string,
): Promise<void> {
	const modelId = model ? formatModelId(model) : "";
	let attempt = findPendingClassifierAttempt(run, modelId);
	if (!attempt) {
		attempt = {
			model: modelId,
			status,
			requestPath: "",
			responsePath: modelId
				? path.join(
						run.auditDir,
						`classifier-${run.classifierAttempts.length + 1}-${sanitizeFilePart(modelId)}-error.json`,
					)
				: path.join(run.auditDir, "classifier-error.json"),
			stopReason: "",
			error,
		};
		run.classifierAttempts.push(attempt);
	}
	attempt.status = status;
	attempt.error = error;
	if (!attempt.responsePath) {
		attempt.responsePath = path.join(run.auditDir, "classifier-error.json");
	}
	run.classifierStatus = status;
	await writeAuditJsonToPath(run, attempt.responsePath, {
		model: modelId,
		status,
		error,
	});
}

export async function recordLearningWriterRequest(
	run: LearningAuditRun,
	task: string,
	modelOverride: string[],
	contextFile: string | undefined,
): Promise<void> {
	run.writerRequestPath = path.join(run.auditDir, "writer-request.json");
	await writeAuditJsonToPath(run, run.writerRequestPath, {
		task,
		modelOverride,
		contextFile,
		writerSessionPath: run.writerSessionPath,
		writerOutputPath: run.writerOutputPath,
	} satisfies WriterRequestDump);
}

export async function recordLearningWriterResult(
	run: LearningAuditRun,
	result: SingleResult,
	writerDecision: unknown,
	status: LearningAuditWriterStatus,
): Promise<void> {
	run.writerStatus = status;
	run.writerModel = result.resolvedModel ?? "";
	run.writerExitCode = result.exitCode;
	run.writerOutputPath = result.outputPath ?? run.writerOutputPath;
	run.writerResultPath = path.join(run.auditDir, "writer-result.json");
	await writeAuditJsonToPath(run, run.writerResultPath, { result, writerDecision, status } satisfies WriterResultDump);
}

export async function finalizeLearningAuditRun(
	run: LearningAuditRun,
	outcome: string,
	stored: boolean,
	decision?: LearningDecisionSnapshot,
): Promise<void> {
	run.outcome = outcome;
	run.stored = stored;
	run.updatedAt = Math.floor(Date.now() / 1000);
	if (decision) run.decision = decision;
	await writeAuditJsonToPath(run, run.auditJsonPath, toAuditJson(run));
}

export function toLearningAuditInsert(run: LearningAuditRun): LearningAuditInsert {
	const classifierAttempt = lastClassifierAttempt(run);
	return {
		id: run.id,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		sessionId: run.sessionId,
		cwd: run.cwd,
		sourceMessageHash: run.sourceMessageHash,
		userMessagePreview: run.userMessagePreview,
		scope: run.decision?.scope ?? "",
		trigger: run.decision?.trigger ?? "",
		confidence: run.decision?.confidence ?? null,
		reason: run.decision?.reason ?? "",
		classifierStatus: run.classifierStatus,
		classifierModel: classifierAttempt?.model ?? "",
		classifierError: classifierAttempt?.error ?? "",
		writerStatus: run.writerStatus,
		writerModel: run.writerModel,
		writerExitCode: run.writerExitCode,
		stored: run.stored,
		outcome: run.outcome,
		auditDir: run.auditDir,
		auditJsonPath: run.auditJsonPath,
		classifierRequestPath: classifierAttempt?.requestPath ?? "",
		classifierResponsePath: classifierAttempt?.responsePath ?? "",
		writerRequestPath: run.writerRequestPath,
		writerResultPath: run.writerResultPath,
		writerSessionPath: run.writerSessionPath,
		writerOutputPath: run.writerOutputPath,
	};
}

function toAuditJson(run: LearningAuditRun): Record<string, unknown> {
	return {
		id: run.id,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		sessionId: run.sessionId,
		cwd: run.cwd,
		sourceMessageHash: run.sourceMessageHash,
		userMessagePreview: run.userMessagePreview,
		auditDir: run.auditDir,
		classifierStatus: run.classifierStatus,
		classifierAttempts: run.classifierAttempts,
		writerStatus: run.writerStatus,
		writerModel: run.writerModel,
		writerExitCode: run.writerExitCode,
		writerRequestPath: run.writerRequestPath,
		writerResultPath: run.writerResultPath,
		writerSessionPath: run.writerSessionPath,
		writerOutputPath: run.writerOutputPath,
		stored: run.stored,
		outcome: run.outcome,
		decision: run.decision,
		writeFailures: run.writeFailures,
	};
}

async function writeAuditJson(run: LearningAuditRun, fileName: string, value: unknown): Promise<string | undefined> {
	return writeAuditJsonToPath(run, path.join(run.auditDir, fileName), value);
}

async function writeAuditJsonToPath(
	run: LearningAuditRun,
	filePath: string,
	value: unknown,
): Promise<string | undefined> {
	try {
		await Bun.write(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`);
		return filePath;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		run.writeFailures.push(`${filePath}: ${message}`);
		logger.warn("live-learning: audit write failed", { auditId: run.id, path: filePath, error: message });
		return undefined;
	}
}

function resolveLearningAuditRoot(session: AgentSession, agentDir: string): string {
	const sessionManager = session.sessionManager as {
		getArtifactsDir?: () => string | null;
		getSessionFile?: () => string | undefined;
	};
	const artifactsDir = sessionManager.getArtifactsDir?.();
	if (artifactsDir) return artifactsDir;
	const sessionFile = sessionManager.getSessionFile?.();
	if (sessionFile) return sessionFile.slice(0, -".jsonl".length);
	return agentDir || getLogsDir();
}

function findPendingClassifierAttempt(
	run: LearningAuditRun,
	modelId: string,
): LearningAuditClassifierAttempt | undefined {
	for (let i = run.classifierAttempts.length - 1; i >= 0; i--) {
		const attempt = run.classifierAttempts[i];
		if (attempt.model === modelId && attempt.status === "not_run") return attempt;
	}
	return undefined;
}

function lastClassifierAttempt(run: LearningAuditRun): LearningAuditClassifierAttempt | undefined {
	return run.classifierAttempts[run.classifierAttempts.length - 1];
}

function formatModelId(model: Model): string {
	return `${model.provider}/${model.id}`;
}
function sanitizeFilePart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "model";
}

function truncateForPreview(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= 240 ? normalized : `${normalized.slice(0, 240)}…`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	return value;
}
