import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listReviewFindings } from "@oh-my-pi/omp-stats/review-findings";
import { backfillReviewFindings } from "../../src/task/review-findings-backfill";

const tempDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-findings-backfill-"));
	tempDirs.add(dir);
	return dir;
}

describe("review findings backfill", () => {
	afterEach(async () => {
		for (const dir of tempDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		tempDirs.clear();
	});

	test("backfills reviewer task findings from prior task result JSONL", async () => {
		const dir = await makeTempDir();
		const repoRoot = path.join(dir, "repo");
		const sessionDir = path.join(dir, "sessions");
		const sessionFile = path.join(sessionDir, "session.jsonl");
		const agentDbPath = path.join(dir, "agent.db");
		await fs.mkdir(sessionDir, { recursive: true });
		const sessionContent = [
			JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-06-04T00:00:00.000Z", cwd: repoRoot }),
			JSON.stringify({
				type: "message",
				id: "task-result",
				timestamp: "2026-06-04T00:01:00.000Z",
				message: {
					role: "toolResult",
					toolName: "task",
					details: {
						results: [
							{
								id: "ReviewUI",
								agent: "code-reviewer",
								description: "review ui",
								assignment: "review assignment",
								exitCode: 0,
								outputPath: path.join(sessionDir, "ReviewUI.md"),
								resolvedModel: "openai/test-reviewer",
								output: JSON.stringify({
									issues: [
										{
											severity: "important",
											title: "Prefer saved detail after refresh failure",
											description: "A saved finding can render stale pending state after refresh fails.",
											file: "packages/stats/src/client/components/ReviewFindingsView.tsx",
											line: "96, 104-107",
											confidence: 96,
										},
									],
								}),
							},
							{
								id: "Explore",
								agent: "explore",
								exitCode: 0,
								output: JSON.stringify({
									issues: [
										{
											title: "Ignored non-review task",
											file: "src/ignored.ts",
											line: 1,
										},
									],
								}),
							},
						],
					},
				},
			}),
		].join("\n");
		await Bun.write(sessionFile, `${sessionContent}\n`);

		const result = await backfillReviewFindings({ sessionDir, agentDbPath });

		expect(result).toMatchObject({
			sessionFilesScanned: 1,
			taskResultsScanned: 2,
			reviewerResults: 1,
			findingsDiscovered: 1,
			findingsWritten: 1,
			errors: [],
		});
		const list = await listReviewFindings({ agentDbPath });
		expect(list.total).toBe(1);
		expect(list.findings[0]).toMatchObject({
			agent: "code-reviewer",
			taskId: "ReviewUI",
			title: "Prefer saved detail after refresh failure",
			priorityLabel: "P1",
			confidence: 0.96,
			filePath: "packages/stats/src/client/components/ReviewFindingsView.tsx",
			lineStart: 96,
			lineEnd: 96,
		});

		const repeated = await backfillReviewFindings({ sessionDir, agentDbPath });
		expect(repeated.findingsDiscovered).toBe(1);
		expect(repeated.findingsWritten).toBe(0);
		const repeatedList = await listReviewFindings({ agentDbPath });
		expect(repeatedList.total).toBe(1);
		expect(repeatedList.findings[0]?.occurrenceCount).toBe(1);
	});

	test("backfills reviewer findings from persisted yield data", async () => {
		const dir = await makeTempDir();
		const sessionDir = path.join(dir, "sessions");
		const sessionFile = path.join(sessionDir, "session.jsonl");
		const agentDbPath = path.join(dir, "agent.db");
		await fs.mkdir(sessionDir, { recursive: true });
		const sessionContent = [
			JSON.stringify({ type: "session", id: "session-yield", cwd: dir }),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "task",
					details: {
						results: [
							{
								id: "ReviewYield",
								agent: "reviewer",
								exitCode: 0,
								extractedToolData: {
									yield: [
										{
											status: "success",
											data: {
												blockers: [
													{
														title: "Reload pending list after save",
														file: "packages/stats/src/client/components/ReviewFindingsView.tsx",
														line: 217,
														why: "Persisted yield payloads are how reviewer agents return findings.",
													},
												],
												important_non_blocking_issues: [
													{
														title: "Persist important non-blocking yield findings",
														file: "packages/coding-agent/src/task/review-findings.ts",
														line: 106,
														why: "Reviewer agents use this yielded section name for important issues.",
													},
												],
											},
										},
									],
								},
							},
						],
					},
				},
			}),
		].join("\n");
		await Bun.write(sessionFile, `${sessionContent}\n`);

		const result = await backfillReviewFindings({ sessionDir, agentDbPath });

		expect(result.findingsWritten).toBe(2);
		const list = await listReviewFindings({ agentDbPath });
		expect(list.total).toBe(2);
		expect(list.findings.map(finding => finding.title).sort()).toEqual([
			"Persist important non-blocking yield findings",
			"Reload pending list after save",
		]);
	});

	test("keeps repo-filter counters honest while writing report_finding payloads", async () => {
		const dir = await makeTempDir();
		const targetRepo = path.join(dir, "target-repo");
		const otherRepo = path.join(dir, "other-repo");
		const sessionDir = path.join(dir, "sessions");
		const targetSessionFile = path.join(sessionDir, "target.jsonl");
		const otherSessionFile = path.join(sessionDir, "other.jsonl");
		const agentDbPath = path.join(dir, "agent.db");
		await fs.mkdir(targetRepo, { recursive: true });
		await fs.mkdir(otherRepo, { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(
			targetSessionFile,
			`${[
				JSON.stringify({ type: "session", id: "session-target", cwd: targetRepo }),
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolName: "task",
						details: {
							results: [
								{
									id: "ReviewReportFinding",
									agent: "code-reviewer",
									exitCode: 0,
									extractedToolData: {
										report_finding: [
											{
												title: "Persist report_finding payloads",
												body: "Backfill must write report_finding payloads, not only dry-run them.",
												priority: "P2",
												confidence: 0.93,
												file_path: "packages/coding-agent/src/task/review-findings-backfill.ts",
												line_start: 110,
												line_end: 127,
											},
										],
									},
								},
								{
									id: "ExploreTarget",
									agent: "explore",
									exitCode: 0,
									output: "",
								},
							],
						},
					},
				}),
			].join("\n")}\n`,
		);
		await Bun.write(
			otherSessionFile,
			`${[
				JSON.stringify({ type: "session", id: "session-other", cwd: otherRepo }),
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolName: "task",
						details: {
							results: [
								{
									id: "ReviewOtherRepo",
									agent: "reviewer",
									exitCode: 0,
									output: JSON.stringify({
										issues: [
											{
												title: "Skipped other repo finding",
												description: "Repo filter should not write this.",
												file: "src/other.ts",
												line: 1,
											},
										],
									}),
								},
								{
									id: "ExploreOther",
									agent: "explore",
									exitCode: 0,
									output: "",
								},
							],
						},
					},
				}),
			].join("\n")}\n`,
		);

		const result = await backfillReviewFindings({ sessionDir, agentDbPath, repoRoot: targetRepo });

		expect(result).toMatchObject({
			sessionFilesScanned: 2,
			taskResultsScanned: 4,
			reviewerResults: 2,
			findingsDiscovered: 1,
			findingsWritten: 1,
			skippedByRepo: 1,
			errors: [],
		});
		const list = await listReviewFindings({ agentDbPath });
		expect(list.total).toBe(1);
		expect(list.findings[0]).toMatchObject({
			taskId: "ReviewReportFinding",
			title: "Persist report_finding payloads",
			lineStart: 110,
			lineEnd: 127,
		});
	});

	test("dry-run reports findings without writing rows", async () => {
		const dir = await makeTempDir();
		const sessionDir = path.join(dir, "sessions");
		const sessionFile = path.join(sessionDir, "session.jsonl");
		const agentDbPath = path.join(dir, "agent.db");
		await fs.mkdir(sessionDir, { recursive: true });
		const sessionContent = [
			JSON.stringify({ type: "session", id: "session-2", cwd: dir }),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "task",
					details: {
						results: [
							{
								id: "ReviewDryRun",
								agent: "reviewer",
								exitCode: 0,
								extractedToolData: {
									report_finding: [
										{
											title: "Keep dry runs read-only",
											body: "Dry-run backfill must not write review findings.",
											priority: "P2",
											confidence: 0.88,
											file_path: "scripts/backfill-review-findings.ts",
											line_start: 1,
											line_end: 1,
										},
									],
								},
							},
						],
					},
				},
			}),
		].join("\n");
		await Bun.write(sessionFile, `${sessionContent}\n`);

		const result = await backfillReviewFindings({ sessionDir, agentDbPath, dryRun: true });

		expect(result.findingsDiscovered).toBe(1);
		expect(result.findingsWritten).toBe(0);
		const list = await listReviewFindings({ agentDbPath });
		expect(list.total).toBe(0);
	});
});
