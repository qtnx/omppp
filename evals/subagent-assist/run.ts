#!/usr/bin/env bun
/**
 * Runner for the subagent-assist Jev eval corpus.
 *
 * Usage:
 *   bun evals/subagent-assist/run.ts --list
 *   bun evals/subagent-assist/run.ts --suite brief --repeat 3
 *   bun evals/subagent-assist/run.ts --task brief-good-context --repeat 2
 *   bun evals/subagent-assist/run.ts --suite all --json
 */

import { assessBriefs, routeAgent } from "../../packages/coding-agent/src/task/jev-brief";
import { selectRelevantContext } from "../../packages/coding-agent/src/task/jev-context";
import { assessResultEvidence } from "../../packages/coding-agent/src/task/jev-evidence";
import { filterReviewFindings } from "../../packages/coding-agent/src/task/jev-findings";
import { triageChildQuestion } from "../../packages/coding-agent/src/task/jev-triage";
import {
	JevError,
	jevAvailable,
	jevEndpoint,
	jevModel,
	postSystemOne,
	type JevChoiceQuestion,
	type JevPostOptions,
	type JevRequest,
	type JevResponse,
	validateChoice,
	validateNoul,
} from "../../packages/coding-agent/src/jev/systemone";
import {
	BRIEF_TASKS,
	CONTEXT_TASKS,
	EVIDENCE_TASKS,
	FINDING_TASKS,
	ROUTE_AGENTS,
	ROUTE_TASKS,
	TRIAGE_TASKS,
	type BriefTask,
	type ContextTask,
	type EvidenceTask,
	type FindingTask,
	type RouteTask,
	type TriageTask,
} from "./tasks";

const SUITE_NAMES = ["all", "brief", "route", "context", "triage", "evidence", "findings"] as const;
type SuiteName = (typeof SUITE_NAMES)[number];
type Capability = Exclude<SuiteName, "all">;

type EvalCase =
	| { suite: "brief"; task: BriefTask }
	| { suite: "route"; task: RouteTask }
	| { suite: "context"; task: ContextTask }
	| { suite: "triage"; task: TriageTask }
	| { suite: "evidence"; task: EvidenceTask }
	| { suite: "findings"; task: FindingTask };

// Frozen after policy corrections; never used to tune the classifier prompts.
const HELD_OUT_CASES: EvalCase[] = [
	{
		suite: "brief",
		task: {
			id: "held-scope",
			assignment:
				"Own src/queue.ts:drain and test/queue.test.ts. Preserve FIFO order. Acceptance: bun test test/queue.test.ts exits 0 and rejected enqueue leaves the queue unchanged.",
			context: "Existing queue module.",
			expectGaps: ["scope"],
		},
	},
	{
		suite: "route",
		task: {
			id: "held-library",
			assignment:
				"Read the installed dependency's source to establish its cancellation behavior; return exact API facts, no edits.",
			context: "External library API lookup.",
			expect: "librarian",
		},
	},
	{
		suite: "context",
		task: {
			id: "held-correction",
			assignment: "Update the queue module locally.",
			context: "Honor the latest destination and hold.",
			snapshot:
				"## Earlier\nEdit src/old-queue.ts.\n\n## Correction\nUse src/new-queue.ts instead. Never publish.\n\n## Unrelated\nA weather forecast.",
			expectSections: ["src/new-queue.ts", "Never publish"],
			rejectSections: ["src/old-queue.ts", "weather"],
		},
	},
	{
		suite: "triage",
		task: {
			id: "held-fact",
			message: "Which exported helper owns cancellation in the queue module?",
			expect: "fact-in-repo",
		},
	},
	{
		suite: "evidence",
		task: {
			id: "held-failed-check",
			assignment: "Acceptance: bun test test/queue.test.ts must pass.",
			output: "bun test test/queue.test.ts: 2 failed. Everything is ready to merge.",
			expect: "weak",
		},
	},
	{
		suite: "findings",
		task: {
			id: "held-naming",
			findings: [
				{
					id: "style",
					title: "Use a nicer local variable name",
					body: "The current name is not elegant.",
					priority: "P3",
					confidence: 0.9,
					file_path: "src/queue.ts",
					line_start: 10,
					line_end: 10,
				},
			],
			expectKeptIds: [],
			expectPriorities: {},
		},
	},
];

interface Args {
	taskIds: string[];
	repeat: number;
	list: boolean;
	json: boolean;
	suite: SuiteName;
	heldOut: boolean;
}

interface AttemptTelemetry {
	requested: boolean;
	succeeded: boolean;
	failed: boolean;
	failureCategory: string | null;
}

