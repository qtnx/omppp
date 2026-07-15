import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getSubagentPerformance, initDb } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-subagent-performance-");

interface RunOverrides {
	runId?: string;
	agent?: string;
	phase?: "work" | "review" | "fix";
	status?: "completed" | "failed" | "aborted";
	abortReason?: "signal" | "terminate" | "timeout" | "budget";
	startedAt?: number;
	completedAt?: number;
	model?: string;
	requests?: number;
	toolCalls?: number;
	maxRuntimeMs?: number;
	earlyYieldNoticeSent?: boolean;
	timings?: Record<string, number>;
}

function runEntry(id: string, overrides: RunOverrides = {}): Record<string, unknown> {
	const startedAt = overrides.startedAt ?? 1_752_000_000_000;
	const data = {
		version: 1,
		runId: overrides.runId ?? `run-${id}`,
		agent: overrides.agent ?? "quick_task",
		phase: overrides.phase ?? "work",
		startedAt,
		completedAt: overrides.completedAt ?? startedAt + 100,
		status: overrides.status ?? "completed",
		model: overrides.model ?? "openai/gpt-5.6-codex",
		requests: overrides.requests ?? 2,
		toolCalls: overrides.toolCalls ?? 3,
		maxRuntimeMs: overrides.maxRuntimeMs ?? 600_000,
		earlyYieldNoticeSent: overrides.earlyYieldNoticeSent ?? false,
		timings: overrides.timings ?? {
			queueMs: 10,
			preRunMs: 5,
			setupMs: 20,
			promptToFirstChatMs: 30,
			activeMs: 80,
			totalMs: 100,
			modelMs: 40,
			toolMs: 25,
		},
		...(overrides.abortReason === undefined ? {} : { abortReason: overrides.abortReason }),
	};
	return {
		type: "custom",
		id,
		timestamp: new Date(startedAt).toISOString(),
		customType: "subagent_run",
		data,
	};
}

async function writeSession(entries: Record<string, unknown>[], fileName = "session.jsonl"): Promise<string> {
	const dir = path.join(getSessionsDir(), "--tmp--subagent-performance");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, fileName);
	await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

