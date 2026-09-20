#!/usr/bin/env bun
/**
 * Runner for the `jev_scout` eval tasks.
 *
 * Calls the real tool path (`scoutSource`) against the live Jev endpoint and
 * scores each answer on the tool's observable contract: the returned excerpt
 * must come from the expected file and contain the expected declaration, or —
 * for an absence task — the status must be `no_match` with no excerpt.
 *
 * Selection is probabilistic, so `--repeat` is the useful knob: a task's score
 * is hits over attempts, and the summary reports per-task accuracy next to
 * latency and Jev token cost.
 *
 * Usage:
 *   bun run evals/jev-scout/run.ts --list
 *   bun run evals/jev-scout/run.ts --task workspace-tree-dir --repeat 3
 *   bun run evals/jev-scout/run.ts --json
 */

import * as path from "node:path";
import { scoutSource, type ScoutResult, type ScoutSourceDetail } from "../../packages/coding-agent/src/jev/scout";
import { jevAvailable, jevEndpoint, jevModel } from "../../packages/coding-agent/src/jev/systemone";
import { type EvalTask, TASKS, tasksFor } from "./tasks";
import { SESSION_TASKS } from "./session-tasks";
import { BACKEND_TASKS, FRONTEND_TASKS } from "./xlords-tasks";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS_DIR = path.join(import.meta.dir, "results");
const SUITES: Record<string, EvalTask[]> = {
	ompx: TASKS,
	"session-compaction": SESSION_TASKS,
	"xlords-backend": BACKEND_TASKS,
	"xlords-frontend": FRONTEND_TASKS,
};

interface Args {
	taskIds: string[];
	repeat: number;
	timeoutSeconds: number;
	list: boolean;
	json: boolean;
	suite: string;
	root: string;
	detail: ScoutSourceDetail;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		taskIds: [],
		repeat: 1,
		timeoutSeconds: 60,
		list: false,
		json: false,
		suite: "ompx",
		root: REPO_ROOT,
		detail: "headers",
	};
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new Error(`${flag} needs a value`);
			return next;
		};
		switch (flag) {
			case "--suite":
				args.suite = value();
				break;
			case "--root":
				args.root = path.resolve(value());
				break;
			case "--detail": {
				const detail = value();
				if (detail !== "headers" && detail !== "outline" && detail !== "bodies") {
					throw new Error("--detail must be headers, outline, or bodies");
				}
				args.detail = detail;
				break;
			}
			case "--list":
				args.list = true;
				break;
			case "--json":
				args.json = true;
				break;
			case "--task":
				args.taskIds.push(value());
				break;
			case "--repeat":
				args.repeat = Number(value());
				break;
			case "--timeout":
				args.timeoutSeconds = Number(value());
				break;
			default:
				throw new Error(`Unknown flag: ${flag}`);
		}
	}
	if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error("--repeat must be a positive integer");
	if (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 1) throw new Error("--timeout must be seconds");
	if (!Object.hasOwn(SUITES, args.suite)) throw new Error(`Unknown suite: ${args.suite}`);
	if (!["ompx", "session-compaction"].includes(args.suite) && args.root === REPO_ROOT && !args.list)
		throw new Error("External suites require --root");
	return args;
}

interface Attempt {
	hit: boolean;
	status: "found" | "no_match" | "error";
	observed: string;
	elapsedMs: number;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	filesRead: number;
	directoriesVisited: number;
	truncated: boolean;
	warnings: string[];
	outbound: OutboundExposure;
	excerpts: Array<{ path: string; startLine: number; endLine: number; characters: number }>;
}

interface Outcome {
	task: EvalTask;
	attempts: Attempt[];
	hits: number;
}
interface OutboundExposure {
	stateBytesTotal: number;
	stateBytesUnique: number;
	outlineBytesTotal: number;
	outlineBytesUnique: number;
	outlineRowsTotal: number;
	outlineRowsUnique: number;
}

interface ExposureRecorder {
	metrics: OutboundExposure;
	requests: number;
	fetchImpl: typeof fetch;
	stateDigests: Set<string>;
	outlineDigests: Set<string>;
}

const TEXT_ENCODER = new TextEncoder();