interface AttemptRecord {
	hit: boolean;
	latencyMs: number;
	abstained: boolean;
	compression: number | null;
	observed: string[];
	failureCategory: string | null;
}

interface TaskRecord {
	id: string;
	hits: number;
	attempts: AttemptRecord[];
}

interface CapabilityRecord {
	capability: Capability;
	hits: number;
	attempts: number;
	accuracy: number;
	abstentions: number;
	medianLatencyMs: number;
	p95LatencyMs: number;
	misses: string[];
	tasks: TaskRecord[];
}

interface EvalArtifact {
	suite: SuiteName;
	split: "original" | "held-out";
	model: string;
	endpoint: string;
	corpusHash: string;
	runnerHash: string;
	repeat: number;
	startedAt: string;
	capabilities: CapabilityRecord[];
	overall: { hits: number; attempts: number; accuracy: number; abstentions: number };
}

const CASES: Record<Capability, EvalCase[]> = {
	brief: BRIEF_TASKS.map(task => ({ suite: "brief", task })),
	route: ROUTE_TASKS.map(task => ({ suite: "route", task })),
	context: CONTEXT_TASKS.map(task => ({ suite: "context", task })),
	triage: TRIAGE_TASKS.map(task => ({ suite: "triage", task })),
	evidence: EVIDENCE_TASKS.map(task => ({ suite: "evidence", task })),
	findings: FINDING_TASKS.map(task => ({ suite: "findings", task })),
};

const RESULTS_DIR = `${import.meta.dir}/results`;

/** Origin only: the configured endpoint may carry a key or signed path. */
function endpointOrigin(): string {
	try {
		return new URL(jevEndpoint()).origin;
	} catch {
		return "unparseable";
	}
}

/** Pins the labels a score was measured against, so a later corpus edit is visible. */
async function corpusHash(heldOut: boolean): Promise<string> {
	const source = heldOut ? JSON.stringify(HELD_OUT_CASES) : await Bun.file(`${import.meta.dir}/tasks.ts`).text();
	return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

function parseArgs(argv: string[]): Args {
	const args: Args = { taskIds: [], repeat: 1, list: false, json: false, suite: "all", heldOut: false };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new Error(`${flag} needs a value`);
			return next;
		};
		switch (flag) {
			case "--held-out":
				args.heldOut = true;
				break;
			case "--task":
				args.taskIds.push(value());
				break;
			case "--repeat":
				args.repeat = Number(value());
				break;
			case "--suite": {
				const suite = value();
				if (!SUITE_NAMES.includes(suite as SuiteName)) throw new Error(`Unknown suite: ${suite}`);
				args.suite = suite as SuiteName;
				break;
			}
			case "--list":
				args.list = true;
				break;
			case "--json":
				args.json = true;
				break;
			default:
				throw new Error(`Unknown flag: ${flag}`);
		}
	}
	if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error("--repeat must be a positive integer");
	return args;
}