describe("subagent run telemetry", () => {
	it("strictly parses v1 entries while ignoring malformed and future payloads", async () => {
		const valid = runEntry("valid");
		const malformed = runEntry("malformed");
		(malformed.data as Record<string, unknown>).timings = { totalMs: Number.NaN };
		const future = runEntry("future");
		(future.data as Record<string, unknown>).version = 2;
		const negative = runEntry("negative");
		(negative.data as Record<string, unknown>).requests = -1;
		const file = await writeSession([valid, malformed, future, negative]);

		const result = await parseSessionFile(file);

		expect(result.subagentRuns).toHaveLength(1);
		expect(result.subagentRuns[0]).toMatchObject({
			sessionFile: file,
			entryId: "valid",
			runId: "run-valid",
			agent: "quick_task",
			phase: "work",
			status: "completed",
			totalMs: 100,
		});
	});

	it("persists valid entries idempotently and aggregates deterministic percentiles by agent", async () => {
		const entries = [
			runEntry("q1", {
				status: "completed",
				earlyYieldNoticeSent: true,
				timings: { queueMs: 10, setupMs: 20, totalMs: 100, modelMs: 40, toolMs: 25 },
			}),
			runEntry("q2", {
				status: "failed",
				timings: { queueMs: 20, setupMs: 30, totalMs: 200, modelMs: 80, toolMs: 50 },
			}),
			runEntry("q3", {
				status: "aborted",
				abortReason: "timeout",
				earlyYieldNoticeSent: true,
				timings: { queueMs: 30, setupMs: 40, totalMs: 300, modelMs: 120, toolMs: 75 },
			}),
			runEntry("q4", {
				status: "aborted",
				abortReason: "signal",
				timings: { queueMs: 40, setupMs: 50, totalMs: 400, modelMs: 160, toolMs: 100 },
			}),
			runEntry("task1", {
				agent: "task",
				phase: "review",
				status: "completed",
				model: "anthropic/claude-fable-5",
				timings: { totalMs: 900, modelMs: 0, toolMs: 0 },
			}),
		];
		const malformed = runEntry("bad");
		(malformed.data as Record<string, unknown>).completedAt = "not-a-timestamp";
		const future = runEntry("v2");
		(future.data as Record<string, unknown>).version = 2;
		await writeSession([...entries, malformed, future]);

		const firstSync = await syncAllSessions({ workers: 1 });
		const secondSync = await syncAllSessions({ workers: 1 });
		expect(firstSync).toEqual({ processed: 5, files: 1 });
		expect(secondSync).toEqual({ processed: 0, files: 0 });

		const sqlite = new Database(getStatsDbPath(), { readonly: true });
		const rows = sqlite
			.query(
				"SELECT entry_id, abort_reason, phase, model, max_runtime_ms, early_yield_notice_sent FROM subagent_runs ORDER BY entry_id",
			)
			.all();
		sqlite.close();
		expect(rows).toHaveLength(5);
		expect(rows).toContainEqual({
			entry_id: "q3",
			abort_reason: "timeout",
			phase: "work",
			model: "openai/gpt-5.6-codex",
			max_runtime_ms: 600_000,
			early_yield_notice_sent: 1,
		});

		const performance = getSubagentPerformance();
		expect(performance).toEqual([
			{
				agent: "quick_task",
				runs: 4,
				completed: 1,
				failed: 1,
				aborted: 2,
				timeouts: 1,
				earlyYieldNotices: 2,
				avgTotalMs: 250,
				p50TotalMs: 200,
				p90TotalMs: 400,
				avgQueueMs: 25,
				avgSetupMs: 35,
				avgModelMs: 100,
				avgToolMs: 62.5,
			},
			{
				agent: "task",
				runs: 1,
				completed: 1,
				failed: 0,
				aborted: 0,
				timeouts: 0,
				earlyYieldNotices: 0,
				avgTotalMs: 900,
				p50TotalMs: 900,
				p90TotalMs: 900,
				avgQueueMs: null,
				avgSetupMs: null,
				avgModelMs: 0,
				avgToolMs: 0,
			},
		]);

		const dashboard = await getDashboardStats("all");
		expect(dashboard.subagentPerformance).toEqual(performance);
	});

	it("backfills offset-tracked telemetry exactly once and completes after a successful sync", async () => {
		const sessionFile = await writeSession([runEntry("legacy")], "legacy.jsonl");
		await initDb();
		closeDb();

		const stats = await fs.stat(sessionFile);
		const raw = new Database(getStatsDbPath());
		raw.prepare("DELETE FROM meta WHERE key = ?").run("subagent_runs_v1");
		raw.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(
			sessionFile,
			stats.size,
			stats.mtimeMs,
		);
		raw.close();

		await initDb();
		closeDb();
		const pendingPass = new Database(getStatsDbPath(), { readonly: true });
		const pendingBackfill = pendingPass.query("SELECT value FROM meta WHERE key = ?").get("subagent_runs_v1") as {
			value: string;
		};
		const pendingOffsets = pendingPass.query("SELECT COUNT(*) AS count FROM file_offsets").get() as { count: number };
		pendingPass.close();
		expect(pendingBackfill.value).toBe("pending");
		expect(pendingOffsets.count).toBe(0);

		expect(await syncAllSessions({ workers: 1 })).toEqual({ processed: 1, files: 1 });

		const firstPass = new Database(getStatsDbPath(), { readonly: true });
		const firstRunCount = firstPass.query("SELECT COUNT(*) AS count FROM subagent_runs").get() as { count: number };
		const backfill = firstPass.query("SELECT value FROM meta WHERE key = ?").get("subagent_runs_v1") as {
			value: string;
		};
		firstPass.close();
		expect(firstRunCount.count).toBe(1);
		expect(backfill.value).toBe("complete");

		expect(await syncAllSessions({ workers: 1 })).toEqual({ processed: 0, files: 0 });
		const secondPass = new Database(getStatsDbPath(), { readonly: true });
		const secondRunCount = secondPass.query("SELECT COUNT(*) AS count FROM subagent_runs").get() as { count: number };
		secondPass.close();
		expect(secondRunCount.count).toBe(1);
	});

	it("counts fork-copied telemetry once by copied entry lineage", async () => {
		const copied = runEntry("copied", { runId: "run-parent-turn" });
		await writeSession([copied], "01_parent.jsonl");
		await writeSession([copied], "02_fork.jsonl");

		await syncAllSessions({ workers: 1 });

		expect(getSubagentPerformance()).toMatchObject([{ agent: "quick_task", runs: 1 }]);
	});

	it("deterministically cleans existing fork duplicates before adding the lineage index", async () => {
		await initDb();
		closeDb();

		const raw = new Database(getStatsDbPath());
		raw.run("DROP INDEX idx_subagent_runs_lineage");
		raw.prepare("DELETE FROM meta WHERE key = ?").run("subagent_runs_fork_dedupe_v1");
		const insert = raw.prepare(`
			INSERT INTO subagent_runs (
				session_file, entry_id, run_id, agent, phase, parent_agent_id, parent_tool_call_id,
				started_at, completed_at, status, abort_reason, model, requests, tool_calls,
				max_runtime_ms, early_yield_notice_sent, queue_ms, pre_run_ms, setup_ms,
				prompt_to_first_chat_ms, active_ms, total_ms, model_ms, tool_ms
			) VALUES (?, ?, ?, 'task', 'work', NULL, NULL, 100, 200, 'completed', NULL, 'openai/gpt-5.6-codex',
				1, 1, 600000, 0, NULL, NULL, NULL, NULL, NULL, 100, 40, 25)
		`);
		insert.run("/tmp/01_parent.jsonl", "copied-entry", "copied-run");
		insert.run("/tmp/02_fork.jsonl", "copied-entry", "copied-run");
		raw.close();

		await initDb();

		const verification = new Database(getStatsDbPath(), { readonly: true });
		const rows = verification
			.query("SELECT session_file, entry_id FROM subagent_runs WHERE run_id = ?")
			.all("copied-run");
		verification.close();
		expect(rows).toEqual([{ session_file: "/tmp/01_parent.jsonl", entry_id: "copied-entry" }]);
	});

	it("counts distinct turns for one agent independently", async () => {
		await writeSession(
			[
				runEntry("first", { runId: "legacy-stable-agent-id", agent: "task", startedAt: 1_752_000_000_000 }),
				runEntry("resumed", { runId: "legacy-stable-agent-id", agent: "task", startedAt: 1_752_000_001_000 }),
			],
			"distinct-turns.jsonl",
		);

		await syncAllSessions({ workers: 1 });

		expect(getSubagentPerformance()).toMatchObject([{ agent: "task", runs: 2 }]);
	});

	it("returns an empty performance aggregate for an empty database", async () => {
		await initDb();
		expect(getSubagentPerformance()).toEqual([]);
	});
});
