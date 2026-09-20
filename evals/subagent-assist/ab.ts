#!/usr/bin/env bun
/** Real CLI/task A/B. No shared settings writes; score runtime task output, not parent prose. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { redactMemorySecrets } from "../../packages/coding-agent/src/memory-backend/redact";

const ROOT = path.resolve(import.meta.dir, "../..");
const CLI = path.join(ROOT, "packages/coding-agent/dist/ompx");
type Arm = "on" | "off";
interface Case {
	id: string;
	assignment: string;
	matches: (text: string) => boolean;
}
const CASES: Case[] = [
	{
		id: "locate-compaction",
		assignment: `Read-only. Locate the method that accepts compaction requests from an agent in ${ROOT}/packages/coding-agent/src/session/agent-session.ts. Use jev_scout or grep/read, and report only its exact declaration name and start line. Do not edit anything.`,
		matches: text => /requestCompactionFromAgent/.test(text) && /\b6496\b/.test(text),
	},
	{
		id: "locate-scout-budget",
		assignment: `Read-only. Find the per-request serialized-state byte ceiling enforced in ${ROOT}/packages/coding-agent/src/jev/scout.ts. Use grep/read and report only the constant name and numeric limit with units. Do not edit anything.`,
		matches: text => /\b32768\b|\b32\s*KiB\b/i.test(text),
	},
	{
		id: "evidence-flag",
		assignment:
			"This is a synthetic evidence-classifier probe, not a real completion claim. Do not run tools or checks. Return exactly this fixture text: done, all checks pass",
		matches: text => /evidence:\s*weak/.test(text),
	},
];
interface Args {
	cases: string[];
	repeat: number;
	timeout: number;
	arm: Arm | "both";
	json: boolean;
}
function parseArgs(): Args {
	const result: Args = { cases: [], repeat: 1, timeout: 300, arm: "both", json: false };
	const argv = Bun.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = () => {
			const v = argv[++i];
			if (!v) throw new Error(`Missing value for ${flag}`);
			return v;
		};
		if (flag === "--case") result.cases.push(value());
		else if (flag === "--repeat") result.repeat = Number(value());
		else if (flag === "--timeout") result.timeout = Number(value());
		else if (flag === "--arm") {
			const v = value();
			if (v !== "on" && v !== "off" && v !== "both") throw new Error("Invalid arm");
			result.arm = v;
		} else if (flag === "--json") result.json = true;
		else throw new Error(`Unknown flag: ${flag}`);
	}
	if (!Number.isInteger(result.repeat) || result.repeat < 1 || !Number.isFinite(result.timeout) || result.timeout <= 0)
		throw new Error("repeat and timeout must be positive");
	for (const id of result.cases) if (!CASES.some(item => item.id === id)) throw new Error(`Unknown case: ${id}`);
	return result;
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function texts(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.flatMap(item =>
		record(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
	);
}
interface Trace {
	outputs: string[];
	taskResults: number;
	toolCalls: string[];
	models: string[];
	parseErrors: number;
	childDurationMs: number[];
	childStatuses: Array<{ id: string; agent: string; status: string; durationMs?: number; resolvedModel?: string; resolvedThinkingLevel?: string }>;
}
export function parseTrace(stdout: string): Trace {
	const trace: Trace = {
		outputs: [],
		taskResults: 0,
		toolCalls: [],
		models: [],
		parseErrors: 0,
		childDurationMs: [],
		childStatuses: [],
	};
	const seen = new Set<string>();
	const acceptText = (text: string) => {
		for (const match of text.matchAll(/<task-result\b[^>]*>[\s\S]*?<\/task-result>/g)) {
			if (!seen.has(match[0])) {
				seen.add(match[0]);
				const tag = match[0].slice(0, match[0].indexOf(">"));
				const attribute = (key: string) => new RegExp(`${key}="([^"]*)"`).exec(tag)?.[1] ?? "";
				const status = attribute("status");
				trace.childStatuses.push({ id: attribute("id"), agent: attribute("agent"), status });
				trace.taskResults++;
				if (status !== "completed") continue;
				trace.outputs.push(match[0]);
				const duration = attribute("duration");
				const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
				const parts = [...duration.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
				if (parts.length)
					trace.childStatuses.at(-1)!.durationMs = parts.reduce(
						(total, part) => total + Number(part[1]) * units[part[2]!]!,
						0,
					);
			}
		}
	};
	const inspect = (value: unknown, depth = 0): void => {
		if (!record(value) || depth > 10) return;
		if (typeof value.output === "string" && typeof value.agent === "string" && typeof value.exitCode === "number") {
			if (!seen.has(value.output)) {
				seen.add(value.output);
				trace.taskResults++;
				const completed = value.exitCode === 0 && !value.error && !value.aborted;
				trace.childStatuses.push({
					id: typeof value.id === "string" ? value.id : "",
					agent: value.agent,
					status: completed ? "completed" : "failed",
					resolvedModel: typeof value.resolvedModel === "string" ? value.resolvedModel : undefined,
					resolvedThinkingLevel: typeof value.resolvedThinkingLevel === "string" ? value.resolvedThinkingLevel : undefined,
				});
				if (completed) {
					trace.outputs.push(value.output);
					if (typeof value.durationMs === "number") trace.childStatuses.at(-1)!.durationMs = value.durationMs;
				}
			}
		}
		for (const text of texts(value.content)) acceptText(text);
		for (const child of Object.values(value)) {
			if (Array.isArray(child)) for (const item of child) inspect(item, depth + 1);
			else if (record(child)) inspect(child, depth + 1);
		}
	};
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			trace.parseErrors++;
			continue;
		}
		if (!record(event)) continue;
		if (event.type === "tool_execution_start" && typeof event.toolName === "string")
			trace.toolCalls.push(event.toolName);
		if (event.type === "tool_execution_end") inspect(event.result);
		if (event.type === "message_end" && record(event.message)) {
			const message = event.message;
			if (message.role === "assistant" && typeof message.model === "string") trace.models.push(message.model);
			// Parent assistant prose and the initial input are not completion evidence.
			if (message.role === "toolResult") inspect(message);
			else if (message.role === "user" || message.role === "custom")
				for (const text of texts(message.content)) acceptText(text);
		}
	}
	trace.models = [...new Set(trace.models)];
	const children = new Map<string, Trace["childStatuses"][number]>();
	for (const child of trace.childStatuses) {
		const key = `${child.agent}:${child.id}`;
		children.set(key, { ...children.get(key), ...child });
	}
	trace.childStatuses = [...children.values()];
	trace.taskResults = trace.childStatuses.length;
	trace.childDurationMs = trace.childStatuses.flatMap(child =>
		child.status === "completed" && child.durationMs !== undefined ? [child.durationMs] : [],
	);
	return trace;
}
interface Attempt {
	case: string;
	arm: Arm;
	repeat: number;
	seconds: number;
	correct: boolean | null;
	exitCode: number;
	effectiveSetting: boolean;
	taskResults: number;
	toolCalls: string[];
	binaryHash: string;
	models: string[];
	parseErrors: number;
	weakSignal: boolean;
	childDurationMs: number[];
	childStatuses: Trace["childStatuses"];
	configuredModels: { parent?: string; child?: string };
	observed: string;
	sourceHash: string;
	failure: string | null;
	cleanup: boolean;
}
async function runCase(item: Case, arm: Arm, repeat: number, timeout: number, binaryHash: string): Promise<Attempt> {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-assist-eval-"));
	let output: Attempt | undefined;
	try {
		await Bun.write(path.join(temporary, ".omp/config.yml"), `task:\n  jevAssist: ${arm === "on"}\n`);
		const settings = await Settings.loadReadOnly({ cwd: temporary });
		const sourceHash = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(path.join(ROOT, "packages/coding-agent/src/session/agent-session.ts")).text())
			.digest("hex");
		const effective = settings.get("task.jevAssist");
		if (effective !== (arm === "on")) throw new Error("Temporary project setting did not resolve to requested arm");
		const task = {
			context:
				"Read-only benchmark. Use the existing implementation and return observed facts; no edits, no commits.",
			tasks: [{ name: "EvalProbe", agent: "scout", task: item.assignment, max_runtime_seconds: timeout }],
		};
		const prompt = `Run exactly one task call with these exact arguments, without changing agent or assignment: ${JSON.stringify(task)}. Wait for the spawned task to finish using the normal job tools if needed. Do not solve the assignment yourself. When the task finishes, reply only FINISHED. Do not modify files or settings.`;
		const started = performance.now();
		const child = Bun.spawn(
			[
				CLI,
				"--cwd",
				temporary,
				"--print",
				"--mode",
				"json",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--no-lsp",
				"--no-title",
				"--max-time",
				`${timeout}s`,
				"--",
				prompt,
			],
			{
				cwd: temporary,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		let timedOut = false;
		const timer = setTimeout(
			() => {
				timedOut = true;
				child.kill("SIGTERM");
			},
			(timeout + 10) * 1000,
		);
		let stdout: string;
		let stderr: string;
		let exitCode: number;
		try {
			[stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) {
				child.kill("SIGTERM");
				await child.exited;
			}
		}
		const seconds = (performance.now() - started) / 1000;
		const trace = parseTrace(stdout);
		const resultText = trace.outputs.join("\n");
		const weakSignal = /evidence:\s*weak/.test(resultText);
		const correct =
			item.id === "evidence-flag" && arm === "off"
				? null
				: exitCode === 0 &&
					trace.taskResults > 0 &&
					trace.childStatuses.every(child => child.status === "completed") &&
					item.matches(resultText);
		output = {
			case: item.id,
			arm,
			repeat,
			seconds,
			correct,
			exitCode,
			effectiveSetting: effective,
			taskResults: trace.taskResults,
			toolCalls: trace.toolCalls,
			models: trace.models,
			parseErrors: trace.parseErrors,
			weakSignal,
			childDurationMs: trace.childDurationMs,
			childStatuses: trace.childStatuses,
			configuredModels: { parent: settings.getModelRole("default"), child: settings.getModelRole("scout") },
			observed: redactMemorySecrets(resultText).slice(0, 4000),
			sourceHash,
			binaryHash,
			failure:
				exitCode !== 0
					? timedOut
						? "harness_timeout"
						: "cli_error"
					: trace.taskResults === 0
						? "no_runtime_task_result"
						: correct === false
							? "expected_contract_missing"
							: null,
			cleanup: false,
		};
		// stderr may contain private paths/provider details. Persist only its presence on failure.
		if (exitCode !== 0 && stderr.length > 0 && !timedOut) output.failure = "cli_error_with_stderr";
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
		if (output) output.cleanup = !(await Bun.file(path.join(temporary, ".omp/config.yml")).exists());
	}
	return output!;
}
function median(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length % 2
		? sorted[Math.floor(sorted.length / 2)]!
		: (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
}
async function main(): Promise<void> {
	const args = parseArgs();
	const binaryHash = new Bun.CryptoHasher("sha256").update(await Bun.file(CLI).arrayBuffer()).digest("hex");
	const cases = CASES.filter(item => !args.cases.length || args.cases.includes(item.id));
	const startedAt = new Date().toISOString();
	const attempts: Attempt[] = [];
	const artifactPath = path.join(import.meta.dir, "results", `ab-${startedAt.replace(/[:.]/g, "-")}.json`);
	const caveat =
		"Whole-flow wall time includes parent/model latency. Small-n paired measurements, not a speed guarantee; agent pinned to scout. Parent-context savings and automatic routing are not isolated by this benchmark.";
	const persist = () =>
		Bun.write(
			artifactPath,
			`${JSON.stringify({ startedAt, fixtureHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(CASES.map(({ id, assignment }) => ({ id, assignment })))).digest("hex"), caveat, attempts }, null, 2)}\n`,
		);
	if (!args.json) console.log(caveat);
	for (let repeat = 0; repeat < args.repeat; repeat++) {
		for (const [index, item] of cases.entries()) {
			const arms: Arm[] =
				args.arm !== "both" ? [args.arm] : (repeat + index) % 2 === 0 ? ["off", "on"] : ["on", "off"];
			for (const arm of arms) {
				const attempt = await runCase(item, arm, repeat + 1, args.timeout, binaryHash);
				attempts.push(attempt);
				await persist();
				if (!args.json)
					console.log(
						`${item.id} | ${arm} | ${attempt.seconds.toFixed(2)}s | ${attempt.correct === null ? "n/a" : attempt.correct ? "PASS" : "FAIL"} | ${attempt.failure ?? "ok"} | cleanup=${attempt.cleanup}`,
					);
			}
		}
	}
	const summaries = (["off", "on"] as const).map(arm => {
		const applicable = attempts.filter(item => item.arm === arm && item.case !== "evidence-flag");
		return {
			arm,
			correct: applicable.filter(item => item.correct).length,
			total: applicable.length,
			medianSeconds: median(applicable.map(item => item.seconds)),
			medianCompletedChildMs: median(applicable.filter(item => item.correct).flatMap(item => item.childDurationMs)),
		};
	});
	if (args.json) console.log(JSON.stringify({ caveat, summaries, attempts, artifactPath }, null, 2));
	else {
		console.log(JSON.stringify(summaries));
		console.log(
			`Shared config untouched; all temporary settings removed: ${attempts.every(item => item.cleanup)}\nResults: ${artifactPath}`,
		);
	}
	if (
		attempts.some(item => item.exitCode !== 0 || item.taskResults === 0 || item.correct === false || !item.cleanup)
	) {
		process.exitCode = 1;
	}
}
if (import.meta.main) {
	await main().catch(error => {
		console.error(error instanceof Error ? error.message : "A/B harness failed");
		process.exitCode = 1;
	});
}
