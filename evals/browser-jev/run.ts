#!/usr/bin/env bun
/**
 * Runner for the `browser_jev` XLords eval tasks.
 *
 * One task = one real CLI run = one `browser_jev` call, then the tool's own
 * report is parsed and checked against the task's expectation. Nothing is
 * mocked: the app is live, the browser session is real, and a `blocked` result
 * is recorded as such rather than massaged into a pass.
 *
 * Usage:
 *   bun run evals/browser-jev/run.ts --list
 *   bun run evals/browser-jev/run.ts --dry-run --task send-chat
 *   TYPESAFE_API_KEY=... bun run evals/browser-jev/run.ts --task send-chat --json
 *   TYPESAFE_API_KEY=... bun run evals/browser-jev/run.ts --viewport mobile --model <provider/model>
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type EvalTask, type EvalViewport, TASKS, tasksFor } from "./tasks";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages/coding-agent/src/cli.ts");
const RESULTS_DIR = path.join(import.meta.dir, "results");

interface ParsedReport {
	status?: string;
	actionCount?: number;
	url?: string;
	title?: string;
	rescues?: number;
	steps: string[];
	pageText?: string;
	shots: string[];
	review: string[];
	raw: string;
}

interface Args {
	list: boolean;
	dryRun: boolean;
	json: boolean;
	task?: string;
	viewport?: EvalViewport;
	timeout: number;
	model?: string;
	/** Directory the CLI runs in; it decides which project's browser session is reused. */
	cwd: string;
	/** Named browser profile, so the XLords login can persist across runs. */
	profile?: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { list: false, dryRun: false, json: false, timeout: 300, cwd: REPO_ROOT };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = (): string => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			return value;
		};
		switch (flag) {
			case "--list":
				args.list = true;
				break;
			case "--dry-run":
				args.dryRun = true;
				break;
			case "--json":
				args.json = true;
				break;
			case "--task":
				args.task = next();
				break;
			case "--viewport":
				args.viewport = next() as EvalViewport;
				break;
			case "--timeout":
				args.timeout = Number(next());
				break;
			case "--model":
				args.model = next();
				break;
			case "--cwd":
				args.cwd = path.resolve(next());
				break;
			case "--profile":
				args.profile = next();
				break;
			default:
				throw new Error(`unknown flag ${flag}`);
		}
	}
	return args;
}

/** The prompt asks for exactly one tool call and the report verbatim, so stdout is parseable. */
function buildPrompt(task: EvalTask, viewport: EvalViewport, profile?: string): string {
	const params = {
		goal: task.goal,
		url: task.url,
		viewport,
		close: true,
		...(profile ? { profile } : {}),
	};
	return [
		`Call the browser_jev tool exactly once with these arguments: ${JSON.stringify(params)}`,
		"Then print the tool's output text verbatim, with no commentary, no extra tools, and no second browser call.",
	].join("\n");
}

function buildArgv(task: EvalTask, viewport: EvalViewport, args: Args): string[] {
	const argv = [
		"bun",
		"run",
		CLI_ENTRY,
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
	];
	if (args.model) argv.push("-m", args.model);
	argv.push(buildPrompt(task, viewport, args.profile));
	return argv;
}

function parseReport(text: string): ParsedReport {
	const report: ParsedReport = { steps: [], shots: [], review: [], raw: text };
	const status = text.match(/^status:\s*(\S+)\s*—\s*(\d+)\s*action/);
	if (status) {
		report.status = status[1];
		report.actionCount = Number(status[2]);
	}
	const url = text.match(/^url:\s*(.+)$/m);
	if (url) report.url = url[1]!.trim();
	const title = text.match(/^title:\s*(.+)$/m);
	if (title) report.title = title[1]!.trim();
	const rescues = text.match(/^rescue turns:\s*(\d+)/m);
	if (rescues) report.rescues = Number(rescues[1]);
	const stepLines = text.split("\n").filter(line => /^\d+\.\s/.test(line));
	report.steps = stepLines;
	const pageText = text.split("\npage text:\n")[1];
	if (pageText) report.pageText = pageText.trim();
	const shotSection = text.split("\nscreenshots")[1];
	if (shotSection) {
		report.shots = shotSection
			.split("\n")
			.filter(line => line.startsWith("- "))
			.map(line => line.slice(2).trim());
	}
	const reviewSection = text.split("\nreview:\n")[1];
	if (reviewSection) report.review = reviewSection.split("\n").filter(Boolean);
	return report;
}

