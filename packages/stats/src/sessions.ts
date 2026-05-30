import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { getSessionAggregates, initDb } from "./db";
import type { SessionListResponse, SessionStatsAggregate, SessionSummary, SessionTrace, TraceNode } from "./types";

const SESSION_SUFFIX = ".jsonl";
const SESSION_PREFIX_BYTES = 512 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_TRACE_DEPTH = 4;
const MAX_TRACE_DEPTH = 8;
const DEFAULT_TRACE_SUBTRACES = 80;
const MAX_TRACE_SUBTRACES = 300;

interface JsonRecord {
	[key: string]: unknown;
}

interface SessionListOptions {
	query?: string | null;
	limit?: number | null;
	offset?: number | null;
	includeSubagents?: boolean;
}

interface SessionTraceOptions {
	maxDepth?: number | null;
	maxSubtraces?: number | null;
}

interface DirectoryEntry {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

interface LoadTraceContext {
	aggregates: Map<string, SessionStatsAggregate>;
	seen: Set<string>;
	maxDepth: number;
	maxSubtraces: number;
	loadedSubtraces: { count: number };
}

interface ParsedSessionSummary {
	header: JsonRecord | null;
	sessionInit: JsonRecord | null;
	firstUserMessage?: string;
	messageCount: number;
	userMessageCount: number;
	assistantMessageCount: number;
	toolResultCount: number;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: JsonRecord | null | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dateMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.length === 0) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInt(value: number | null | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}
const TRACE_OMIT_KEYS = new Set(["providerPayload", "thinkingSignature", "textSignature", "thoughtSignature"]);

function pruneTraceValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(pruneTraceValue);
	if (!isRecord(value)) return value;
	const pruned: JsonRecord = {};
	for (const [key, child] of Object.entries(value)) {
		if (TRACE_OMIT_KEYS.has(key)) continue;
		if (value.type === "image" && key === "data") {
			pruned[key] = "[image data omitted]";
			continue;
		}
		pruned[key] = pruneTraceValue(child);
	}
	return pruned;
}

function parseJsonl(text: string): JsonRecord[] {
	const entries: JsonRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isRecord(parsed)) entries.push(parsed);
		} catch {
			// Session files are append-only and may end with a partial JSONL row.
		}
	}
	return entries;
}

async function readPrefix(filePath: string, maxBytes: number): Promise<string> {
	const file = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
}

async function readDirectoryEntries(dir: string): Promise<DirectoryEntry[]> {
	return (await fs.readdir(dir, { withFileTypes: true })) as DirectoryEntry[];
}

