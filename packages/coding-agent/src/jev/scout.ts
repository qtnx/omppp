import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, blockRangeAt, listWorkspace, sourceDeclarations, summarizeCode } from "@oh-my-pi/pi-natives";
import { redactMemorySecrets, redactNested } from "../memory-backend/redact";
import {
	JevError,
	jevAvailable,
	jevModel,
	postSystemOne,
	type JevChoiceQuestion,
	type JevNoulQuestion,
	type JevRequest,
	type JevResponse,
	validateChoice,
	validateNoul,
} from "./systemone";
import scoutLocationInstructions from "../prompts/jev/scout-location.md" with { type: "text" };
import scoutLocationPresenceInstructions from "../prompts/jev/scout-location-presence.md" with { type: "text" };
import scoutNavigationInstructions from "../prompts/jev/scout-navigation.md" with { type: "text" };
import scoutPresenceInstructions from "../prompts/jev/scout-presence.md" with { type: "text" };

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_VISITS = 8;
/** Outline rows offered per file before the per-request ranking share is applied. */
const MAX_OUTLINE_ROWS_PER_FILE = 600;
const MAX_CHILDREN_PER_REQUEST = 200;
const MAX_LOCATION_CHOICES = 254;
const MAX_LOCATION_ROUNDS = 3;
const MAX_STATE_BYTES_PER_REQUEST = 32 * 1024;
const MAX_STATE_BYTES_PER_CALL = 192 * 1024;
/** Heuristic rejection threshold; no_match never proves repository-wide absence. */
const LOCATION_PRESENCE_FLOOR = 0.35;
const MAX_EXCERPT_LINES = 100;
const MAX_TOTAL_EXCERPT_CHARS = 16_000;
const DEFAULT_MAX_FILES = 3;
/**
 * Body mode is explicit; this cap limits one detailed outline request.
 */
const DETAILED_RETRY_MAX_LINES = 400;
const NONE_ID = "NONE";

type ScoutStats = {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	stateBytes: number;
	locationRounds: number;
	rankedLocations: Set<string>;
};

type ChildEntry = {
	id: string;
	path: string;
	kind: "file" | "directory";
};
type SourceCandidate = {
	startLine: number;
	endLine: number;
	/** Header candidates already carry an exact native declaration range. */
	exact?: boolean;
	searchText?: string;
};

type ReadSource = {
	path: string;
	code: string;
	lines: string[];
	candidates: SourceCandidate[];
	outline: string;
	mode: OutlineMode;
	truncated: boolean;
};

type LocationCandidate = SourceCandidate & {
	fileIndex: number;
	file: ReadSource;
};
class ScoutStateBudgetExceeded extends Error {
	constructor(
		readonly bytes: number,
		readonly cumulative: number,
	) {
		super("Scout serialized state budget exceeded");
	}
}

export type ScoutSourceDetail = "headers" | "outline" | "bodies";

export interface ScoutInput {
	query: string;
	path: string;
	maxFiles?: number;
	/** How much local source may leave the machine per inspected file. Default `headers`. */
	sourceDetail?: ScoutSourceDetail;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	redact?: (text: string) => string;
}

export interface ScoutExcerpt {
	path: string;
	startLine: number;
	endLine: number;
	text: string;
}

export interface ScoutResult {
	status: "found" | "no_match";
	excerpts: ScoutExcerpt[];
	filesRead: number;
	directoriesVisited: number;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	truncated: boolean;
	warnings: string[];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function validateInput(input: ScoutInput): number {
	if (!input.query.trim()) throw new Error("Scout query must not be empty or whitespace");
	if (!path.isAbsolute(input.path)) throw new Error(`Scout path must be absolute: ${input.path}`);
	const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
	if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 8) {
		throw new Error(`Scout maxFiles must be an integer from 1 to 8 (received ${String(input.maxFiles)})`);
	}
	const detail = input.sourceDetail;
	if (detail !== undefined && detail !== "headers" && detail !== "outline" && detail !== "bodies") {
		throw new Error(`Scout sourceDetail must be one of headers, outline, bodies (received ${String(detail)})`);
	}
	return maxFiles;
}