interface Outcome {
	task: string;
	viewport: EvalViewport;
	expected: string;
	observed: string;
	passed: boolean;
	reason: string;
	report?: ParsedReport;
}

function evaluate(task: EvalTask, viewport: EvalViewport, report: ParsedReport): Outcome {
	const markers = task.expect.markers;
	const missing = markers.filter(marker => !report.raw.includes(marker));
	const statusOk = report.status === task.expect.status;
	const rescueOk = !task.expect.needsRescue || (report.rescues ?? 0) > 0;
	const passed = statusOk && missing.length === 0;
	const reasons: string[] = [];
	if (!statusOk) reasons.push(`status ${report.status ?? "unparsed"} != ${task.expect.status}`);
	if (missing.length > 0) reasons.push(`missing evidence: ${missing.join(", ")}`);
	if (!rescueOk) reasons.push("expected a rescue turn, none was spent");
	return {
		task: task.id,
		viewport,
		expected: `${task.expect.status}${task.expect.needsRescue ? " + rescue" : ""}`,
		observed: report.status ?? "unparsed",
		passed,
		reason: reasons.join("; ") || "matched",
		report,
	};
}

async function runOne(task: EvalTask, viewport: EvalViewport, args: Args): Promise<Outcome> {
	const argv = buildArgv(task, viewport, args);
	const proc = Bun.spawn(argv, {
		cwd: args.cwd,
		env: { ...process.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), args.timeout * 1000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	const report = parseReport(stdout);
	const outcome = evaluate(task, viewport, report);
	if (exitCode !== 0 && !report.status) {
		outcome.passed = false;
		outcome.reason = `cli exited ${exitCode}: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`;
	}
	return outcome;
}

function printMatrix(): void {
	const rows = tasksFor();
	const width = Math.max(...rows.map(row => row.task.id.length));
	console.log(`${"task".padEnd(width)}  viewport`);
	for (const row of rows) console.log(`${row.task.id.padEnd(width)}  ${row.viewport}`);
	console.log(`\n${TASKS.length} tasks, ${rows.length} task×viewport runs.`);
}

async function writeResults(outcomes: Outcome[]): Promise<{ json: string; md: string }> {
	await fs.mkdir(RESULTS_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1);
	const jsonPath = path.join(RESULTS_DIR, `${stamp}.json`);
	const mdPath = path.join(RESULTS_DIR, `${stamp}.md`);
	await Bun.write(jsonPath, `${JSON.stringify(outcomes, null, 2)}\n`);
	const lines = [
		`# browser_jev eval — ${stamp}`,
		"",
		"| task | viewport | expected | observed | result | note |",
		"| --- | --- | --- | --- | --- | --- |",
		...outcomes.map(
			outcome =>
				`| ${outcome.task} | ${outcome.viewport} | ${outcome.expected} | ${outcome.observed} | ${outcome.passed ? "pass" : "fail"} | ${outcome.reason} |`,
		),
		"",
	];
	await Bun.write(mdPath, lines.join("\n"));
	return { json: jsonPath, md: mdPath };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.list) {
		printMatrix();
		return;
	}
	const rows = tasksFor(args.task, args.viewport);
	if (rows.length === 0) {
		console.error(`no tasks matched task=${args.task ?? "*"} viewport=${args.viewport ?? "*"}`);
		process.exit(1);
	}
	if (args.dryRun) {
		for (const row of rows) {
			console.log(`# ${row.task.id} @ ${row.viewport}`);
			console.log(`cd ${args.cwd} && ${buildArgv(row.task, row.viewport, args).join(" ")}`);
		}
		return;
	}
	if (!process.env.TYPESAFE_API_KEY) {
		console.error("TYPESAFE_API_KEY is not set — browser_jev is unavailable without it. Nothing was run.");
		process.exit(1);
	}

	const outcomes: Outcome[] = [];
	for (const row of rows) {
		const started = Date.now();
		const outcome = await runOne(row.task, row.viewport, args);
		outcomes.push(outcome);
		const line = `${outcome.task} @ ${outcome.viewport}: ${outcome.passed ? "PASS" : "FAIL"} (${outcome.observed}) — ${outcome.reason} [${Math.round((Date.now() - started) / 1000)}s]`;
		console.log(line);
	}
	const files = await writeResults(outcomes);
	console.log(`\nresults: ${files.json}\n         ${files.md}`);
	if (args.json) console.log(JSON.stringify(outcomes, null, 2));
	const failures = outcomes.filter(outcome => !outcome.passed).length;
	console.log(`\n${outcomes.length - failures}/${outcomes.length} passed`);
}

await main();
