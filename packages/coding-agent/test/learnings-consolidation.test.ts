import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { maybeRunLearningConsolidation } from "@oh-my-pi/pi-coding-agent/learnings/consolidate";
import * as repoKey from "@oh-my-pi/pi-coding-agent/learnings/repo-key";
import * as storage from "@oh-my-pi/pi-coding-agent/learnings/storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

interface LearningRow {
	id: string;
	content: string;
	content_hash: string;
	status: string;
	merged_into: string | null;
	strength: number;
	useful_count: number;
	not_useful_count: number;
	updated_at: number;
	repo_key: string | null;
}

interface JobRow {
	status: string;
	finished_at: number | null;
	retry_at: number | null;
	retry_remaining: number;
	input_watermark: number | null;
	last_success_watermark: number | null;
}

interface Fixture {
	root: string;
	agentDir: string;
	cwd: string;
	db: Database;
	settings: Settings;
	session: AgentSession;
	modelRegistry: ModelRegistry;
}

const createdRoots = new Set<string>();

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function createModel(id: string): Model {
	return {
		provider: "openai",
		id,
		name: id,
		contextWindow: 32_000,
	} as Model;
}

async function createFixture(overrides?: Partial<Record<string, unknown>>): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-learnings-consolidation-"));
	createdRoots.add(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "repo", "current");
	await Promise.all([fs.mkdir(agentDir, { recursive: true }), fs.mkdir(cwd, { recursive: true })]);
	const model = createModel("plan-model");
	const settings = Settings.isolated({
		"learning.enabled": true,
		"learning.maxEntriesPerScope": 40,
		"learning.consolidation.minEntries": 1,
		"learning.consolidation.intervalDays": 7,
		"learning.consolidation.timeoutMs": 5_000,
		...(overrides ?? {}),
	});
	const session = {
		sessionId: "session-1",
		sessionManager: {
			getCwd: () => cwd,
			getSessionFile: () => path.join(agentDir, "sessions", "session-1.jsonl"),
		},
		settings,
		model,
	} as unknown as AgentSession;
	const modelRegistry = {
		getAvailable: vi.fn(() => [model]),
		getAll: vi.fn(() => [model]),
		find: vi.fn(() => model),
		getApiKey: vi.fn(async () => "test-api-key"),
	} as unknown as ModelRegistry;
	return {
		root,
		agentDir,
		cwd,
		db: storage.openLearningDb(getAgentDbPath(agentDir)),
		settings,
		session,
		modelRegistry,
	};
}

function store(fixture: Fixture, content: string, now = 100, repoKeyValue = fixture.cwd): LearningRow {
	storage.upsertLearning(fixture.db, {
		scope: "repo",
		cwd: fixture.cwd,
		repoKey: repoKeyValue,
		content,
		sourceMessageHash: `message-${content}`,
		trigger: "test",
		confidence: 0.8,
		nowSec: now,
	});
	return readLearningByContent(fixture.db, content);
}

function readLearningByContent(db: Database, content: string): LearningRow {
	const row = db.prepare("SELECT * FROM live_learnings WHERE content = ?").get(content) as LearningRow | null;
	if (!row) throw new Error(`Missing learning: ${content}`);
	return row;
}

function readJob(db: Database, jobKey: string): JobRow {
	const row = db
		.prepare(
			"SELECT status, finished_at, retry_at, retry_remaining, input_watermark, last_success_watermark FROM live_learning_jobs WHERE kind = 'consolidation' AND job_key = ?",
		)
		.get(jobKey) as JobRow | null;
	if (!row) throw new Error(`Missing job: ${jobKey}`);
	return row;
}

function alias(row: LearningRow): string {
	return row.content_hash.slice(0, 12);
}

function subprocessResult(output: string, exitCode = 0): SingleResult {
	return {
		index: 0,
		id: "learning-consolidator",
		agent: "learning-consolidator",
		agentSource: "bundled",
		task: "consolidate learnings",
		exitCode,
		output,
		stderr: exitCode === 0 ? "" : "subagent failed",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
	};
}

