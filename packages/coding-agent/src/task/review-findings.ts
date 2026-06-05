import * as path from "node:path";
import { type ReviewFindingRecordItem, recordReviewFindings } from "@oh-my-pi/omp-stats/review-findings";
import { logger } from "@oh-my-pi/pi-utils";
import type { ReportFindingDetails } from "../tools/review";
import * as git from "../utils/git";
import type { SingleResult } from "./types";

const REVIEW_FINDING_AGENTS: Record<string, true> = { reviewer: true, "code-reviewer": true };
const REVIEW_FINDING_PRIORITIES: Record<string, ReviewFindingRecordItem["priority"]> = {
	P0: "P0",
	P1: "P1",
	P2: "P2",
	P3: "P3",
};

export interface PersistTaskReviewFindingsOptions {
	agentName: string;
	cwd: string;
	sessionFile: string | null;
	results: SingleResult[];
}

export function isReviewFindingAgent(agentName: string): boolean {
	return REVIEW_FINDING_AGENTS[agentName] === true;
}

export async function persistTaskReviewFindings(options: PersistTaskReviewFindingsOptions): Promise<void> {
	if (!isReviewFindingAgent(options.agentName)) return;

	const findingsByResult = options.results.map(result => ({
		result,
		findings: collectReviewFindingRecordItems(result),
	}));
	if (!findingsByResult.some(entry => entry.findings.length > 0)) return;

	try {
		const repoRoot = (await git.repo.root(options.cwd)) ?? options.cwd;
		const repoName = path.basename(repoRoot) || path.basename(options.cwd) || repoRoot;
		const nowSec = Math.floor(Date.now() / 1000);
		for (const entry of findingsByResult) {
			if (entry.findings.length === 0) continue;
			await recordReviewFindings({
				nowSec,
				repoName,
				repoRoot,
				cwd: options.cwd,
				agent: options.agentName,
				taskId: entry.result.id,
				taskDescription: entry.result.description ?? "",
				taskAssignment: entry.result.assignment ?? "",
				outputPath: entry.result.outputPath ?? "",
				sessionFile: options.sessionFile ?? "",
				resolvedModel: entry.result.resolvedModel ?? "",
				taskExitCode: entry.result.exitCode,
				taskAborted: Boolean(entry.result.aborted),
				findings: entry.findings,
			});
		}
	} catch (err) {
		logger.warn("Task reviewer findings persistence failed", {
			agent: options.agentName,
			cwd: options.cwd,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export interface ReviewFindingSourceResult {
	output?: string;
	extractedToolData?: Record<string, unknown[]>;
}

export function collectReviewFindingRecordItems(result: ReviewFindingSourceResult): ReviewFindingRecordItem[] {
	const findings: ReviewFindingRecordItem[] = [];
	const rawReportFindings = result.extractedToolData?.report_finding;
	if (Array.isArray(rawReportFindings)) {
		for (const item of rawReportFindings) {
			const parsed = parseReportFinding(item);
			if (parsed) findings.push(parsed);
		}
	}

	const rawYieldData = result.extractedToolData?.yield;
	if (Array.isArray(rawYieldData)) {
		for (const item of rawYieldData) {
			findings.push(...collectReviewFindingItemsFromReviewData(readYieldData(item)));
		}
	}

	const outputData = parseOutputJson(result.output);
	if (outputData !== undefined) {
		findings.push(...collectReviewFindingItemsFromReviewData(outputData));
	}

	return dedupeFindings(findings);
}

export function collectReviewFindingItemsFromReviewData(data: unknown): ReviewFindingRecordItem[] {
	const direct = parseReportFinding(data);
	if (direct) return [direct];
	if (Array.isArray(data)) return dedupeFindings(data.flatMap(item => collectReviewFindingItemsFromReviewData(item)));
	if (!isRecord(data)) return [];

	const findings: ReviewFindingRecordItem[] = [];
	const groups: Array<{ key: string; priority: ReviewFindingRecordItem["priority"] }> = [
		{ key: "blockers", priority: "P1" },
		{ key: "issues", priority: "P2" },
		{ key: "important_non_blocking", priority: "P2" },
		{ key: "important_non_blocking_issues", priority: "P2" },
		{ key: "non_blocking", priority: "P3" },
		{ key: "non_blocking_issues", priority: "P3" },
		{ key: "missing_tests", priority: "P2" },
		{ key: "findings", priority: "P2" },
	];
	for (const group of groups) {
		const value = data[group.key];
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			const parsed = parseReviewIssue(item, group.priority);
			if (parsed) findings.push(parsed);
		}
	}
	return dedupeFindings(findings);
}

function readYieldData(value: unknown): unknown {
	if (!isRecord(value)) return value;
	return "data" in value ? value.data : value;
}

function parseOutputJson(output: string | undefined): unknown {
	if (!output) return undefined;
	const trimmed = output.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function parseReviewIssue(
	value: unknown,
	fallbackPriority: ReviewFindingRecordItem["priority"],
): ReviewFindingRecordItem | null {
	const direct = parseReportFinding(value);
	if (direct) return direct;
	if (!isRecord(value)) return null;
	const title = getString(value, "title") ?? getString(value, "description");
	if (!title) return null;
	const filePath = normalizeFindingFilePath(
		getString(value, "file_path") ??
			getString(value, "file") ??
			getString(value, "path") ??
			getStringArrayFirst(value, "files"),
	);
	if (!filePath) return null;
	const lineRange = parseLineRange(value);
	const priority = normalizePriority(value.priority ?? value.severity, fallbackPriority);
	const body = buildReviewIssueBody(value);
	return {
		title,
		body,
		priority,
		confidence: normalizeConfidence(value.confidence),
		file_path: filePath,
		line_start: lineRange.lineStart,
		line_end: lineRange.lineEnd,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getStringArrayFirst(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (!Array.isArray(value)) return undefined;
	for (const item of value) {
		if (typeof item === "string" && item.trim().length > 0) return item.trim();
	}
	return undefined;
}

function normalizeFindingFilePath(value: string | undefined): string | null {
	if (!value) return null;
	const first = value.split(";")[0]?.trim();
	return first && first.length > 0 ? first : null;
}

function buildReviewIssueBody(record: Record<string, unknown>): string {
	const sections: string[] = [];
	const body = getString(record, "body");
	if (body) sections.push(body);
	for (const [label, key] of [
		["Description", "description"],
		["Why", "why"],
		["Impact", "impact"],
		["Fix", "fix"],
		["Suggestion", "suggestion"],
		["Rationale", "rationale"],
	] as const) {
		const value = getString(record, key);
		if (value) sections.push(`${label}: ${value}`);
	}
	const files = getStringArrayFirst(record, "files");
	if (files) sections.push(`Files: ${files}`);
	const lines = getString(record, "lines");
	if (lines) sections.push(`Lines: ${lines}`);
	return sections.length > 0 ? sections.join("\n") : "Reviewer reported this finding without additional details.";
}

function normalizePriority(
	value: unknown,
	fallback: ReviewFindingRecordItem["priority"],
): ReviewFindingRecordItem["priority"] {
	if (typeof value === "string") {
		const direct = REVIEW_FINDING_PRIORITIES[value.toUpperCase()];
		if (direct) return direct;
		const severity = value.toLowerCase();
		if (severity === "critical" || severity === "blocker") return "P0";
		if (severity === "high" || severity === "important" || severity === "major") return "P1";
		if (severity === "medium" || severity === "moderate") return "P2";
		if (severity === "low" || severity === "minor" || severity === "nit") return "P3";
	}
	if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3) {
		return `P${value}` as ReviewFindingRecordItem["priority"];
	}
	return fallback;
}

function normalizeConfidence(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0.8;
	if (value >= 0 && value <= 1) return value;
	if (value > 1 && value <= 100) return value / 100;
	return 0.8;
}

function parseLineRange(record: Record<string, unknown>): { lineStart: number; lineEnd: number } {
	const direct = parseNumericLineRange(record.line_start, record.line_end);
	if (direct) return direct;
	for (const key of ["lines", "line", "lineRange", "line_range"]) {
		const value = record[key];
		const numeric = parseNumericLineRange(value, value);
		if (numeric) return numeric;
		const parsed = parseLineRangeString(value);
		if (parsed) return parsed;
	}
	return { lineStart: 1, lineEnd: 1 };
}

function parseNumericLineRange(lineStart: unknown, lineEnd: unknown): { lineStart: number; lineEnd: number } | null {
	if (typeof lineStart !== "number") return null;
	const end = typeof lineEnd === "number" ? lineEnd : lineStart;
	if (!hasValidLineRange(lineStart, end)) return null;
	return { lineStart, lineEnd: end };
}

function parseLineRangeString(value: unknown): { lineStart: number; lineEnd: number } | null {
	if (typeof value !== "string") return null;
	const match = value.match(/(\d+)(?:\s*[-:]\s*(\d+))?/);
	if (!match) return null;
	const lineStart = Number(match[1]);
	const lineEnd = match[2] ? Number(match[2]) : lineStart;
	if (!hasValidLineRange(lineStart, lineEnd)) return null;
	return { lineStart, lineEnd };
}

function dedupeFindings(findings: ReviewFindingRecordItem[]): ReviewFindingRecordItem[] {
	const seen = new Set<string>();
	const result: ReviewFindingRecordItem[] = [];
	for (const finding of findings) {
		const key = [
			finding.priority,
			finding.title.trim().toLowerCase(),
			finding.body.trim().toLowerCase(),
			finding.file_path.trim().toLowerCase(),
			finding.line_start,
			finding.line_end,
		].join("\u0000");
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(finding);
	}
	return result;
}

function hasValidLineRange(lineStart: number, lineEnd: number): boolean {
	return Number.isInteger(lineStart) && Number.isInteger(lineEnd) && lineStart > 0 && lineEnd >= lineStart;
}

function parseReportFinding(value: unknown): ReviewFindingRecordItem | null {
	if (!isRecord(value)) return null;
	const record = value as Partial<ReportFindingDetails>;
	const priority = typeof record.priority === "string" ? REVIEW_FINDING_PRIORITIES[record.priority] : undefined;
	if (
		typeof record.title !== "string" ||
		typeof record.body !== "string" ||
		priority === undefined ||
		typeof record.confidence !== "number" ||
		!Number.isFinite(record.confidence) ||
		typeof record.file_path !== "string" ||
		typeof record.line_start !== "number" ||
		typeof record.line_end !== "number" ||
		!hasValidLineRange(record.line_start, record.line_end)
	) {
		return null;
	}
	return {
		title: record.title,
		body: record.body,
		priority,
		confidence: record.confidence,
		file_path: record.file_path,
		line_start: record.line_start,
		line_end: record.line_end,
	};
}
