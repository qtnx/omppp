import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getReviewFindingDetail,
	listReviewFindings,
	type ReviewFindingGeneratedLesson,
	recordReviewFindings,
	triggerReviewFindingLessonGeneration,
} from "../src/review-findings";
import { handleStatsApiRequest } from "../src/server";

const tempDirs = new Set<string>();

async function makeTempDb(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-review-findings-"));
	tempDirs.add(dir);
	return path.join(dir, "agent.db");
}

function generatedLesson(): ReviewFindingGeneratedLesson {
	return {
		facts: ["Reviewer findings are stored before a human decides whether they become durable lessons."],
		lesson: "Generate distilled repo learnings from reviewer findings instead of saving the raw review comment.",
		rationale: "Raw review comments include situational detail that is too noisy for durable repo guidance.",
		applyWhen: ["A reviewer finding exposes a repeatable repo-specific mistake."],
		avoid: ["Do not copy the review body directly into live_learnings."],
		sourceSummary: "Derived from a review finding about preserving review findings.",
	};
}

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	let lastError: unknown;
	while (Date.now() - start < timeoutMs) {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
			await Bun.sleep(25);
		}
	}
	throw lastError;
}

describe("review findings persistence", () => {
	afterEach(async () => {
		for (const dir of tempDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		tempDirs.clear();
	});

	test("records findings by repo root and dedupes identical repeats", async () => {
		const dbPath = await makeTempDb();
		const repoA = path.join(path.dirname(dbPath), "left", "same-name");
		const repoB = path.join(path.dirname(dbPath), "right", "same-name");

		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 100,
			repoName: "same-name",
			repoRoot: repoA,
			cwd: repoA,
			agent: "reviewer",
			taskId: "ReviewA",
			taskDescription: "review left",
			taskAssignment: "review left assignment",
			outputPath: "/tmp/review-a.md",
			sessionFile: "/tmp/session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Fix stale state handling",
					body: "The reviewer found stale state is reused after refresh.",
					priority: "P1",
					confidence: 0.91,
					file_path: "src/state.ts",
					line_start: 12,
					line_end: 18,
				},
			],
		});
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 120,
			repoName: "same-name",
			repoRoot: repoA,
			cwd: repoA,
			agent: "reviewer",
			taskId: "ReviewA2",
			taskDescription: "review left again",
			taskAssignment: "review left assignment again",
			outputPath: "/tmp/review-a2.md",
			sessionFile: "/tmp/session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Fix stale state handling",
					body: "The reviewer found stale state is reused after refresh.",
					priority: "P1",
					confidence: 0.94,
					file_path: "src/state.ts",
					line_start: 12,
					line_end: 18,
				},
			],
		});
		const backfillRepeatCount = await recordReviewFindings({
			agentDbPath: dbPath,
			mode: "backfill",
			nowSec: 125,
			repoName: "same-name",
			repoRoot: repoA,
			cwd: repoA,
			agent: "code-reviewer",
			taskId: "BackfillReviewA",
			taskDescription: "backfill left again",
			taskAssignment: "backfill left assignment again",
			outputPath: "/tmp/backfill-review-a.md",
			sessionFile: "/tmp/backfill-session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Fix stale state handling",
					body: "The reviewer found stale state is reused after refresh.",
					priority: "P1",
					confidence: 0.96,
					file_path: "src/state.ts",
					line_start: 12,
					line_end: 18,
				},
			],
		});
		expect(backfillRepeatCount).toBe(0);
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 130,
			repoName: "same-name",
			repoRoot: repoB,
			cwd: repoB,
			agent: "code-reviewer",
			taskId: "ReviewB",
			taskDescription: "review right",
			taskAssignment: "review right assignment",
			outputPath: "",
			sessionFile: "",
			resolvedModel: "openai/test",
			taskExitCode: 1,
			taskAborted: true,
			findings: [
				{
					title: "Fix stale state handling",
					body: "The reviewer found stale state is reused after refresh.",
					priority: "P1",
					confidence: 0.8,
					file_path: "src/state.ts",
					line_start: 12,
					line_end: 18,
				},
			],
		});

		const repoAList = await listReviewFindings({ agentDbPath: dbPath, repoRoot: repoA });
		expect(repoAList.total).toBe(1);
		expect(repoAList.findings[0]).toMatchObject({
			repoRoot: repoA,
			repoName: "same-name",
			occurrenceCount: 2,
			lastSeenAt: 120,
			priorityLabel: "P1",
			priority: 1,
		});

		const all = await listReviewFindings({ agentDbPath: dbPath });
		expect(all.total).toBe(2);
		expect(all.repos).toEqual([
			{ repoName: "same-name", repoRoot: repoB, pendingCount: 1, savedCount: 0 },
			{ repoName: "same-name", repoRoot: repoA, pendingCount: 1, savedCount: 0 },
		]);
	});

	test("skips malformed source line ranges before persistence", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 150,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "reviewer",
			taskId: "ReviewBadLines",
			taskDescription: "review malformed lines",
			taskAssignment: "review assignment",
			outputPath: "",
			sessionFile: "",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Reject zero line",
					body: "Zero is not a file line.",
					priority: "P1",
					confidence: 0.9,
					file_path: "src/file.ts",
					line_start: 0,
					line_end: 1,
				},
				{
					title: "Reject fractional line",
					body: "Fractional values are not file lines.",
					priority: "P1",
					confidence: 0.9,
					file_path: "src/file.ts",
					line_start: 1.5,
					line_end: 2,
				},
				{
					title: "Reject reversed range",
					body: "The end line cannot precede the start line.",
					priority: "P1",
					confidence: 0.9,
					file_path: "src/file.ts",
					line_start: 3,
					line_end: 2,
				},
			],
		});

		const list = await listReviewFindings({ agentDbPath: dbPath });
		expect(list.total).toBe(0);
	});

	test("generates a distilled learning lesson asynchronously instead of saving the raw review body", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 200,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "reviewer",
			taskId: "Review",
			taskDescription: "review repo",
			taskAssignment: "review assignment",
			outputPath: "/tmp/review.md",
			sessionFile: "/tmp/session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Preserve review findings",
					body: "Reviewer findings must survive repeated task runs.",
					priority: "P2",
					confidence: 0.87,
					file_path: "packages/stats/src/review-findings.ts",
					line_start: 50,
					line_end: 55,
				},
			],
		});
		const list = await listReviewFindings({ agentDbPath: dbPath });
		const findingId = list.findings[0]?.id;
		expect(findingId).toBeString();

		const detailBefore = await getReviewFindingDetail(findingId, { agentDbPath: dbPath });
		expect(detailBefore?.lessonPreview).toBeNull();
		expect(detailBefore?.generation.status).toBe("idle");

		const triggered = await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 210,
			runReviewFindingLessonJobsInline: true,
			generateReviewFindingLesson: async ({ finding }) => {
				expect(finding.body).toBe("Reviewer findings must survive repeated task runs.");
				return generatedLesson();
			},
		});
		expect(triggered?.alreadySaved).toBe(false);
		expect(triggered?.generation.status).toBe("succeeded");
		expect(triggered?.generation.jobId).toBeString();
		expect(triggered?.finding.learningSavedAt).toBe(210);
		expect(triggered?.lessonPreview).toContain("Facts:");
		expect(triggered?.lessonPreview).toContain("Lesson:");
		expect(triggered?.lessonPreview).toContain("Generate distilled repo learnings");
		expect(triggered?.lessonPreview).not.toContain("Reviewer findings must survive repeated task runs.");

		const second = await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 220,
			runReviewFindingLessonJobsInline: true,
			generateReviewFindingLesson: async () => {
				throw new Error("generator should not be called for an already saved finding");
			},
		});
		expect(second?.alreadySaved).toBe(true);
		expect(second?.generation.status).toBe("succeeded");
		expect(second?.finding.learningSavedAt).toBe(210);

		const db = new Database(dbPath);
		try {
			const rows = db
				.prepare("SELECT id, scope, cwd, content, trigger, confidence FROM live_learnings")
				.all() as Array<{
				id: string;
				scope: string;
				cwd: string;
				content: string;
				trigger: string;
				confidence: number;
			}>;
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				id: triggered?.finding.learningId,
				scope: "repo",
				cwd: repoRoot,
				trigger: "review-finding",
				confidence: 0.87,
			});
			expect(rows[0]?.content).toBe(triggered?.lessonPreview);
			expect(rows[0]?.content).not.toContain("Reviewer findings must survive repeated task runs.");
		} finally {
			db.close();
		}
	});

	test("records streaming generation events and exposes them in detail", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 230,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "reviewer",
			taskId: "ReviewStreaming",
			taskDescription: "review streaming generation",
			taskAssignment: "review assignment",
			outputPath: "/tmp/review-streaming.md",
			sessionFile: "/tmp/session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Show generation debug stream",
					body: "Humans need live generator output to tune lesson prompts.",
					priority: "P1",
					confidence: 0.93,
					file_path: "packages/stats/src/review-findings.ts",
					line_start: 60,
					line_end: 72,
				},
			],
		});
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();

		const triggered = await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 240,
			runReviewFindingLessonJobsInline: true,
			generateReviewFindingLesson: ({ onProgress }) => {
				onProgress({
					status: "running",
					message: "Reading source context",
					lastIntent: "Inspect the reviewed file before distilling the lesson.",
					currentTool: "read",
					currentToolArgs: "packages/stats/src/review-findings.ts:60-72",
					recentOutput: ["Inspecting review finding storage."],
					recentTools: [{ tool: "read", args: "packages/stats/src/review-findings.ts", endMs: 240_000 }],
					toolCount: 1,
					tokens: 42,
					contextTokens: 128,
					contextWindow: 4096,
					cost: 0.001,
					durationMs: 250,
					resolvedModel: "pi/task",
				});
				return generatedLesson();
			},
		});

		expect(triggered?.generation.status).toBe("succeeded");
		expect(triggered?.generation.events.map(event => event.message)).toContain("Reading source context");
		const detail = await getReviewFindingDetail(findingId, { agentDbPath: dbPath });
		const progressEvent = detail?.generation.events.find(event => event.message === "Reading source context");
		expect(progressEvent?.kind).toBe("progress");
		expect(progressEvent?.progress?.currentTool).toBe("read");
		expect(progressEvent?.progress?.currentToolArgs).toBe("packages/stats/src/review-findings.ts:60-72");
		expect(progressEvent?.progress?.recentOutput).toEqual(["Inspecting review finding storage."]);
		expect(progressEvent?.progress?.tokens).toBe(42);
		expect(detail?.generation.events.at(-1)?.message).toBe("Lesson saved");
	});

	test("detail event window keeps latest generation events after long streams", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 250,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "reviewer",
			taskId: "ReviewLongStream",
			taskDescription: "review long streaming generation",
			taskAssignment: "review assignment",
			outputPath: "/tmp/review-long-stream.md",
			sessionFile: "/tmp/session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Keep latest debug stream tail",
					body: "Long generator streams must keep the latest events visible after completion.",
					priority: "P1",
					confidence: 0.91,
					file_path: "packages/stats/src/review-findings.ts",
					line_start: 73,
					line_end: 90,
				},
			],
		});
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();

		await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 260,
			runReviewFindingLessonJobsInline: true,
			generateReviewFindingLesson: ({ onProgress }) => {
				for (let index = 0; index < 205; index++) {
					onProgress({
						status: "running",
						message: `progress-${index}`,
						recentTools: [],
						recentOutput: [`output-${index}`],
						toolCount: index,
						tokens: index,
						cost: 0,
						durationMs: index,
					});
				}
				return generatedLesson();
			},
		});

		const detail = await getReviewFindingDetail(findingId, { agentDbPath: dbPath });
		const messages = detail?.generation.events.map(event => event.message) ?? [];
		expect(messages).not.toContain("Generation queued");
		expect(messages).not.toContain("progress-0");
		expect(messages).toContain("progress-204");
		expect(messages.at(-1)).toBe("Lesson saved");
		expect(detail?.generation.events.length).toBe(200);
	});

	test("preserves saved learning metadata when the same finding is recorded again", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		const input = {
			agentDbPath: dbPath,
			nowSec: 300,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "reviewer",
			taskId: "Review",
			taskDescription: "review repo",
			taskAssignment: "review assignment",
			outputPath: "/tmp/review.md",
			sessionFile: "/tmp/session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Keep saved state",
					body: "Saved review findings must not return to pending.",
					priority: "P0" as const,
					confidence: 0.99,
					file_path: "src/review.ts",
					line_start: 1,
					line_end: 1,
				},
			],
		};
		await recordReviewFindings(input);
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();
		const generated = await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 310,
			runReviewFindingLessonJobsInline: true,
			generateReviewFindingLesson: async () => generatedLesson(),
		});
		expect(generated?.finding.learningId).toBeString();

		await recordReviewFindings({ ...input, nowSec: 320, taskId: "ReviewAgain" });

		const pending = await listReviewFindings({ agentDbPath: dbPath, status: "pending" });
		expect(pending.total).toBe(0);
		const saved = await listReviewFindings({ agentDbPath: dbPath, status: "saved" });
		expect(saved.total).toBe(1);
		expect(saved.findings[0]).toMatchObject({
			id: findingId,
			occurrenceCount: 2,
			learningId: generated?.finding.learningId,
			learningSavedAt: 310,
		});
	});

	test("reuses one running generation job for duplicate triggers", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 330,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "reviewer",
			taskId: "Review",
			taskDescription: "review repo",
			taskAssignment: "review assignment",
			outputPath: "/tmp/review.md",
			sessionFile: "/tmp/session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Avoid duplicate generators",
					body: "Double-clicking should not spawn two lesson generators.",
					priority: "P1",
					confidence: 0.92,
					file_path: "src/review.ts",
					line_start: 2,
					line_end: 3,
				},
			],
		});
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();
		const gate = Promise.withResolvers<ReviewFindingGeneratedLesson>();
		let calls = 0;
		const generator = async () => {
			calls += 1;
			return gate.promise;
		};

		const first = await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 340,
			generateReviewFindingLesson: generator,
		});
		await waitFor(() => expect(calls).toBe(1));
		const second = await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 341,
			generateReviewFindingLesson: generator,
		});
		expect(second?.generation.jobId).toBe(first?.generation.jobId);
		expect(calls).toBe(1);

		gate.resolve(generatedLesson());
		await waitFor(async () => {
			const detail = await getReviewFindingDetail(findingId, { agentDbPath: dbPath });
			expect(detail?.generation.status).toBe("succeeded");
			expect(detail?.finding.learningId).toBeString();
		});
	});

	test("rejects generated lessons that copy the raw review body across fields", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 350,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "reviewer",
			taskId: "Review",
			taskDescription: "review repo",
			taskAssignment: "review assignment",
			outputPath: "/tmp/review.md",
			sessionFile: "/tmp/session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Reject copied raw body",
					body: "No raw",
					priority: "P1",
					confidence: 0.9,
					file_path: "src/review.ts",
					line_start: 4,
					line_end: 4,
				},
			],
		});
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();

		await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 360,
			runReviewFindingLessonJobsInline: true,
			generateReviewFindingLesson: async () => ({
				facts: ["No"],
				lesson: "raw",
				rationale: "Short copied bodies must still be rejected.",
				applyWhen: ["A generated lesson mirrors the finding body."],
				avoid: [],
				sourceSummary: "src/review.ts:4",
			}),
		});

		const detail = await getReviewFindingDetail(findingId, { agentDbPath: dbPath });
		expect(detail?.generation.status).toBe("failed");
		expect(detail?.generation.error).toContain("copied the raw review body");
		expect(detail?.finding.learningId).toBeNull();
		const db = new Database(dbPath);
		try {
			const count = db.prepare("SELECT COUNT(*) AS count FROM live_learnings").get() as { count: number };
			expect(count.count).toBe(0);
		} finally {
			db.close();
		}
	});

	test("rejects generated lessons that copy a long raw review body before truncation", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		const longBody = "Long raw review body must not be copied into generated lessons. ".repeat(12).trim();
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 370,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "reviewer",
			taskId: "Review",
			taskDescription: "review repo",
			taskAssignment: "review assignment",
			outputPath: "/tmp/review.md",
			sessionFile: "/tmp/session.jsonl",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Reject long copied raw body",
					body: longBody,
					priority: "P1",
					confidence: 0.9,
					file_path: "src/review.ts",
					line_start: 5,
					line_end: 6,
				},
			],
		});
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();

		await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 380,
			runReviewFindingLessonJobsInline: true,
			generateReviewFindingLesson: async () => ({
				facts: [longBody],
				lesson: "Use generated lessons.",
				rationale: "This should fail before the copied fact is truncated.",
				applyWhen: ["A review body is long."],
				avoid: [],
				sourceSummary: "src/review.ts:5-6",
			}),
		});

		const detail = await getReviewFindingDetail(findingId, { agentDbPath: dbPath });
		expect(detail?.generation.status).toBe("failed");
		expect(detail?.generation.error).toContain("copied the raw review body");
		expect(detail?.finding.learningId).toBeNull();
	});
});