function casesFor(args: Args): EvalCase[] {
	const pool = args.heldOut ? HELD_OUT_CASES : Object.values(CASES).flat();
	const selected = args.suite === "all" ? pool : pool.filter(entry => entry.suite === args.suite);
	if (args.taskIds.length === 0) return selected;
	const requested = new Set(args.taskIds);
	const found = selected.filter(entry => requested.has(entry.task.id));
	const missing = args.taskIds.filter(id => !found.some(entry => entry.task.id === id));
	if (missing.length > 0) throw new Error(`Unknown task id for suite ${args.suite}: ${missing.join(", ")}`);
	return found;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function percentile(values: number[], percentileValue: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
	return sorted[Math.max(0, index)]!;
}

function textChars(sections: string[]): number {
	return sections.join("\n\n").length;
}

function sameIds(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}
function createTelemetry(): AttemptTelemetry {
	return { requested: false, succeeded: false, failed: false, failureCategory: null };
}

function createPost(telemetry: AttemptTelemetry): typeof postSystemOne {
	return async (body: JevRequest, options?: JevPostOptions): Promise<JevResponse> => {
		telemetry.requested = true;
		try {
			const response = await postSystemOne(body, options);
			for (const [id, question] of Object.entries(body.questions)) {
				const answer = response.answers[id];
				if (answer === undefined) throw new JevError(`Missing Jev answer: ${id}`, "invalid");
				if (question.type === "choice")
					validateChoice(answer, Object.keys((question as JevChoiceQuestion).criteria));
				else validateNoul(answer);
			}
			telemetry.succeeded = true;
			return response;
		} catch (error) {
			telemetry.failed = true;
			telemetry.failureCategory = error instanceof JevError ? error.kind : "unknown";
			throw error;
		}
	};
}

async function evaluate(
	entry: EvalCase,
	post: typeof postSystemOne,
): Promise<{ hit: boolean; abstained: boolean; compression: number | null; observed: string[] }> {
	switch (entry.suite) {
		case "brief": {
			const assessments = await assessBriefs({
				assignments: [{ name: "work-item", task: entry.task.assignment, context: entry.task.context }],
				post,
				timeoutMs: 8_000,
			});
			const result = assessments.find(assessment => assessment.name === "work-item");
			const predicted = result?.gaps ?? [];
			return {
				hit: sameIds([...predicted].sort(), [...entry.task.expectGaps].sort()),
				abstained: false,
				compression: null,
				observed: predicted,
			};
		}
		case "route": {
			const choice = await routeAgent({
				assignment: entry.task.assignment,
				context: entry.task.context,
				agents: [...ROUTE_AGENTS],
				post,
			});
			return {
				hit: choice === entry.task.expect,
				abstained: choice === undefined,
				compression: null,
				observed: choice ? [choice] : [],
			};
		}
		case "context": {
			const result = await selectRelevantContext({
				assignment: entry.task.assignment,
				context: entry.task.context,
				snapshot: entry.task.snapshot,
				post,
			});
			const joined = result.sections.join("\n\n");
			const hit =
				entry.task.expectSections.every(expected => joined.includes(expected)) &&
				entry.task.rejectSections.every(rejected => !joined.includes(rejected)) &&
				(!entry.task.requireUniqueSections || new Set(result.sections).size === result.sections.length);
			const snapshotChars = entry.task.snapshot.length;
			return {
				hit,
				abstained: result.method === "none",
				compression: snapshotChars === 0 ? null : textChars(result.sections) / snapshotChars,
				observed: result.sections.map(section => {
					const index = entry.task.snapshot
						.split("\n## ")
						.slice(1)
						.map(part => `## ${part}`.trim())
						.indexOf(section);
					return index >= 0 ? `source-section-${index}` : "partial-section";
				}),
			};
		}
		case "triage": {
			const result = await triageChildQuestion({ message: entry.task.message, post });
			return {
				hit: result?.kind === entry.task.expect,
				abstained: result === undefined,
				compression: null,
				observed: result ? [result.kind] : [],
			};
		}
		case "evidence": {
			const result = await assessResultEvidence({
				assignment: entry.task.assignment,
				output: entry.task.output,
				post,
			});
			return {
				hit: result?.evidence === entry.task.expect,
				abstained: result === undefined,
				compression: null,
				observed: result ? [result.evidence] : [],
			};
		}
		case "findings": {
			const result = await filterReviewFindings({ findings: entry.task.findings, post });
			const keptIds = result.kept.map(finding =>
				"id" in finding && typeof finding.id === "string" ? finding.id : "",
			);
			const prioritiesMatch = Object.entries(entry.task.expectPriorities).every(([id, priority]) => {
				const kept = result.kept.find(finding => "id" in finding && finding.id === id);
				return kept?.priority === priority;
			});
			return {
				hit:
					sameIds(keptIds, entry.task.expectKeptIds) &&
					prioritiesMatch &&
					result.dropped === entry.task.findings.length - entry.task.expectKeptIds.length,
				abstained: false,
				compression: null,
				observed: result.kept.map(finding => `${"id" in finding ? finding.id : "unknown"}:${finding.priority}`),
			};
		}
	}
}

async function runAttempt(entry: EvalCase): Promise<AttemptRecord> {
	const started = performance.now();
	const telemetry = createTelemetry();
	try {
		const result = await evaluate(entry, createPost(telemetry));
		const failed = telemetry.failed || !telemetry.succeeded;
		return {
			...result,
			hit: failed ? false : result.hit,
			abstained: failed ? true : result.abstained,
			latencyMs: Math.round(performance.now() - started),
			failureCategory: telemetry.failureCategory,
		};
	} catch {
		return {
			hit: false,
			abstained: true,
			compression: null,
			observed: [],
			latencyMs: Math.round(performance.now() - started),
			failureCategory: telemetry.failureCategory ?? "unknown",
		};
	}
}

async function runCases(entries: EvalCase[], repeat: number): Promise<TaskRecord[]> {
	const jobs: Array<{ entry: EvalCase; index: number }> = [];
	for (const entry of entries) for (let index = 0; index < repeat; index++) jobs.push({ entry, index });
	const attemptsById = new Map<string, AttemptRecord[]>();
	for (let start = 0; start < jobs.length; start += 4) {
		const batch = jobs.slice(start, start + 4);
		const results = await Promise.all(batch.map(job => runAttempt(job.entry)));
		for (let index = 0; index < batch.length; index++) {
			const id = batch[index]!.entry.task.id;
			const attempts = attemptsById.get(id) ?? [];
			attempts.push(results[index]!);
			attemptsById.set(id, attempts);
		}
	}
	return entries.map(entry => {
		const attempts = attemptsById.get(entry.task.id) ?? [];
		return { id: entry.task.id, hits: attempts.filter(attempt => attempt.hit).length, attempts };
	});
}

function summarizeCapability(capability: Capability, tasks: TaskRecord[]): CapabilityRecord {
	const attempts = tasks.flatMap(task => task.attempts);
	const hits = attempts.filter(attempt => attempt.hit).length;
	const latencies = attempts.map(attempt => attempt.latencyMs);
	return {
		capability,
		hits,
		attempts: attempts.length,
		accuracy: attempts.length === 0 ? 0 : hits / attempts.length,
		abstentions: attempts.filter(attempt => attempt.abstained).length,
		medianLatencyMs: median(latencies),
		p95LatencyMs: percentile(latencies, 0.95),
		misses: tasks.filter(task => task.hits < task.attempts.length).map(task => task.id),
		tasks,
	};
}

function rows(capabilities: CapabilityRecord[]): string {
	const header = "| capability | accuracy | abstentions | median ms | p95 ms | misses |";
	const divider = "| --- | --- | --- | ---: | ---: | --- |";
	const body = capabilities.map(
		capability =>
			`| ${capability.capability} | ${capability.hits}/${capability.attempts} (${(capability.accuracy * 100).toFixed(1)}%) | ${capability.abstentions} | ${capability.medianLatencyMs} | ${capability.p95LatencyMs} | ${capability.misses.join(", ") || "none"} |`,
	);
	return [header, divider, ...body].join("\n");
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	const entries = casesFor(args);
	if (args.list) {
		for (const entry of entries) console.log(`${entry.suite}\t${entry.task.id}`);
		return;
	}
	if (!jevAvailable()) {
		throw new Error(
			"Jev unavailable: set TYPESAFE_SYSTEMONE_URL to a non-empty endpoint or configure the codemc proxy.",
		);
	}
	const startedAt = new Date().toISOString();
	const initialCorpusHash = await corpusHash(args.heldOut);
	const runnerHash = new Bun.CryptoHasher("sha256").update(await Bun.file(import.meta.path).text()).digest("hex");
	const byCapability = new Map<Capability, EvalCase[]>();
	for (const entry of entries) {
		const group = byCapability.get(entry.suite) ?? [];
		group.push(entry);
		byCapability.set(entry.suite, group);
	}
	const records: CapabilityRecord[] = [];
	for (const capability of ["brief", "route", "context", "triage", "evidence", "findings"] as const) {
		const group = byCapability.get(capability);
		if (!group) continue;
		records.push(summarizeCapability(capability, await runCases(group, args.repeat)));
	}
	const hits = records.reduce((sum, record) => sum + record.hits, 0);
	const attempts = records.reduce((sum, record) => sum + record.attempts, 0);
	const abstentions = records.reduce((sum, record) => sum + record.abstentions, 0);
	const artifact: EvalArtifact = {
		suite: args.suite,
		split: args.heldOut ? "held-out" : "original",
		model: jevModel(),
		endpoint: endpointOrigin(),
		corpusHash: initialCorpusHash,
		runnerHash,
		repeat: args.repeat,
		startedAt,
		capabilities: records,
		overall: { hits, attempts, accuracy: attempts === 0 ? 0 : hits / attempts, abstentions },
	};
	if ((await corpusHash(args.heldOut)) !== initialCorpusHash) throw new Error("Corpus changed during the evaluation");
	const stamp = startedAt.replace(/[:.]/g, "-");
	const jsonPath = `${RESULTS_DIR}/${args.suite}-${stamp}.json`;
	const mdPath = `${RESULTS_DIR}/${args.suite}-${stamp}.md`;
	await Bun.write(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
	const table = rows(records);
	const report = `# subagent-assist eval\n\nmodel: ${jevModel()}\nendpoint: ${endpointOrigin()}\ncorpus: ${artifact.corpusHash}\nrepeat: ${args.repeat}\n\n${table}\n\noverall: ${hits}/${attempts} (${(artifact.overall.accuracy * 100).toFixed(1)}%)\nabstentions: ${abstentions}\n`;
	await Bun.write(mdPath, report);
	if (args.json) console.log(JSON.stringify(artifact, null, 2));
	else {
		console.log(table);
		console.log(`\noverall: ${hits}/${attempts} (${(artifact.overall.accuracy * 100).toFixed(1)}%)`);
		console.log(`abstentions: ${abstentions}`);
		console.log(`results: ${jsonPath}, ${mdPath}`);
	}
	if (hits < attempts) process.exitCode = 1;
}

await main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