async function inspectInputPath(inputPath: string): Promise<"file" | "directory"> {
	let stat: Stats;
	try {
		stat = await fs.stat(inputPath);
	} catch (error) {
		throw new Error(
			`Scout path is missing or inaccessible: ${inputPath} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "directory";
	throw new Error(`Scout path must be a regular file or directory: ${inputPath}`);
}

function addWarning(warnings: string[], warning: string): void {
	if (!warnings.includes(warning)) warnings.push(warning);
}

function addUsage(stats: ScoutStats, response: JevResponse): void {
	const inputTokens = response.usage?.input_tokens;
	const outputTokens = response.usage?.output_tokens;
	if (typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens >= 0) {
		stats.inputTokens += inputTokens;
	}
	if (typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0) {
		stats.outputTokens += outputTokens;
	}
}

function redactState(state: unknown, input: ScoutInput): unknown {
	const redact = input.redact ? (text: string) => redactMemorySecrets(input.redact!(text)) : redactMemorySecrets;
	return redactNested(state, redact);
}
async function askJev(
	input: ScoutInput,
	body: JevRequest,
	stats: ScoutStats,
	warnings: string[],
): Promise<JevResponse> {
	throwIfAborted(input.signal);
	const state = redactState(body.state, input);
	const serializedState = JSON.stringify(state);
	const bytes = new TextEncoder().encode(serializedState).byteLength;
	if (bytes > MAX_STATE_BYTES_PER_REQUEST || stats.stateBytes + bytes > MAX_STATE_BYTES_PER_CALL) {
		addWarning(
			warnings,
			`Search stopped before sending oversized serialized state (${bytes} bytes this request, ${stats.stateBytes + bytes} bytes this call)`,
		);
		throw new ScoutStateBudgetExceeded(bytes, stats.stateBytes + bytes);
	}
	stats.stateBytes += bytes;
	stats.requests += 1;
	const response = await postSystemOne({ ...body, state }, { fetchImpl: input.fetchImpl, signal: input.signal });
	addUsage(stats, response);
	return response;
}

/** Paths in the outbound state are relative to the scout root: the endpoint never sees the home directory or the checkout name. */
function statePath(root: string, absolute: string): string {
	return path.relative(root, absolute) || ".";
}

/**
 * One request per listing: a Choice ranking the observed child ids and a Noul
 * asking whether this listing leads anywhere at all. Question ids are not sent
 * to the model, so per-entry Nouls would all be the same question; the Choice
 * distribution carries the per-entry signal instead.
 */
function makeNavigationRequest(root: string, directory: string, query: string, entries: ChildEntry[]): JevRequest {
	const criteria: Record<string, string | null> = { [NONE_ID]: null };
	for (const entry of entries) criteria[entry.id] = null;
	const pick: JevChoiceQuestion = {
		type: "choice",
		instructions: scoutNavigationInstructions,
		criteria,
	};
	const present: JevNoulQuestion = {
		type: "noul",
		instructions: scoutPresenceInstructions,
	};
	return {
		model: jevModel(),
		state: {
			query,
			directory: statePath(root, directory),
			entries: entries.map(entry => ({ id: entry.id, path: statePath(root, entry.path), kind: entry.kind })),
		},
		questions: { "navigation::pick": pick, "navigation::present": present },
	};
}

function makeLocationRequest(
	root: string,
	query: string,
	files: ReadSource[],
	page: LocationCandidate[],
): {
	request: JevRequest;
	candidates: Map<string, LocationCandidate>;
} {
	const criteria: Record<string, string | null> = { [NONE_ID]: null };
	const candidates = new Map<string, LocationCandidate>();
	const stateFiles: Array<{ id: string; path: string; outline: string }> = [];
	const keptByFile = new Map<number, Set<number>>();
	for (const candidate of page) {
		const lines = keptByFile.get(candidate.fileIndex) ?? new Set<number>();
		lines.add(candidate.startLine);
		keptByFile.set(candidate.fileIndex, lines);
	}
	for (const [fileIndex, file] of files.entries()) {
		const fileId = `f${fileIndex}`;
		const keptLines = keptByFile.get(fileIndex) ?? new Set<number>();
		const outline = file.outline
			.split("\n")
			.filter(row => keptLines.has(Number.parseInt(row, 10)))
			.join("\n");
		stateFiles.push({ id: fileId, path: statePath(root, file.path), outline });
	}
	for (const candidate of page) {
		const id = `f${candidate.fileIndex}:l${candidate.startLine}`;
		candidates.set(id, candidate);
		criteria[id] = null;
	}
	return {
		request: {
			model: jevModel(),
			state: { query, files: stateFiles },
			questions: {
				"location::pick": { type: "choice", instructions: scoutLocationInstructions, criteria },
				"location::present": { type: "noul", instructions: scoutLocationPresenceInstructions },
			},
		},
		candidates,
	};
}

function sortedEntries(directory: string, entries: Array<{ path: string; fileType: FileType }>): ChildEntry[] {
	return entries
		.map((entry, index) => ({
			id: `e${index}`,
			path: path.isAbsolute(entry.path) ? entry.path : path.resolve(directory, entry.path),
			kind: entry.fileType === FileType.Dir ? ("directory" as const) : ("file" as const),
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
}

function queryTokens(value: string): Set<string> {
	return new Set(
		value
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean),
	);
}

function tokenOverlap(querySet: Set<string>, text: string): number {
	let score = 0;
	for (const token of queryTokens(text)) {
		if (querySet.has(token)) score += 1;
	}
	return score;
}

function callableKind(kind: string): number {
	return /function|method|constructor|procedure|handler|arrow|callable/i.test(kind) ? 1 : 0;
}

function navigationScore(query: string, entry: ChildEntry): number {
	return tokenOverlap(queryTokens(query), path.basename(entry.path));
}

async function chooseNavigation(
	input: ScoutInput,
	root: string,
	directory: string,
	entries: ChildEntry[],
	stats: ScoutStats,
	warnings: string[],
): Promise<ChildEntry[]> {
	const selected: ChildEntry[] = [];
	for (let offset = 0; offset < entries.length; offset += MAX_CHILDREN_PER_REQUEST) {
		const batch = entries.slice(offset, offset + MAX_CHILDREN_PER_REQUEST);
		const response = await askJev(input, makeNavigationRequest(root, directory, input.query, batch), stats, warnings);
		const ids = [NONE_ID, ...batch.map(entry => entry.id)];
		const choice = validateChoice(response.answers["navigation::pick"], ids);
		validateNoul(response.answers["navigation::present"]);
		if (choice.choice === NONE_ID) continue;
		selected.push(
			...batch
				.map(entry => ({ entry, probability: choice.probabilities[entry.id] ?? 0 }))
				.filter(item => item.probability > 0)
				.sort(
					(left, right) =>
						right.probability - left.probability ||
						navigationScore(input.query, right.entry) - navigationScore(input.query, left.entry) ||
						left.entry.path.localeCompare(right.entry.path),
				)
				.map(item => item.entry),
		);
	}
	return selected;
}

function fallbackSourceCandidates(
	lines: string[],
	warnings: string[],
): {
	candidates: SourceCandidate[];
	outline: string;
	truncated: boolean;
} {
	return outlineLines(
		lines.map((text, index) => ({ text, line: index + 1 })),
		warnings,
	);
}

/** Formats whose whole content would be their outline; never sent below `bodies`. */
const DATA_LANGUAGES = new Set(["yaml", "markdown", "json", "toml", "ini", "xml", "html", "csv", "text"]);

/** What `summarizeCode` may reveal for one file in one request. */
type OutlineMode = "headers" | "outline" | "full";

function outlineModeFor(detail: ScoutSourceDetail): OutlineMode {
	return detail === "headers" ? "headers" : "outline";
}

function summarizeSource(
	code: string,
	sourcePath: string,
	lines: string[],
	warnings: string[],
	mode: OutlineMode,
): {
	candidates: SourceCandidate[];
	outline: string;
	truncated: boolean;
} {
	if (mode === "headers") {
		const declarations = sourceDeclarations({ code, path: sourcePath });
		if (!declarations.parsed || declarations.declarations.length === 0) {
			addWarning(
				warnings,
				`Skipped ${sourcePath}: unsupported language or parse failure, and no declaration metadata is available`,
			);
			return { candidates: [], outline: "", truncated: true };
		}
		return {
			candidates: declarations.declarations.map(declaration => ({
				startLine: declaration.startLine,
				endLine: declaration.endLine,
				exact: true,
				searchText: `${declaration.kind} ${declaration.name}`,
			})),
			outline: declarations.declarations
				.map(
					declaration =>
						`${declaration.startLine}-${declaration.endLine}: ${declaration.kind} ${declaration.name}`,
				)
				.join("\n"),
			truncated: false,
		};
	}
	const unfold = mode === "outline" ? 160 : DETAILED_RETRY_MAX_LINES;
	const summary = summarizeCode({
		code,
		path: sourcePath,
		minBodyLines: 3,
		minCommentLines: 2,
		unfoldUntilLines: unfold,
		unfoldLimitLines: unfold + unfold / 2,
	});
	if (!summary.parsed) {
		if (mode !== "full") {
			addWarning(
				warnings,
				`Skipped ${sourcePath}: unsupported language or parse failure, and the configured source detail forbids sending whole files`,
			);
			return { candidates: [], outline: "", truncated: true };
		}
		addWarning(warnings, `Source parse failed or language unsupported for ${sourcePath}; using numbered source`);
		return fallbackSourceCandidates(lines, warnings);
	}
	if (mode !== "full" && DATA_LANGUAGES.has(summary.language ?? "")) {
		addWarning(
			warnings,
			`Skipped ${sourcePath}: a ${summary.language} file has no foldable declarations, and the configured source detail forbids sending whole files`,
		);
		return { candidates: [], outline: "", truncated: true };
	}
	const visible: Array<{ text: string; line: number }> = [];
	for (const segment of summary.segments) {
		if (segment.kind !== "kept") continue;
		for (let line = segment.startLine; line <= segment.endLine; line++) {
			visible.push({ text: lines[line - 1] ?? "", line });
		}
	}
	return outlineLines(visible, warnings);
}

function outlineLines(
	visible: Array<{ text: string; line: number }>,
	warnings: string[],
): {
	candidates: SourceCandidate[];
	outline: string;
	truncated: boolean;
} {
	const candidates: SourceCandidate[] = [];
	const rendered: string[] = [];
	let chars = 0;
	let truncated = false;
	for (const { text, line } of visible) {
		if (!text.trim()) continue;
		const row = `${line}-${line}: ${text}`;
		if (candidates.length >= MAX_OUTLINE_ROWS_PER_FILE || chars + row.length + 1 > 24_000) {
			truncated = true;
			continue;
		}
		candidates.push({ startLine: line, endLine: line, searchText: text });
		rendered.push(row);
		chars += row.length + 1;
	}
	if (truncated) addWarning(warnings, "Source outline is partial (line or text budget); narrow the search if needed");
	return { candidates, outline: rendered.join("\n"), truncated };
}

async function readSource(
	sourcePath: string,
	warnings: string[],
	filesRead: { count: number },
	mode: OutlineMode,
): Promise<ReadSource | null> {
	let stat: Stats;
	try {
		stat = await fs.stat(sourcePath);
	} catch (error) {
		addWarning(
			warnings,
			`Selected file disappeared or is inaccessible: ${sourcePath} (${error instanceof Error ? error.message : String(error)})`,
		);
		return null;
	}
	if (!stat.isFile()) {
		addWarning(warnings, `Selected path is no longer a regular file: ${sourcePath}`);
		return null;
	}
	if (stat.size > MAX_SOURCE_BYTES) {
		addWarning(warnings, `Skipped oversized source file ${sourcePath} (>2 MiB)`);
		return null;
	}
	let bytes: ArrayBuffer;
	try {
		bytes = await Bun.file(sourcePath)
			.slice(0, MAX_SOURCE_BYTES + 1)
			.arrayBuffer();
	} catch (error) {
		addWarning(
			warnings,
			`Could not read selected file ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
	filesRead.count += 1;
	if (bytes.byteLength > MAX_SOURCE_BYTES) {
		addWarning(warnings, `Skipped source file ${sourcePath} that grew beyond 2 MiB while reading`);
		return null;
	}
	let code: string;
	try {
		code = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		addWarning(warnings, `Unsupported non-UTF-8 source file ${sourcePath}`);
		return null;
	}
	const lines = code.split("\n");
	const outline = summarizeSource(code, sourcePath, lines, warnings, mode);
	return { path: sourcePath, code, lines, mode, ...outline };
}

/** Lines climbed above the picked line while looking for the construct that encloses it. */
const MAX_ENCLOSING_CLIMB = 200;

/**
 * Resolve the construct to show for a picked line.
 *
 * `blockRangeAt` resolves the node that BEGINS on a line, so a line inside a
 * function (`return Math.max(...)`) resolves to that statement alone, which is
 * useless to the caller. Climb upward collecting every construct that contains
 * the picked line and prefer the largest one that still fits the excerpt cap —
 * the enclosing function rather than either the bare statement or a
 * thousand-line class.
 */
function resolveEnclosingBlock(file: ReadSource, line: number): { startLine: number; endLine: number } | null {
	const containing: Array<{ startLine: number; endLine: number }> = [];
	for (let probe = line; probe >= 1 && line - probe <= MAX_ENCLOSING_CLIMB; probe--) {
		const text = file.lines[probe - 1] ?? "";
		if (!text.trim()) continue;
		let range: { startLine: number; endLine: number } | null = null;
		try {
			range = blockRangeAt({ code: file.code, path: file.path, line: probe });
		} catch {
			return null;
		}
		if (range && range.endLine >= line) containing.push(range);
		// A construct starting in column 0 is top level; nothing above it encloses the line.
		if (!/^\s/.test(text)) break;
	}
	if (containing.length === 0) return null;
	const fitting = containing.filter(range => range.endLine - range.startLine + 1 <= MAX_EXCERPT_LINES);
	if (fitting.length > 0) {
		return fitting.reduce((widest, range) =>
			range.endLine - range.startLine > widest.endLine - widest.startLine ? range : widest,
		);
	}
	return containing.reduce((narrowest, range) =>
		range.endLine - range.startLine < narrowest.endLine - narrowest.startLine ? range : narrowest,
	);
}

function makeExcerpt(
	candidate: LocationCandidate,
	warnings: string[],
	remainingChars: number,
): { excerpt: ScoutExcerpt | null; usedChars: number; truncated: boolean } {
	let startLine = candidate.startLine;
	let endLine = candidate.endLine;
	if (!candidate.exact) {
		const range = resolveEnclosingBlock(candidate.file, candidate.startLine);
		const resolved = range !== null;
		if (range) {
			startLine = range.startLine;
			endLine = range.endLine;
		}
		if (!resolved) {
			startLine = Math.max(1, candidate.startLine - 20);
			endLine = Math.min(candidate.file.lines.length, candidate.startLine + 20);
			addWarning(
				warnings,
				`Source excerpt for ${candidate.file.path}:${candidate.startLine} is not a resolved declaration`,
			);
		}
	}
	let truncated = false;
	if (endLine - startLine + 1 > MAX_EXCERPT_LINES) {
		endLine = startLine + MAX_EXCERPT_LINES - 1;
		truncated = true;
		addWarning(warnings, `Source excerpt for ${candidate.file.path} truncated to 100 lines`);
	}
	const selected: string[] = [];
	let usedChars = 0;
	for (let line = startLine; line <= endLine; line++) {
		const sourceLine = candidate.file.lines[line - 1] ?? "";
		const addition = selected.length === 0 ? sourceLine : `\n${sourceLine}`;
		if (usedChars + addition.length > remainingChars) {
			truncated = true;
			addWarning(warnings, `Source excerpt for ${candidate.file.path} truncated at text budget`);
			break;
		}
		selected.push(sourceLine);
		usedChars += addition.length;
	}
	if (selected.length === 0) {
		addWarning(
			warnings,
			`Skipped source excerpt for ${candidate.file.path}:${candidate.startLine}; one source line exceeds text budget`,
		);
		return { excerpt: null, usedChars: 0, truncated: true };
	}
	const actualEndLine = startLine + selected.length - 1;
	return {
		excerpt: {
			path: candidate.file.path,
			startLine,
			endLine: actualEndLine,
			text: selected.join("\n"),
		},
		usedChars,
		truncated,
	};
}

function locationKey(candidate: LocationCandidate): string {
	return `${candidate.file.path}:${candidate.file.mode}:${candidate.startLine}`;
}

function locationCandidates(query: string, files: ReadSource[], stats: ScoutStats): LocationCandidate[] {
	const tokens = queryTokens(query);
	return files
		.flatMap((file, fileIndex) => file.candidates.map(candidate => ({ ...candidate, fileIndex, file })))
		.filter(candidate => !stats.rankedLocations.has(locationKey(candidate)))
		.map(candidate => ({
			...candidate,
			relevance: tokenOverlap(tokens, candidate.searchText ?? ""),
			callable: callableKind((candidate.searchText ?? "").split(/\s+/, 1)[0] ?? ""),
		}))
		.sort(
			(left, right) =>
				right.relevance - left.relevance ||
				right.callable - left.callable ||
				left.file.path.localeCompare(right.file.path) ||
				left.startLine - right.startLine,
		);
}

async function rankLocations(
	input: ScoutInput,
	root: string,
	files: ReadSource[],
	page: LocationCandidate[],
	stats: ScoutStats,
	warnings: string[],
): Promise<{ excerpt: ScoutExcerpt | null; truncated: boolean; asked: boolean }> {
	const { request, candidates } = makeLocationRequest(root, input.query, files, page);
	const truncated = files.some(file => file.truncated);
	if (candidates.size === 0) return { excerpt: null, truncated, asked: false };
	const response = await askJev(input, request, stats, warnings);
	stats.locationRounds += 1;
	for (const candidate of page) stats.rankedLocations.add(locationKey(candidate));
	const choice = validateChoice(response.answers["location::pick"], [NONE_ID, ...candidates.keys()]);
	const present = validateNoul(response.answers["location::present"]);
	if (choice.choice === NONE_ID || present < LOCATION_PRESENCE_FLOOR) {
		return { excerpt: null, truncated, asked: true };
	}
	const candidate = candidates.get(choice.choice);
	if (!candidate) throw new JevError("Invalid Jev response", "invalid");
	const made = makeExcerpt(candidate, warnings, MAX_TOTAL_EXCERPT_CHARS);
	return { excerpt: made.excerpt, truncated: truncated || made.truncated, asked: true };
}

async function locateSources(
	input: ScoutInput,
	root: string,
	files: ReadSource[],
	stats: ScoutStats,
	warnings: string[],
): Promise<{ excerpts: ScoutExcerpt[]; truncated: boolean }> {
	const candidates = locationCandidates(input.query, files, stats);
	let truncated = files.some(file => file.truncated);
	let offset = 0;
	while (offset < candidates.length && stats.locationRounds < MAX_LOCATION_ROUNDS) {
		const page = candidates.slice(offset, offset + MAX_LOCATION_CHOICES);
		// Bound the actual page, rather than discarding the end of a source index.
		while (
			page.length > 1 &&
			new TextEncoder().encode(JSON.stringify(makeLocationRequest(root, input.query, files, page).request.state))
				.byteLength > 24_000
		) {
			page.splice(Math.ceil(page.length / 2));
		}
		offset += page.length;
		const round = await rankLocations(input, root, files, page, stats, warnings);
		truncated ||= round.truncated;
		if (round.excerpt) return { excerpts: [round.excerpt], truncated: truncated || offset < candidates.length };
	}
	if (offset < candidates.length) truncated = true;
	if (
		(input.sourceDetail ?? "headers") === "bodies" &&
		candidates.length > 0 &&
		files.some(file => file.mode !== "full") &&
		stats.locationRounds < MAX_LOCATION_ROUNDS
	) {
		const detailed = files
			.filter(file => file.mode !== "full" && file.lines.length <= DETAILED_RETRY_MAX_LINES)
			.map(file => ({
				...file,
				mode: "full" as const,
				...summarizeSource(file.code, file.path, file.lines, warnings, "full"),
			}));
		if (detailed.length > 0) {
			const retry = await locateSources(input, root, detailed, stats, warnings);
			return { excerpts: retry.excerpts, truncated: truncated || retry.truncated };
		}
	}
	return { excerpts: [], truncated };
}

function baseResult(
	stats: ScoutStats,
	filesRead: number,
	directoriesVisited: number,
	warnings: string[],
	truncated: boolean,
) {
	return {
		filesRead,
		directoriesVisited,
		requests: stats.requests,
		inputTokens: stats.inputTokens,
		outputTokens: stats.outputTokens,
		truncated,
		warnings,
	};
}

export async function scoutSource(input: ScoutInput): Promise<ScoutResult> {
	const maxFiles = validateInput(input);
	throwIfAborted(input.signal);
	const inputKind = await inspectInputPath(input.path);
	if (!jevAvailable()) throw new JevError("Jev unavailable", "unavailable");
	const stats: ScoutStats = {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		stateBytes: 0,
		locationRounds: 0,
		rankedLocations: new Set(),
	};
	const warnings: string[] = [];
	const filesRead = { count: 0 };
	let directoriesVisited = 0;
	let truncated = false;
	const files: ReadSource[] = [];
	const mode = outlineModeFor(input.sourceDetail ?? "headers");
	const root = inputKind === "file" ? path.dirname(input.path) : input.path;
	const pending: ChildEntry[] = [{ id: "root", path: input.path, kind: inputKind }];
	const visited = new Set<string>();
	const finish = (excerpts: ScoutExcerpt[]): ScoutResult => {
		if (truncated)
			addWarning(
				warnings,
				"Only selected paths and declaration pages were inspected; repository-wide absence is not proven",
			);
		return {
			status: excerpts.length > 0 ? "found" : "no_match",
			excerpts,
			...baseResult(stats, filesRead.count, directoriesVisited, warnings, truncated),
		};
	};
	try {
		while (pending.length > 0 && filesRead.count < maxFiles) {
			throwIfAborted(input.signal);
			const entry = pending.shift()!;
			if (visited.has(entry.path)) continue;
			visited.add(entry.path);
			if (entry.kind === "directory") {
				if (directoriesVisited >= MAX_DIRECTORY_VISITS) {
					truncated = true;
					continue;
				}
				const listing = await listWorkspace({
					path: entry.path,
					maxDepth: 1,
					hidden: false,
					gitignore: true,
					collectAgentsMd: false,
					signal: input.signal,
				});
				directoriesVisited += 1;
				truncated ||= listing.truncated;
				const entries = sortedEntries(entry.path, listing.entries);
				if (entries.length === 0) continue;
				const chosen = await chooseNavigation(input, root, entry.path, entries, stats, warnings);
				truncated ||= chosen.length < entries.length;
				// Depth-first ranked alternatives: a rejected file does not erase siblings.
				pending.unshift(...chosen.filter(child => !visited.has(child.path)));
				continue;
			}
			const file = await readSource(entry.path, warnings, filesRead, mode);
			if (!file) {
				truncated = true;
				continue;
			}
			files.push(file);
			truncated ||= file.truncated;
		}
		// Compare declarations across the selected files before accepting a plausible first-file hit.
		if (files.length > 0 && stats.locationRounds < MAX_LOCATION_ROUNDS) {
			const located = await locateSources(input, root, files, stats, warnings);
			truncated ||= located.truncated;
			if (located.excerpts.length > 0) {
				truncated ||= pending.length > 0;
				return finish(located.excerpts);
			}
		}
	} catch (error) {
		if (!(error instanceof ScoutStateBudgetExceeded)) throw error;
		truncated = true;
	}
	if (pending.length > 0) {
		truncated = true;
		addWarning(warnings, "Search scope is partial: directory, file-read, or ranking budget reached");
	}
	if (stats.locationRounds >= MAX_LOCATION_ROUNDS) {
		truncated = true;
		addWarning(warnings, "Location ranking stopped at three rounds; repository-wide absence is not proven");
	}
	return finish([]);
}