async function listRootSessionFiles(): Promise<string[]> {
	const sessionsDir = getSessionsDir();
	let projectDirs: DirectoryEntry[];
	try {
		projectDirs = await readDirectoryEntries(sessionsDir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const files: string[] = [];
	for (const projectDir of projectDirs) {
		if (!projectDir.isDirectory()) continue;
		const dirPath = path.join(sessionsDir, projectDir.name);
		let entries: DirectoryEntry[];
		try {
			entries = await readDirectoryEntries(dirPath);
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(SESSION_SUFFIX)) {
				files.push(path.join(dirPath, entry.name));
			}
		}
	}
	files.sort();
	return files;
}

async function listDirectSubagentFiles(sessionFile: string): Promise<string[]> {
	const dir = sessionArtifactsDir(sessionFile);
	let entries: DirectoryEntry[];
	try {
		entries = await readDirectoryEntries(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const files = entries
		.filter(entry => entry.isFile() && entry.name.endsWith(SESSION_SUFFIX))
		.map(entry => path.join(dir, entry.name));
	files.sort();
	return files;
}

async function listAllSubagentFiles(sessionFile: string): Promise<string[]> {
	const direct = await listDirectSubagentFiles(sessionFile);
	const nested: string[] = [];
	for (const child of direct) {
		nested.push(child);
		nested.push(...(await listAllSubagentFiles(child)));
	}
	return nested;
}

function sessionArtifactsDir(sessionFile: string): string {
	return sessionFile.endsWith(SESSION_SUFFIX)
		? sessionFile.slice(0, -SESSION_SUFFIX.length)
		: `${sessionFile}.artifacts`;
}

function sessionFileTaskId(sessionFile: string): string | undefined {
	const name = path.basename(sessionFile, SESSION_SUFFIX);
	return name.length > 0 ? name : undefined;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		const type = block.type;
		if (type === "text" && typeof block.text === "string") parts.push(block.text);
		if (type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
		if (type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

function summarizeText(text: string, maxLength = 240): string {
	const normalized = text
		.replace(/[\t\r\n]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

function getMessage(entry: JsonRecord): JsonRecord | null {
	const message = entry.message;
	return isRecord(message) ? message : null;
}

function getMessageRole(entry: JsonRecord): string | undefined {
	return stringField(getMessage(entry), "role");
}

function getEntryTimestamp(entry: JsonRecord): number | undefined {
	return dateMs(entry.timestamp) ?? dateMs(getMessage(entry)?.timestamp);
}

function getToolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "toolCall") continue;
		const name = stringField(block, "name");
		if (name) names.push(name);
	}
	return names;
}

function summarizeEntry(entry: JsonRecord): { title: string; preview: string; role?: string; timestamp?: number } {
	const type = stringField(entry, "type") ?? "unknown";
	const timestamp = getEntryTimestamp(entry);
	if (type === "message") {
		const message = getMessage(entry);
		const role = stringField(message, "role") ?? "message";
		if (role === "assistant") {
			const text = summarizeText(extractText(message?.content));
			if (text) return { title: "assistant", preview: text, role, timestamp };
			const toolNames = getToolCallNames(message?.content);
			if (toolNames.length > 0)
				return { title: "assistant", preview: `tool calls: ${toolNames.join(", ")}`, role, timestamp };
			const error = stringField(message, "errorMessage");
			return { title: "assistant", preview: error ?? "No visible assistant text", role, timestamp };
		}
		if (role === "toolResult") {
			const toolName = stringField(message, "toolName") ?? "tool";
			const text = summarizeText(extractText(message?.content));
			return {
				title: toolName,
				preview: text || (message?.isError ? "Tool failed" : "Tool completed"),
				role,
				timestamp,
			};
		}
		const text = summarizeText(extractText(message?.content));
		return { title: role, preview: text, role, timestamp };
	}
	if (type === "session_init") {
		return {
			title: "session init",
			preview: summarizeText(stringField(entry, "task") ?? "Subagent initialization"),
			timestamp,
		};
	}
	if (type === "compaction") {
		return {
			title: "compaction",
			preview: summarizeText(
				stringField(entry, "shortSummary") ?? stringField(entry, "summary") ?? "Compacted context",
			),
			timestamp,
		};
	}
	if (type === "branch_summary") {
		return { title: "branch summary", preview: summarizeText(stringField(entry, "summary") ?? ""), timestamp };
	}
	if (type === "custom_message") {
		const customType = stringField(entry, "customType") ?? "custom";
		return { title: customType, preview: summarizeText(extractText(entry.content)), timestamp };
	}
	if (type === "model_change") {
		return { title: "model", preview: stringField(entry, "model") ?? "", timestamp };
	}
	if (type === "thinking_level_change") {
		return { title: "thinking", preview: stringField(entry, "thinkingLevel") ?? "off", timestamp };
	}
	return { title: type, preview: "", timestamp };
}

function parseSessionSummary(entries: JsonRecord[]): ParsedSessionSummary {
	let header: JsonRecord | null = null;
	let sessionInit: JsonRecord | null = null;
	let firstUserMessage: string | undefined;
	let messageCount = 0;
	let userMessageCount = 0;
	let assistantMessageCount = 0;
	let toolResultCount = 0;

	for (const entry of entries) {
		const type = stringField(entry, "type");
		if (!header && type === "session") header = entry;
		if (!sessionInit && type === "session_init") sessionInit = entry;
		if (type !== "message") continue;
		messageCount++;
		const role = getMessageRole(entry);
		if (role === "user") {
			userMessageCount++;
			firstUserMessage ??= summarizeText(extractText(getMessage(entry)?.content), 320);
		} else if (role === "assistant") {
			assistantMessageCount++;
		} else if (role === "toolResult") {
			toolResultCount++;
		}
	}

	return {
		header,
		sessionInit,
		firstUserMessage,
		messageCount,
		userMessageCount,
		assistantMessageCount,
		toolResultCount,
	};
}

async function readSummary(
	sessionFile: string,
	aggregates: Map<string, SessionStatsAggregate>,
	childCount: number,
	depth: number,
	parentPath?: string,
	parentTaskId?: string,
	fullEntries?: JsonRecord[],
): Promise<SessionSummary | null> {
	let entries = fullEntries;
	if (!entries) {
		try {
			entries = parseJsonl(await readPrefix(sessionFile, SESSION_PREFIX_BYTES));
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}
	const parsed = parseSessionSummary(entries);
	if (!parsed.header) return null;
	const stat = await fs.stat(sessionFile);
	const created = dateMs(parsed.header.timestamp) ?? stat.birthtimeMs;
	const modified = stat.mtimeMs;
	const stats = aggregates.get(sessionFile);
	const agentName = parentTaskId ? parentTaskId.replace(/^\d+-/, "") : undefined;
	const task = stringField(parsed.sessionInit, "task");
	const title = stringField(parsed.header, "title") ?? (depth > 0 ? task : undefined);
	return {
		id: stringField(parsed.header, "id") ?? sessionFile,
		path: sessionFile,
		...(title ? { title } : {}),
		cwd: stringField(parsed.header, "cwd") ?? "",
		created,
		modified,
		size: stat.size,
		depth,
		...(parentPath ? { parentPath } : {}),
		...(parentTaskId ? { parentTaskId } : {}),
		...(agentName ? { agentName } : {}),
		...(task ? { task } : {}),
		...(parsed.firstUserMessage ? { firstUserMessage: parsed.firstUserMessage } : {}),
		messageCount: parsed.messageCount,
		userMessageCount: parsed.userMessageCount,
		assistantMessageCount: Math.max(parsed.assistantMessageCount, stats?.totalRequests ?? 0),
		toolResultCount: parsed.toolResultCount,
		subagentCount: childCount,
		...(stats ? { stats } : {}),
	};
}

function searchableText(summary: SessionSummary): string {
	return [
		summary.id,
		summary.path,
		summary.cwd,
		summary.title,
		summary.agentName,
		summary.task,
		summary.firstUserMessage,
		summary.stats?.models.join(" "),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

async function countDirectChildren(sessionFile: string): Promise<number> {
	return (await listDirectSubagentFiles(sessionFile)).length;
}

async function buildSummaryForFile(
	sessionFile: string,
	aggregates: Map<string, SessionStatsAggregate>,
	depth: number,
	parentPath?: string,
): Promise<SessionSummary | null> {
	const childCount = await countDirectChildren(sessionFile);
	const taskId = depth > 0 ? sessionFileTaskId(sessionFile) : undefined;
	return readSummary(sessionFile, aggregates, childCount, depth, parentPath, taskId);
}
export async function listSessions(options: SessionListOptions = {}): Promise<SessionListResponse> {
	await initDb();
	const aggregates = getSessionAggregates();
	const rootFiles = await listRootSessionFiles();
	let files = rootFiles;
	if (options.includeSubagents) {
		const childGroups = await Promise.all(rootFiles.map(root => listAllSubagentFiles(root)));
		files = [...rootFiles, ...childGroups.flat()];
	}
	const summaries = (
		await Promise.all(
			files.map(file =>
				buildSummaryForFile(file, aggregates, options.includeSubagents && !rootFiles.includes(file) ? 1 : 0),
			),
		)
	).filter((summary): summary is SessionSummary => summary !== null);

	const query = options.query?.trim().toLowerCase();
	const filtered = query ? summaries.filter(summary => searchableText(summary).includes(query)) : summaries;
	filtered.sort((a, b) => b.modified - a.modified);
	const total = filtered.length;
	const offset = clampInt(options.offset, 0, 0, Math.max(0, total));
	const limit = clampInt(options.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
	return { sessions: filtered.slice(offset, offset + limit), total };
}

function resultSessionFile(result: unknown): string | undefined {
	if (!isRecord(result)) return undefined;
	return stringField(result, "sessionFile");
}

function resultId(result: unknown): string | undefined {
	if (!isRecord(result)) return undefined;
	return stringField(result, "id");
}

function findTaskResultEntryId(
	entries: JsonRecord[],
	childSessionFile: string,
	childTaskId: string | undefined,
): string | undefined {
	for (const entry of entries) {
		if (stringField(entry, "type") !== "message") continue;
		const message = getMessage(entry);
		if (stringField(message, "role") !== "toolResult" || stringField(message, "toolName") !== "task") continue;
		const details = message?.details;
		if (!isRecord(details) || !Array.isArray(details.results)) continue;
		for (const result of details.results) {
			if (resultSessionFile(result) === childSessionFile) return stringField(entry, "id");
			if (childTaskId && resultId(result) === childTaskId) return stringField(entry, "id");
		}
	}
	return undefined;
}

function buildTraceNodes(entries: JsonRecord[], subtracesByEntryId: Map<string, SessionTrace[]>): TraceNode[] {
	const nodesById = new Map<string, TraceNode>();
	const roots: TraceNode[] = [];
	let syntheticId = 0;
	for (const entry of entries) {
		const type = stringField(entry, "type");
		if (!type || type === "session") continue;
		const id = stringField(entry, "id") ?? `entry-${syntheticId++}`;
		const parentIdValue = entry.parentId;
		const parentId = typeof parentIdValue === "string" && parentIdValue.length > 0 ? parentIdValue : null;
		const summary = summarizeEntry(entry);
		nodesById.set(id, {
			id,
			parentId,
			type,
			...(summary.role ? { role: summary.role } : {}),
			...(summary.timestamp !== undefined ? { timestamp: summary.timestamp } : {}),
			title: summary.title,
			preview: summary.preview,
			entry: pruneTraceValue(entry),
			children: [],
			subtraces: subtracesByEntryId.get(id) ?? [],
		});
	}
	for (const node of nodesById.values()) {
		if (node.parentId) {
			const parent = nodesById.get(node.parentId);
			if (parent) {
				parent.children.push(node);
				continue;
			}
		}
		roots.push(node);
	}
	return roots;
}

async function loadTrace(
	sessionFile: string,
	context: LoadTraceContext,
	depth: number,
	parentPath?: string,
): Promise<SessionTrace | null> {
	const resolved = path.resolve(sessionFile);
	if (context.seen.has(resolved)) return null;
	context.seen.add(resolved);
	let entries: JsonRecord[];
	try {
		entries = parseJsonl(await Bun.file(resolved).text());
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	const childFiles = depth >= context.maxDepth ? [] : await listDirectSubagentFiles(resolved);
	const childTraces: Array<{ trace: SessionTrace; attachEntryId?: string }> = [];
	let truncatedSubtraces = false;
	for (const childFile of childFiles) {
		if (context.loadedSubtraces.count >= context.maxSubtraces) {
			truncatedSubtraces = true;
			break;
		}
		context.loadedSubtraces.count++;
		const childTaskId = sessionFileTaskId(childFile);
		const childTrace = await loadTrace(childFile, context, depth + 1, resolved);
		if (!childTrace) continue;
		const attachEntryId = findTaskResultEntryId(entries, path.resolve(childFile), childTaskId);
		childTraces.push({ trace: childTrace, attachEntryId });
	}
	const summary = await readSummary(
		resolved,
		context.aggregates,
		childFiles.length,
		depth,
		parentPath,
		depth > 0 ? sessionFileTaskId(resolved) : undefined,
		entries,
	);
	if (!summary) return null;
	const byEntry = new Map<string, SessionTrace[]>();
	const orphanSubtraces: SessionTrace[] = [];
	for (const child of childTraces) {
		if (child.attachEntryId) {
			const list = byEntry.get(child.attachEntryId) ?? [];
			list.push(child.trace);
			byEntry.set(child.attachEntryId, list);
		} else {
			orphanSubtraces.push(child.trace);
		}
	}
	return {
		summary,
		nodes: buildTraceNodes(entries, byEntry),
		flatEntryCount: entries.filter(entry => stringField(entry, "type") !== "session").length,
		orphanSubtraces,
		truncatedSubtraces,
	};
}

export async function getSessionTrace(
	sessionFile: string,
	options: SessionTraceOptions = {},
): Promise<SessionTrace | null> {
	await initDb();
	const maxDepth = clampInt(options.maxDepth, DEFAULT_TRACE_DEPTH, 0, MAX_TRACE_DEPTH);
	const maxSubtraces = clampInt(options.maxSubtraces, DEFAULT_TRACE_SUBTRACES, 0, MAX_TRACE_SUBTRACES);
	return loadTrace(
		sessionFile,
		{
			aggregates: getSessionAggregates(),
			seen: new Set<string>(),
			maxDepth,
			maxSubtraces,
			loadedSubtraces: { count: 0 },
		},
		0,
	);
}