describe("review findings API", () => {
	afterEach(async () => {
		for (const dir of tempDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		tempDirs.clear();
	});

	test("generate-learning route starts one async job and rejects unsafe requests", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 400,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "code-reviewer",
			taskId: "Review",
			taskDescription: "review repo",
			taskAssignment: "review assignment",
			outputPath: "",
			sessionFile: "",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Block unsafe origin",
					body: "Mutating local dashboard routes must reject cross-origin POSTs.",
					priority: "P1",
					confidence: 0.9,
					file_path: "packages/stats/src/server.ts",
					line_start: 1,
					line_end: 2,
				},
			],
		});
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();

		const blocked = await handleStatsApiRequest(
			new Request(`http://127.0.0.1/api/review-findings/${encodeURIComponent(findingId)}/generate-learning`, {
				method: "POST",
				headers: { Origin: "https://evil.example" },
			}),
			{ agentDbPath: dbPath, nowSec: 410 },
		);
		expect(blocked.status).toBe(403);
		expect(await blocked.json()).toEqual({ error: "Cross-origin learning generation requests are not allowed" });

		const missingGenerator = await handleStatsApiRequest(
			new Request(`http://127.0.0.1/api/review-findings/${encodeURIComponent(findingId)}/generate-learning`, {
				method: "POST",
			}),
			{ agentDbPath: dbPath, nowSec: 415 },
		);
		expect(missingGenerator.status).toBe(503);
		expect(await missingGenerator.json()).toEqual({ error: "Review finding lesson generator is not configured" });

		const generated = await handleStatsApiRequest(
			new Request(`http://127.0.0.1/api/review-findings/${encodeURIComponent(findingId)}/generate-learning`, {
				method: "POST",
			}),
			{
				agentDbPath: dbPath,
				nowSec: 420,
				runReviewFindingLessonJobsInline: true,
				generateReviewFindingLesson: async () => generatedLesson(),
			},
		);
		expect(generated.status).toBe(200);
		const generatedBody = (await generated.json()) as { generation?: { status?: string }; alreadySaved?: boolean };
		expect(generatedBody.generation?.status).toBe("succeeded");
		expect(generatedBody.alreadySaved).toBe(false);

		const badMethod = await handleStatsApiRequest(
			new Request(`http://127.0.0.1/api/review-findings/${encodeURIComponent(findingId)}/generate-learning`, {
				method: "GET",
			}),
			{ agentDbPath: dbPath, nowSec: 430 },
		);
		expect(badMethod.status).toBe(405);
		expect(await badMethod.json()).toEqual({ error: "Method not allowed" });
	});

	test("generate-learning route returns queued before background completion", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 470,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "code-reviewer",
			taskId: "Review",
			taskDescription: "review repo",
			taskAssignment: "review assignment",
			outputPath: "",
			sessionFile: "",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Run async generation",
					body: "Async route should return before the generated lesson is saved.",
					priority: "P1",
					confidence: 0.9,
					file_path: "packages/stats/src/server.ts",
					line_start: 20,
					line_end: 21,
				},
			],
		});
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();
		const gate = Promise.withResolvers<ReviewFindingGeneratedLesson>();
		let calls = 0;

		const queued = await handleStatsApiRequest(
			new Request(`http://127.0.0.1/api/review-findings/${encodeURIComponent(findingId)}/generate-learning`, {
				method: "POST",
			}),
			{
				agentDbPath: dbPath,
				nowSec: 480,
				generateReviewFindingLesson: async () => {
					calls += 1;
					return gate.promise;
				},
			},
		);

		expect(queued.status).toBe(200);
		const queuedBody = (await queued.json()) as { generation?: { status?: string } };
		expect(queuedBody.generation?.status).toBe("queued");
		await waitFor(() => expect(calls).toBe(1));
		gate.resolve(generatedLesson());
		await waitFor(async () => {
			const detail = await getReviewFindingDetail(findingId, { agentDbPath: dbPath });
			expect(detail?.generation.status).toBe("succeeded");
			expect(detail?.finding.learningId).toBeString();
		});
	});

	test("generation-events route returns incremental debug events", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 510,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "code-reviewer",
			taskId: "ReviewEvents",
			taskDescription: "review event stream",
			taskAssignment: "review assignment",
			outputPath: "",
			sessionFile: "",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Stream generation events",
					body: "The dashboard should expose agent progress while the generator is running.",
					priority: "P1",
					confidence: 0.91,
					file_path: "packages/stats/src/server.ts",
					line_start: 30,
					line_end: 31,
				},
			],
		});
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();
		await triggerReviewFindingLessonGeneration(findingId, {
			agentDbPath: dbPath,
			nowSec: 520,
			runReviewFindingLessonJobsInline: true,
			generateReviewFindingLesson: ({ onProgress }) => {
				onProgress({
					status: "running",
					message: "Writer is reading related source",
					currentTool: "read",
					currentToolArgs: "packages/stats/src/server.ts:230-260",
					recentOutput: ["Checking route behavior."],
					recentTools: [],
					toolCount: 1,
					tokens: 64,
					cost: 0.002,
					durationMs: 300,
				});
				return generatedLesson();
			},
		});
		const detail = await getReviewFindingDetail(findingId, { agentDbPath: dbPath });
		const progressEvent = detail?.generation.events.find(
			event => event.message === "Writer is reading related source",
		);
		expect(progressEvent?.sequence).toBeNumber();

		const eventsResponse = await handleStatsApiRequest(
			new Request(
				`http://127.0.0.1/api/review-findings/${encodeURIComponent(findingId)}/generation-events?after=${(progressEvent?.sequence ?? 1) - 1}`,
			),
			{ agentDbPath: dbPath },
		);
		expect(eventsResponse.status).toBe(200);
		const eventsBody = (await eventsResponse.json()) as {
			events?: Array<{ sequence: number; message: string; progress?: { currentTool?: string } | null }>;
			generation?: { status?: string };
		};
		expect(eventsBody.generation?.status).toBe("succeeded");
		expect(eventsBody.events?.[0]).toMatchObject({
			sequence: progressEvent?.sequence,
			message: "Writer is reading related source",
			progress: { currentTool: "read" },
		});

		const emptyResponse = await handleStatsApiRequest(
			new Request(
				`http://127.0.0.1/api/review-findings/${encodeURIComponent(findingId)}/generation-events?after=${detail?.generation.events.at(-1)?.sequence ?? 0}`,
			),
			{ agentDbPath: dbPath },
		);
		expect(emptyResponse.status).toBe(200);
		const emptyBody = (await emptyResponse.json()) as { events?: unknown[] };
		expect(emptyBody.events).toEqual([]);
	});

	test("save-learning route is disabled and does not write raw review body", async () => {
		const dbPath = await makeTempDb();
		const repoRoot = path.join(path.dirname(dbPath), "repo");
		await recordReviewFindings({
			agentDbPath: dbPath,
			nowSec: 440,
			repoName: "repo",
			repoRoot,
			cwd: repoRoot,
			agent: "code-reviewer",
			taskId: "Review",
			taskDescription: "review repo",
			taskAssignment: "review assignment",
			outputPath: "",
			sessionFile: "",
			resolvedModel: "openai/test",
			taskExitCode: 0,
			taskAborted: false,
			findings: [
				{
					title: "Disable raw save",
					body: "The old save route must not write this raw body.",
					priority: "P1",
					confidence: 0.9,
					file_path: "packages/stats/src/server.ts",
					line_start: 10,
					line_end: 11,
				},
			],
		});
		const findingId = (await listReviewFindings({ agentDbPath: dbPath })).findings[0]?.id;
		expect(findingId).toBeString();

		const response = await handleStatsApiRequest(
			new Request(`http://127.0.0.1/api/review-findings/${encodeURIComponent(findingId)}/save-learning`, {
				method: "POST",
			}),
			{ agentDbPath: dbPath, nowSec: 450 },
		);

		expect(response.status).toBe(410);
		expect(await response.json()).toEqual({ error: "Use generate-learning to create a distilled lesson" });
		const db = new Database(dbPath);
		try {
			const count = db.prepare("SELECT COUNT(*) AS count FROM live_learnings").get() as { count: number };
			expect(count.count).toBe(0);
		} finally {
			db.close();
		}
	});

	test("bad encoded review finding ids return JSON 400", async () => {
		const response = await handleStatsApiRequest(
			new Request("http://127.0.0.1/api/review-findings/%E0%A4%A/generate-learning", { method: "POST" }),
			{ agentDbPath: await makeTempDb(), nowSec: 500 },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Bad Request" });
	});
});
