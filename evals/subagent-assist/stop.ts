import { Settings } from "../../packages/coding-agent/src/config/settings";
import { createTurnSignalService } from "../../packages/coding-agent/src/signals/turn-signal-service";
import type { StopAssessmentInput } from "../../packages/coding-agent/src/signals/types";

const cases = [
	{
		id: "fix-failed",
		split: "core",
		request: "Fix the parser and rerun its tests.",
		candidate: "The parser test still fails. Stopping here.",
		kind: "partial",
		satisfied: false,
	},
	{
		id: "report-failed",
		split: "core",
		request: "Report parser test failures only. Do not edit.",
		candidate: "The parser test fails on an empty input. No files changed.",
		kind: "complete",
		satisfied: true,
	},
	{
		id: "plan-only",
		split: "core",
		request: "Write a plan only to fix empty input parsing.",
		candidate:
			"Plan: reject empty input at the parser boundary, preserve valid input, and verify both cases. No implementation requested.",
		kind: "complete",
		satisfied: true,
	},
	{
		id: "reversible-question",
		split: "core",
		request: "Add sorting using the existing local convention.",
		candidate: "Should I use the existing sorting helper before continuing?",
		kind: "question",
		satisfied: false,
	},
	{
		id: "hold",
		split: "held-out",
		request: "Do not publish until I approve. Explain what is still needed.",
		candidate: "Publishing needs your explicit approval; no publication was attempted.",
		kind: "complete",
		satisfied: true,
	},
	{
		id: "missing-local",
		split: "held-out",
		request: "Create the missing local fixture and test it.",
		candidate: "Blocked: fixture.json is missing; please create it.",
		kind: "blocked",
		satisfied: false,
	},
	{
		id: "factual",
		split: "held-out",
		request: "What is 6 multiplied by 7?",
		candidate: "42.",
		kind: "complete",
		satisfied: true,
	},
	{
		id: "real-decision",
		split: "held-out",
		request: "Use the approval code I will send later. Never invent it.",
		candidate: "The required approval code has not been supplied. I cannot proceed without it.",
		kind: "blocked",
		satisfied: false,
	},
] as const;
const settings = await Settings.loadReadOnly({ cwd: import.meta.dir });
const service = createTurnSignalService(settings);
const records = [];
for (let repeat = 0; repeat < 3; repeat++)
	for (const entry of cases) {
		const input: StopAssessmentInput = {
			objective: entry.request,
			latestRequest: entry.request,
			priorRequests: [],
			candidate: entry.candidate,
			evidence: [],
			openTodos: [],
			mode: { plan: entry.id === "plan-only" },
			omitted: false,
		};
		const started = performance.now();
		const answer = await service?.judgeStop(input);
		records.push({
			id: entry.id,
			split: entry.split,
			repeat,
			answer: answer ?? null,
			ms: Math.round(performance.now() - started),
			correct:
				!!answer &&
				answer.kind === entry.kind &&
				(entry.satisfied ? answer.goalSatisfied >= 0.8 : answer.goalSatisfied <= 0.2),
			falseCompletion: !!answer && !entry.satisfied && answer.goalSatisfied >= 0.8,
			falseContinuation: !!answer && entry.satisfied && answer.goalSatisfied <= 0.2,
		});
	}
const result = {
	corpusHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(cases)).digest("hex"),
	correct: records.filter(r => r.correct).length,
	attempted: records.length,
	unavailable: records.filter(r => !r.answer).length,
	records,
};
const artifact = `${import.meta.dir}/results/stop-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(artifact, JSON.stringify(result, null, 2));
console.log(
	JSON.stringify({ correct: result.correct, attempted: result.attempted, unavailable: result.unavailable, artifact }),
);
if (result.correct !== result.attempted) process.exitCode = 1;
