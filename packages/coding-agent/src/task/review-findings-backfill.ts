import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ReviewFindingRecordItem, recordReviewFindings } from "@oh-my-pi/omp-stats/review-findings";
import { getAgentDbPath, getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import {
	collectReviewFindingRecordItems,
	isReviewFindingAgent,
	type ReviewFindingSourceResult,
} from "./review-findings";

export interface BackfillReviewFindingsOptions {
	sessionDir?: string;
	agentDbPath?: string;
	repoRoot?: string;
	dryRun?: boolean;
	limitFiles?: number;
}

export interface BackfillReviewFindingsResult {
	sessionFilesScanned: number;
	taskResultsScanned: number;
	reviewerResults: number;
	findingsDiscovered: number;
	findingsWritten: number;
	skippedByRepo: number;
	errors: Array<{ filePath: string; message: string }>;
}

interface SessionHeaderEntry {
	type: "session";
	cwd?: unknown;
	timestamp?: unknown;
}

interface SessionMessageEntry {
	type: "message";
	timestamp?: unknown;
	message?: unknown;
}

interface TaskToolDetails {
	results?: unknown;
}

interface TaskResultLike extends ReviewFindingSourceResult {
	id?: unknown;
	agent?: unknown;
	description?: unknown;
	assignment?: unknown;
	task?: unknown;
	outputPath?: unknown;
	resolvedModel?: unknown;
	exitCode?: unknown;
	aborted?: unknown;
}

interface TaskFindingBatch {
	repoRoot: string;
	repoName: string;
	cwd: string;
	agent: string;
	taskId: string;
	taskDescription: string;
	taskAssignment: string;
	outputPath: string;
	sessionFile: string;
	resolvedModel: string;
	taskExitCode: number;
	taskAborted: boolean;
	findings: ReviewFindingRecordItem[];
}

const DEFAULT_LIMIT_FILES = 10_000;

export async function backfillReviewFindings(
	options: BackfillReviewFindingsOptions = {},
): Promise<BackfillReviewFindingsResult> {
	const sessionDir = options.sessionDir ?? path.join(getAgentDir(), "sessions");
	const agentDbPath = options.agentDbPath ?? getAgentDbPath();
	const dryRun = options.dryRun === true;
	const repoRootFilter = options.repoRoot ? path.resolve(options.repoRoot) : null;
	const result: BackfillReviewFindingsResult = {
		sessionFilesScanned: 0,
		taskResultsScanned: 0,
		reviewerResults: 0,
		findingsDiscovered: 0,
		findingsWritten: 0,
		skippedByRepo: 0,
		errors: [],
	};

	let remainingFiles = options.limitFiles ?? DEFAULT_LIMIT_FILES;
	for await (const sessionFile of findJsonlFiles(sessionDir)) {
		if (remainingFiles <= 0) break;
		remainingFiles -= 1;
		result.sessionFilesScanned += 1;
		try {
			for await (const batch of collectTaskFindingBatches(sessionFile, repoRootFilter)) {
				result.taskResultsScanned += 1;
				if (!isReviewFindingAgent(batch.agent)) continue;
				result.reviewerResults += 1;
				if (repoRootFilter && path.resolve(batch.repoRoot) !== repoRootFilter) {
					result.skippedByRepo += 1;
					continue;
				}
				if (batch.findings.length === 0) continue;
				result.findingsDiscovered += batch.findings.length;
				if (dryRun) continue;
				const findingsWritten = await recordReviewFindings({
					agentDbPath,
					mode: "backfill",
					repoName: batch.repoName,
					repoRoot: batch.repoRoot,
					cwd: batch.cwd,
					agent: batch.agent,
					taskId: batch.taskId,
					taskDescription: batch.taskDescription,
					taskAssignment: batch.taskAssignment,
					outputPath: batch.outputPath,
					sessionFile: batch.sessionFile,
					resolvedModel: batch.resolvedModel,
					taskExitCode: batch.taskExitCode,
					taskAborted: batch.taskAborted,
					findings: batch.findings,
				});
				result.findingsWritten += findingsWritten;
			}
		} catch (err) {
			result.errors.push({ filePath: sessionFile, message: err instanceof Error ? err.message : String(err) });
		}
	}
	return result;
}

async function* collectTaskFindingBatches(
	sessionFile: string,
	repoRootFilter: string | null,
): AsyncGenerator<TaskFindingBatch> {
	let cwd = path.dirname(sessionFile);
	let repoRoot: string | null = null;
	let repoName = "unknown";
	for await (const line of readLines(sessionFile)) {
		const entry = parseJsonLine(line);
		if (!entry) continue;
		if (isSessionHeaderEntry(entry)) {
			cwd = typeof entry.cwd === "string" && entry.cwd.trim().length > 0 ? entry.cwd : cwd;
			repoRoot = await resolveRepoRoot(cwd);
			repoName = path.basename(repoRoot) || path.basename(cwd) || repoRoot;
			continue;
		}
		if (!isSessionMessageEntry(entry)) continue;
		const taskResults = getTaskResults(entry);
		if (!taskResults) continue;
		if (!repoRoot) {
			repoRoot = await resolveRepoRoot(cwd);
			repoName = path.basename(repoRoot) || path.basename(cwd) || repoRoot;
		}
		for (const taskResult of taskResults) {
			const agent = getString(taskResult.agent);
			if (!agent) continue;
			const findings =
				isReviewFindingAgent(agent) && (!repoRootFilter || path.resolve(repoRoot) === repoRootFilter)
					? collectReviewFindingRecordItems(taskResult)
					: [];
			yield {
				repoRoot,
				repoName,
				cwd,
				agent,
				taskId: getString(taskResult.id) ?? "unknown",
				taskDescription: getString(taskResult.description) ?? "",
				taskAssignment: getString(taskResult.assignment) ?? getString(taskResult.task) ?? "",
				outputPath: getString(taskResult.outputPath) ?? "",
				sessionFile,
				resolvedModel: getString(taskResult.resolvedModel) ?? "",
				taskExitCode: getNumber(taskResult.exitCode) ?? 0,
				taskAborted: taskResult.aborted === true,
				findings,
			};
		}
	}
}

async function resolveRepoRoot(cwd: string): Promise<string> {
	try {
		return (await git.repo.root(cwd)) ?? cwd;
	} catch {
		return cwd;
	}
}

function getTaskResults(entry: SessionMessageEntry): TaskResultLike[] | null {
	if (!isRecord(entry.message)) return null;
	if (entry.message.role !== "toolResult" || entry.message.toolName !== "task") return null;
	const details = entry.message.details;
	if (!isRecord(details)) return null;
	const taskDetails = details as TaskToolDetails;
	if (!Array.isArray(taskDetails.results)) return null;
	return taskDetails.results.filter(isRecord).map(value => value as TaskResultLike);
}

async function* findJsonlFiles(root: string): AsyncGenerator<string> {
	let entries: string[];
	try {
		entries = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	entries.sort();
	for (const entry of entries) {
		const filePath = path.join(root, entry);
		const stat = await statPath(filePath);
		if (!stat) continue;
		if (stat.isDirectory()) {
			yield* findJsonlFiles(filePath);
		} else if (stat.isFile() && filePath.endsWith(".jsonl")) {
			yield filePath;
		}
	}
}

async function statPath(filePath: string) {
	try {
		return await fs.stat(filePath);
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function* readLines(filePath: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const stream = Bun.file(filePath).stream();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			yield buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			newlineIndex = buffer.indexOf("\n");
		}
	}
	buffer += decoder.decode();
	if (buffer.length > 0) yield buffer;
}

function parseJsonLine(line: string): unknown {
	if (line.trim().length === 0) return null;
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return null;
	}
}

function isSessionHeaderEntry(value: unknown): value is SessionHeaderEntry {
	return isRecord(value) && value.type === "session";
}

function isSessionMessageEntry(value: unknown): value is SessionMessageEntry {
	return isRecord(value) && value.type === "message";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