function runOptions(fixture: Fixture, force = false) {
	return {
		session: fixture.session,
		settings: fixture.settings,
		modelRegistry: fixture.modelRegistry,
		agentDir: fixture.agentDir,
		force,
	};
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const root of createdRoots) {
		await fs.rm(root, { recursive: true, force: true });
	}
	createdRoots.clear();
});

describe("learnings/consolidate", () => {
	test("merges source entries into a survivor with capped summed statistics and audit dumps", async () => {
		const fixture = await createFixture();
		const repoKeyValue = path.dirname(fixture.cwd);
		const first = store(fixture, "Verify runtime behavior before claiming success.", 100, repoKeyValue);
		const second = store(fixture, "Run the real caller path before declaring success.", 101, repoKeyValue);
		storage.recordLearningFeedback(fixture.db, {
			learningId: second.id,
			sessionId: "session-1",
			verdict: "useful",
			nowSec: 102,
		});
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(
			subprocessResult(
				JSON.stringify({
					ops: [
						{
							op: "merge",
							ids: [alias(first), alias(second)],
							content: "Verify behavior through the real caller path before claiming success.",
						},
					],
				}),
			),
		);

		const reports = await maybeRunLearningConsolidation(runOptions(fixture, true));

		expect(reports).toEqual([
			{ target: "global", outcome: "applied", opsApplied: 0, opsSkippedStale: 0 },
			{ target: `repo:${repoKeyValue}`, outcome: "applied", opsApplied: 1, opsSkippedStale: 0 },
		]);
		const survivor = readLearningByContent(
			fixture.db,
			"Verify behavior through the real caller path before claiming success.",
		);
		expect(readLearningByContent(fixture.db, first.content)).toMatchObject({
			status: "merged",
			merged_into: survivor.id,
		});
		expect(readLearningByContent(fixture.db, second.content)).toMatchObject({
			status: "merged",
			merged_into: survivor.id,
		});
		expect(survivor).toMatchObject({ strength: 2.5, useful_count: 1, not_useful_count: 0 });
		const auditRoot = path.join(fixture.agentDir, "learning-audit", "consolidation");
		const auditRuns = await Promise.all(
			(await fs.readdir(auditRoot)).map(async runId => ({
				runId,
				request: await Bun.file(path.join(auditRoot, runId, "request.json")).json(),
			})),
		);
		const repoRun = auditRuns.find(run => run.request.target === `repo:${repoKeyValue}`);
		expect(repoRun).toBeDefined();
		if (!repoRun) throw new Error("Missing repo consolidation audit run");
		const auditDir = path.join(auditRoot, repoRun.runId);
		expect(repoRun.request).toMatchObject({ target: `repo:${repoKeyValue}` });
		expect(await Bun.file(path.join(auditDir, "ops.json")).json()).toMatchObject({ ops: expect.any(Array) });
		expect(await Bun.file(path.join(auditDir, "result.json")).json()).toMatchObject({ outcome: "applied" });
	});

	test("skips a stale guarded rewrite and counts the stale operation", async () => {
		const fixture = await createFixture();
		const repoKeyValue = path.dirname(fixture.cwd);
		const source = store(fixture, "Specific wording that must survive a stale rewrite.", 100, repoKeyValue);
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async () => {
			storage.reinforceLearning(fixture.db, { id: source.id, confidence: 0.9, nowSec: 200 });
			return subprocessResult(
				JSON.stringify({
					ops: [{ op: "rewrite", id: alias(source), content: "A generalized replacement." }],
				}),
			);
		});

		const reports = await maybeRunLearningConsolidation(runOptions(fixture, true));

		expect(reports[1]).toEqual({
			target: `repo:${repoKeyValue}`,
			outcome: "applied",
			opsApplied: 0,
			opsSkippedStale: 1,
		});
		expect(readLearningByContent(fixture.db, source.content).content).toBe(source.content);
	});

	test("skips an entire merge when any snapshot source becomes stale", async () => {
		const fixture = await createFixture();
		const repoKeyValue = path.dirname(fixture.cwd);
		const first = store(fixture, "First source must remain active.", 100, repoKeyValue);
		const second = store(fixture, "Second source must remain active.", 101, repoKeyValue);
		const mergedContent = "A stale merge must not create this survivor.";
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async () => {
			storage.reinforceLearning(fixture.db, { id: first.id, confidence: 0.9, nowSec: 200 });
			return subprocessResult(
				JSON.stringify({
					ops: [{ op: "merge", ids: [alias(first), alias(second)], content: mergedContent }],
				}),
			);
		});

		const reports = await maybeRunLearningConsolidation(runOptions(fixture, true));

		expect(reports[1]).toEqual({
			target: `repo:${repoKeyValue}`,
			outcome: "applied",
			opsApplied: 0,
			opsSkippedStale: 1,
		});
		expect(
			fixture.db.prepare("SELECT COUNT(*) AS count FROM live_learnings WHERE content = ?").get(mergedContent),
		).toEqual({ count: 0 });
		expect(readLearningByContent(fixture.db, first.content).status).toBe("active");
		expect(readLearningByContent(fixture.db, second.content).status).toBe("active");
	});

	test("marks a failed consolidator run with retry backoff", async () => {
		const fixture = await createFixture();
		const repoKeyValue = path.dirname(fixture.cwd);
		store(fixture, "Retry failed consolidation work.", 100, repoKeyValue);
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(subprocessResult("", 1));

		const reports = await maybeRunLearningConsolidation(runOptions(fixture, true));

		expect(reports[1]).toEqual({ target: `repo:${repoKeyValue}`, outcome: "failed" });
		const job = readJob(fixture.db, `repo:${repoKeyValue}`);
		expect(job).toMatchObject({ status: "error", retry_remaining: 2 });
		expect(job.retry_at).toBeGreaterThan(job.finished_at ?? 0);
	});

	test("does not invoke a subagent below the configured threshold", async () => {
		const fixture = await createFixture({ "learning.consolidation.minEntries": 2 });
		const repoKeyValue = path.dirname(fixture.cwd);
		store(fixture, "Only one entry is below the threshold.", 100, repoKeyValue);
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		const subprocessSpy = vi.spyOn(taskExecutor, "runSubprocess");

		const reports = await maybeRunLearningConsolidation(runOptions(fixture));

		expect(reports).toEqual([
			{ target: "global", outcome: "skipped_below_threshold" },
			{ target: `repo:${repoKeyValue}`, outcome: "skipped_below_threshold" },
		]);
		expect(subprocessSpy).not.toHaveBeenCalled();
	});

	test("force bypasses staleness and thresholds but not an active lease", async () => {
		const fixture = await createFixture({ "learning.consolidation.minEntries": 2 });
		const repoKeyValue = path.dirname(fixture.cwd);
		store(fixture, "Force should run this stale target.", 100, repoKeyValue);
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		const watermark = storage.computeLearningWatermark(fixture.db, {
			scope: "repo",
			repoKey: repoKeyValue,
			nowSec: nowSec(),
		});
		const initialClaim = storage.tryClaimConsolidationJob(fixture.db, {
			jobKey: `repo:${repoKeyValue}`,
			workerId: "initial",
			leaseSeconds: 60,
			nowSec: nowSec(),
			inputWatermark: watermark,
			retryLimit: 3,
		});
		if (initialClaim.kind !== "claimed") throw new Error("expected initial claim");
		storage.markConsolidationSucceeded(fixture.db, { claim: initialClaim.claim, nowSec: nowSec() });
		const source = readLearningByContent(fixture.db, "Force should run this stale target.");
		const subprocessSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValue(subprocessResult(JSON.stringify({ ops: [{ op: "keep", id: alias(source) }] })));

		const forced = await maybeRunLearningConsolidation(runOptions(fixture, true));
		const held = storage.tryClaimConsolidationJob(fixture.db, {
			jobKey: `repo:${repoKeyValue}`,
			workerId: "holder",
			leaseSeconds: 60,
			nowSec: nowSec(),
			inputWatermark: watermark,
			retryLimit: 3,
			force: true,
		});
		if (held.kind !== "claimed") throw new Error("expected active lease");
		const blocked = await maybeRunLearningConsolidation(runOptions(fixture, true));

		expect(forced[1]).toMatchObject({ target: `repo:${repoKeyValue}`, outcome: "applied" });
		expect(blocked[1]).toEqual({ target: `repo:${repoKeyValue}`, outcome: "skipped_running" });
		expect(subprocessSpy).toHaveBeenCalledTimes(1);
	});

	test("stores the exact snapshot watermark so a mutating run needs one all-keep convergence run", async () => {
		const fixture = await createFixture();
		const repoKeyValue = path.dirname(fixture.cwd);
		const source = store(fixture, "Specific wording to generalize.", 100, repoKeyValue);
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		vi.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValueOnce(
				subprocessResult(
					JSON.stringify({
						ops: [{ op: "rewrite", id: alias(source), content: "Generalized durable guidance." }],
					}),
				),
			)
			.mockResolvedValueOnce(subprocessResult(JSON.stringify({ ops: [] })));

		const first = await maybeRunLearningConsolidation(runOptions(fixture));
		const firstJob = readJob(fixture.db, `repo:${repoKeyValue}`);
		const afterRewrite = readLearningByContent(fixture.db, "Generalized durable guidance.");
		const freshNow = nowSec();
		fixture.db.prepare("UPDATE live_learnings SET updated_at = ? WHERE id = ?").run(freshNow - 1, afterRewrite.id);
		fixture.db
			.prepare("UPDATE live_learning_jobs SET finished_at = 0 WHERE kind = 'consolidation' AND job_key = ?")
			.run(`repo:${repoKeyValue}`);
		const second = await maybeRunLearningConsolidation(runOptions(fixture));
		const secondJob = readJob(fixture.db, `repo:${repoKeyValue}`);
		const cleanWatermark = storage.computeLearningWatermark(fixture.db, {
			scope: "repo",
			repoKey: repoKeyValue,
			nowSec: nowSec(),
		});

		expect(first[1]).toMatchObject({ outcome: "applied", opsApplied: 1 });
		expect(firstJob.last_success_watermark).toBe(100);
		expect(second[1]).toMatchObject({ outcome: "applied", opsApplied: 0 });
		expect(secondJob.last_success_watermark).toBe(cleanWatermark);
		expect(
			storage.tryClaimConsolidationJob(fixture.db, {
				jobKey: `repo:${repoKeyValue}`,
				workerId: "clean-check",
				leaseSeconds: 60,
				nowSec: nowSec(),
				inputWatermark: cleanWatermark,
				retryLimit: 3,
			}).kind,
		).toBe("skipped_not_dirty");
	});

	test("keeps a post-snapshot user write dirty for the next claim", async () => {
		const fixture = await createFixture();
		const repoKeyValue = path.dirname(fixture.cwd);
		const source = store(fixture, "Existing learning before snapshot.", 100, repoKeyValue);
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async () => {
			storage.upsertLearning(fixture.db, {
				scope: "repo",
				cwd: fixture.cwd,
				repoKey: repoKeyValue,
				content: "Concurrent user learning after snapshot.",
				sourceMessageHash: "concurrent",
				trigger: "test",
				confidence: 0.8,
				nowSec: nowSec(),
			});
			return subprocessResult(JSON.stringify({ ops: [{ op: "keep", id: alias(source) }] }));
		});

		await maybeRunLearningConsolidation(runOptions(fixture));
		const watermark = storage.computeLearningWatermark(fixture.db, {
			scope: "repo",
			repoKey: repoKeyValue,
			nowSec: nowSec(),
		});

		expect(
			storage.tryClaimConsolidationJob(fixture.db, {
				jobKey: `repo:${repoKeyValue}`,
				workerId: "next-worker",
				leaseSeconds: 60,
				nowSec: nowSec(),
				inputWatermark: watermark,
				retryLimit: 3,
			}).kind,
		).toBe("claimed");
	});

	test("fences a reclaimed lease before stale operations can write", async () => {
		const fixture = await createFixture({ "learning.consolidation.timeoutMs": 600_000 });
		const repoKeyValue = path.dirname(fixture.cwd);
		const source = store(fixture, "Original guidance must survive a stale consolidator.", 100, repoKeyValue);
		let nowMs = 1_700_000_000_000;
		const start = nowMs;
		vi.spyOn(Date, "now").mockImplementation(() => nowMs);
		let earlyClaimKind: string | undefined;
		let reclaimedClaimKind: string | undefined;
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async () => {
			nowMs = start + 301_000;
			earlyClaimKind = storage.tryClaimConsolidationJob(fixture.db, {
				jobKey: `repo:${repoKeyValue}`,
				workerId: "worker-b-early",
				leaseSeconds: 60,
				nowSec: nowSec(),
				inputWatermark: storage.computeLearningWatermark(fixture.db, {
					scope: "repo",
					repoKey: repoKeyValue,
					nowSec: nowSec(),
				}),
				retryLimit: 3,
				force: true,
			}).kind;
			nowMs = start + 661_000;
			reclaimedClaimKind = storage.tryClaimConsolidationJob(fixture.db, {
				jobKey: `repo:${repoKeyValue}`,
				workerId: "worker-b",
				leaseSeconds: 60,
				nowSec: nowSec(),
				inputWatermark: storage.computeLearningWatermark(fixture.db, {
					scope: "repo",
					repoKey: repoKeyValue,
					nowSec: nowSec(),
				}),
				retryLimit: 3,
				force: true,
			}).kind;
			return subprocessResult(
				JSON.stringify({
					ops: [{ op: "rewrite", id: alias(source), content: "Stale consolidator replacement." }],
				}),
			);
		});

		const reports = await maybeRunLearningConsolidation(runOptions(fixture, true));
		const after = fixture.db.prepare("SELECT * FROM live_learnings WHERE id = ?").get(source.id) as LearningRow;

		expect(reports[1]).toEqual({ target: `repo:${repoKeyValue}`, outcome: "failed" });
		const auditRoot = path.join(fixture.agentDir, "learning-audit", "consolidation");
		const auditResults = await Promise.all(
			(await fs.readdir(auditRoot)).map(runId => Bun.file(path.join(auditRoot, runId, "result.json")).json()),
		);
		expect(auditResults).toContainEqual({
			target: `repo:${repoKeyValue}`,
			outcome: "failed",
			error: "lease lost",
		});
		expect(after.content).toBe(source.content);
		expect(after.status).toBe("active");
		expect(readJob(fixture.db, `repo:${repoKeyValue}`).last_success_watermark).toBeNull();
		expect(earlyClaimKind).toBe("skipped_running");
		expect(reclaimedClaimKind).toBe("claimed");
	});

	test("succeeds with zero operations for forced empty targets without a subagent", async () => {
		const fixture = await createFixture();
		vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(path.dirname(fixture.cwd));
		const subprocessSpy = vi.spyOn(taskExecutor, "runSubprocess");

		const reports = await maybeRunLearningConsolidation(runOptions(fixture, true));

		expect(reports).toEqual([
			{ target: "global", outcome: "applied", opsApplied: 0, opsSkippedStale: 0 },
			{ target: `repo:${path.dirname(fixture.cwd)}`, outcome: "applied", opsApplied: 0, opsSkippedStale: 0 },
		]);
		expect(subprocessSpy).not.toHaveBeenCalled();
	});

	test("heals sibling legacy worktrees only after claiming the repo consolidation lease", async () => {
		const fixture = await createFixture();
		const repoKeyValue = path.dirname(fixture.cwd);
		const sibling = path.join(repoKeyValue, "sibling");
		await fs.mkdir(sibling, { recursive: true });
		storage.upsertLearning(fixture.db, {
			scope: "repo",
			cwd: sibling,
			content: "Sibling legacy learning.",
			sourceMessageHash: "sibling",
			trigger: "test",
			confidence: 0.8,
			nowSec: 100,
		});
		const resolveKeySpy = vi.spyOn(repoKey, "resolveRepoKey").mockResolvedValue(repoKeyValue);
		const subprocessSpy = vi
			.spyOn(taskExecutor, "runSubprocess")
			.mockResolvedValue(subprocessResult(JSON.stringify({ ops: [] })));

		await maybeRunLearningConsolidation(runOptions(fixture, true));

		expect(resolveKeySpy).toHaveBeenCalledWith(sibling);
		expect(readLearningByContent(fixture.db, "Sibling legacy learning.")).toMatchObject({ repo_key: repoKeyValue });
		expect(subprocessSpy.mock.calls[0]?.[0]?.task).toContain("Sibling legacy learning.");
	});
});