function emptyExposure(): OutboundExposure {
	return {
		stateBytesTotal: 0,
		stateBytesUnique: 0,
		outlineBytesTotal: 0,
		outlineBytesUnique: 0,
		outlineRowsTotal: 0,
		outlineRowsUnique: 0,
	};
}

function digestText(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function recordOutboundBody(recorder: ExposureRecorder, body: string): void {
	let request: unknown;
	try {
		request = JSON.parse(body);
	} catch {
		return;
	}
	if (!isRecord(request)) return;
	const stateText = JSON.stringify(request.state);
	if (typeof stateText !== "string") return;
	const stateBytes = TEXT_ENCODER.encode(stateText).byteLength;
	recorder.metrics.stateBytesTotal += stateBytes;
	const stateDigest = digestText(stateText);
	if (!recorder.stateDigests.has(stateDigest)) {
		recorder.stateDigests.add(stateDigest);
		recorder.metrics.stateBytesUnique += stateBytes;
	}

	if (!isRecord(request.state) || !Array.isArray(request.state.files)) return;
	for (const file of request.state.files) {
		if (!isRecord(file) || typeof file.outline !== "string") continue;
		const outline = file.outline;
		const bytes = TEXT_ENCODER.encode(outline).byteLength;
		const rows = outline.length === 0 ? 0 : outline.split("\n").length;
		recorder.metrics.outlineBytesTotal += bytes;
		recorder.metrics.outlineRowsTotal += rows;
		const outlineDigest = digestText(outline);
		if (recorder.outlineDigests.has(outlineDigest)) continue;
		recorder.outlineDigests.add(outlineDigest);
		recorder.metrics.outlineBytesUnique += bytes;
		recorder.metrics.outlineRowsUnique += rows;
	}
}

function createExposureRecorder(): ExposureRecorder {
	const recorder: ExposureRecorder = {
		metrics: emptyExposure(),
		requests: 0,
		stateDigests: new Set<string>(),
		outlineDigests: new Set<string>(),
		fetchImpl: async (input, init) => {
			recorder.requests += 1;
			if (typeof init?.body === "string") recordOutboundBody(recorder, init.body);
			return fetch(input, init);
		},
	};
	return recorder;
}

/** Location and source fidelity are checked independently of Jev's own verdict. */
async function score(task: EvalTask, result: ScoutResult, root: string) {
	const { excerpts } = result;
	const first = excerpts[0];
	const observed = first ? `${path.relative(root, first.path)}:${first.startLine}-${first.endLine}` : "no_match";
	if (!task.expect) return { hit: result.status === "no_match" && excerpts.length === 0, observed };
	const expected = path.resolve(root, task.expect.file);
	const match = excerpts.find(
		excerpt =>
			path.resolve(excerpt.path) === expected &&
			excerpt.text.includes(task.expect!.contains) &&
			(task.expect!.startLine === undefined || excerpt.startLine === task.expect!.startLine),
	);
	if (!match || result.status !== "found") return { hit: false, observed };
	const lines = (await Bun.file(expected).text()).split("\n");
	const faithful =
		match.startLine >= 1 &&
		match.endLine <= lines.length &&
		match.text === lines.slice(match.startLine - 1, match.endLine).join("\n");
	return { hit: faithful, observed };
}

function relative(absolute: string): string {
	return path.relative(REPO_ROOT, absolute) || absolute;
}

async function runAttempt(task: EvalTask, args: Args): Promise<Attempt> {
	const started = performance.now();
	const recorder = createExposureRecorder();
	try {
		const result = await scoutSource({
			query: task.query,
			path: path.resolve(args.root, task.path),
			maxFiles: task.maxFiles,
			sourceDetail: args.detail,
			signal: AbortSignal.timeout(args.timeoutSeconds * 1000),
			fetchImpl: recorder.fetchImpl,
		});
		const elapsedMs = Math.round(performance.now() - started);
		const { hit, observed } = await score(task, result, args.root);
		return {
			hit,
			status: result.status,
			observed,
			elapsedMs,
			requests: result.requests,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			filesRead: result.filesRead,
			directoriesVisited: result.directoriesVisited,
			truncated: result.truncated,
			warnings: result.warnings,
			outbound: recorder.metrics,
			excerpts: result.excerpts.map(excerpt => ({
				path: path.relative(args.root, excerpt.path),
				startLine: excerpt.startLine,
				endLine: excerpt.endLine,
				characters: excerpt.text.length,
			})),
		};
	} catch (error) {
		return {
			hit: false,
			status: "error",
			observed: error instanceof Error ? error.message : String(error),
			elapsedMs: Math.round(performance.now() - started),
			requests: recorder.requests,
			inputTokens: 0,
			outputTokens: 0,
			filesRead: 0,
			directoriesVisited: 0,
			truncated: false,
			warnings: [
				"Usage before failure is unavailable; outbound exposure metrics include requests captured before failure",
			],
			outbound: recorder.metrics,
			excerpts: [],
		};
	}
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function summarizeExposure(attempts: Attempt[]): OutboundExposure {
	return {
		stateBytesTotal: median(attempts.map(attempt => attempt.outbound.stateBytesTotal)),
		stateBytesUnique: median(attempts.map(attempt => attempt.outbound.stateBytesUnique)),
		outlineBytesTotal: median(attempts.map(attempt => attempt.outbound.outlineBytesTotal)),
		outlineBytesUnique: median(attempts.map(attempt => attempt.outbound.outlineBytesUnique)),
		outlineRowsTotal: median(attempts.map(attempt => attempt.outbound.outlineRowsTotal)),
		outlineRowsUnique: median(attempts.map(attempt => attempt.outbound.outlineRowsUnique)),
	};
}

function formatExposure(exposure: OutboundExposure): string {
	return `state ${exposure.stateBytesTotal}/${exposure.stateBytesUnique} B; outline ${exposure.outlineBytesTotal}/${exposure.outlineBytesUnique} B, ${exposure.outlineRowsTotal}/${exposure.outlineRowsUnique} rows`;
}

function summarize(outcome: Outcome) {
	const attempts = outcome.attempts;
	return {
		id: outcome.task.id,
		expected: outcome.task.expect ? `${outcome.task.expect.file} (${outcome.task.expect.contains})` : "no_match",
		accuracy: `${outcome.hits}/${attempts.length}`,
		medianMs: median(attempts.map(attempt => attempt.elapsedMs)),
		requests: median(attempts.map(attempt => attempt.requests)),
		tokens: median(attempts.map(attempt => attempt.inputTokens + attempt.outputTokens)),
		exposure: summarizeExposure(attempts),
		observed: [...new Set(attempts.map(attempt => attempt.observed))].join(" | "),
	};
}

function comparisonReport(outcomes: Outcome[]): string {
	const grouped = new Map<string, { original?: Outcome; atomic?: Outcome }>();
	for (const outcome of outcomes) {
		const comparison = outcome.task.comparison;
		if (!comparison) continue;
		const pair = grouped.get(comparison.group) ?? {};
		pair[comparison.variant] = outcome;
		grouped.set(comparison.group, pair);
	}
	const lines: string[] = [];
	for (const [group, pair] of grouped) {
		if (!pair.original || !pair.atomic) continue;
		const original = summarize(pair.original);
		const atomic = summarize(pair.atomic);
		lines.push(
			`- ${group}: original "${pair.original.task.query}" = ${original.accuracy}, ${original.requests} requests, ${formatExposure(original.exposure)}; atomic "${pair.atomic.task.query}" = ${atomic.accuracy}, ${atomic.requests} requests, ${formatExposure(atomic.exposure)}`,
		);
	}
	return lines.join("\n");
}

async function writeResults(
	outcomes: Outcome[],
	stamp: string,
	args: Args,
	corpus: Array<{ path: string; sha256: string }>,
): Promise<{ json: string; md: string }> {
	const jsonPath = path.join(RESULTS_DIR, `${args.suite}-${args.detail}-${stamp}.json`);
	const mdPath = path.join(RESULTS_DIR, `${args.suite}-${args.detail}-${stamp}.md`);
	await Bun.write(
		jsonPath,
		`${JSON.stringify(
			{
				suite: args.suite,
				root: args.root,
				sourceDetail: args.detail,
				corpus,
				endpoint: new URL(jevEndpoint()).origin,
				model: jevModel(),
				outcomes: outcomes.map(o => ({ task: o.task, attempts: o.attempts })),
			},
			null,
			2,
		)}\n`,
	);
	const rows = outcomes.map(summarize);
	const table = [
		"| task | accuracy | median ms | requests | tokens | state bytes (total/unique) | outline bytes (total/unique) | outline rows (total/unique) | observed |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows.map(
			row =>
				`| ${row.id} | ${row.accuracy} | ${row.medianMs} | ${row.requests} | ${row.tokens} | ${row.exposure.stateBytesTotal}/${row.exposure.stateBytesUnique} | ${row.exposure.outlineBytesTotal}/${row.exposure.outlineBytesUnique} | ${row.exposure.outlineRowsTotal}/${row.exposure.outlineRowsUnique} | ${row.observed} |`,
		),
	].join("\n");
	const hits = outcomes.reduce((total, outcome) => total + outcome.hits, 0);
	const attempts = outcomes.reduce((total, outcome) => total + outcome.attempts.length, 0);
	const comparisons = comparisonReport(outcomes);
	await Bun.write(
		mdPath,
		`# jev_scout eval — ${args.suite} — ${stamp}\n\nmodel: ${jevModel()}\n\noverall: ${hits}/${attempts}\n\n${table}${comparisons ? `\n\n## Original vs atomic\n\n${comparisons}` : ""}\n`,
	);
	return { json: jsonPath, md: mdPath };
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	const available = SUITES[args.suite]!;
	if (args.list) {
		for (const task of available) console.log(`${task.id.padEnd(22)} ${task.title} [${task.path}]`);
		return;
	}
	if (!jevAvailable()) throw new Error("Jev is disabled (TYPESAFE_SYSTEMONE_URL is empty)");
	const tasks = tasksFor(args.taskIds, available);
	const corpus = new Map<string, string>();
	for (const task of tasks) {
		if (!task.expect) continue;
		const source = await Bun.file(path.resolve(args.root, task.expect.file)).text();
		const expectedLine = task.expect.startLine;
		if (
			!(expectedLine === undefined ? source : (source.split("\n")[expectedLine - 1] ?? "")).includes(
				task.expect.contains,
			)
		) {
			throw new Error(`Stale ground truth for ${task.id}; inspect the corpus before running`);
		}
		corpus.set(task.expect.file, new Bun.CryptoHasher("sha256").update(source).digest("hex"));
	}
	const outcomes: Outcome[] = [];
	for (const task of tasks) {
		const attempts: Attempt[] = [];
		for (let run = 0; run < args.repeat; run++) attempts.push(await runAttempt(task, args));
		const outcome: Outcome = { task, attempts, hits: attempts.filter(attempt => attempt.hit).length };
		outcomes.push(outcome);
		if (!args.json) {
			const row = summarize(outcome);
			console.log(
				`${row.accuracy === `${attempts.length}/${attempts.length}` ? "PASS" : "FAIL"} ${task.id.padEnd(22)} ${row.accuracy}  ${row.medianMs}ms  ${row.tokens} tok  -> ${row.observed}`,
			);
		}
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	for (const [file, sha256] of corpus) {
		const current = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(path.resolve(args.root, file)).text())
			.digest("hex");
		if (current !== sha256) throw new Error(`Corpus changed during eval: ${file}; results are not comparable`);
	}
	const written = await writeResults(
		outcomes,
		stamp,
		args,
		[...corpus].map(([file, sha256]) => ({ path: file, sha256 })),
	);
	const hits = outcomes.reduce((total, outcome) => total + outcome.hits, 0);
	const attempts = outcomes.reduce((total, outcome) => total + outcome.attempts.length, 0);
	if (args.json)
		console.log(JSON.stringify({ hits, attempts, rows: outcomes.map(summarize), results: written }, null, 2));
	else console.log(`\noverall ${hits}/${attempts}\nresults: ${relative(written.json)} , ${relative(written.md)}`);
	if (hits < attempts) process.exitCode = 1;
}

await main();
