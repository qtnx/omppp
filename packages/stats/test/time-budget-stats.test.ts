import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getTimeBudgetStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-time-budget-");

afterEach(() => {
	closeDb();
});

function timeBudgetEntry(
	id: string,
	event: "activate" | "extend" | "checkpoint" | "overtime" | "deactivate",
	budgetMs: number,
	activeMs: number,
	at: number,
): Record<string, unknown> {
	return {
		type: "custom",
		id,
		timestamp: new Date(at).toISOString(),
		customType: "time_budget",
		data: { event, budgetMs, activeMs, at },
	};
}

async function writeFixture(): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--time-budget");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "time-budget.jsonl");
	const entries = [
		timeBudgetEntry("activate-1", "activate", 600_000, 0, 1_000),
		timeBudgetEntry("checkpoint-1", "checkpoint", 600_000, 300_000, 301_000),
		timeBudgetEntry("extend-1", "extend", 900_000, 300_000, 302_000),
		timeBudgetEntry("overtime-1", "overtime", 900_000, 960_000, 962_000),
		timeBudgetEntry("deactivate-1", "deactivate", 900_000, 960_000, 963_000),
		{
			type: "custom",
			id: "malformed-time-budget",
			timestamp: new Date(964_000).toISOString(),
			customType: "time_budget",
			data: { event: "checkpoint", budgetMs: 900_000, activeMs: -1, at: 964_000 },
		},
		{ type: "custom", id: "unrelated", timestamp: new Date(965_000).toISOString(), customType: "other", data: {} },
		timeBudgetEntry("activate-2", "activate", 1_200_000, 120_000, 1_000_000),
		timeBudgetEntry("checkpoint-2", "checkpoint", 1_200_000, 300_000, 1_180_000),
	];
	await Bun.write(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return sessionFile;
}

describe("time budget stats ingestion", () => {
	it("parses only valid ordered time-budget events and preserves the incremental offset", async () => {
		const sessionFile = await writeFixture();
		const result = await parseSessionFile(sessionFile);

		expect(result.timeBudgetEntries.map(entry => entry.entryId)).toEqual([
			"activate-1",
			"checkpoint-1",
			"extend-1",
			"overtime-1",
			"deactivate-1",
			"activate-2",
			"checkpoint-2",
		]);
		expect(result.timeBudgetEntries.at(-1)).toMatchObject({
			event: "checkpoint",
			budgetMs: 1_200_000,
			activeMs: 300_000,
		});

		const incremental = await parseSessionFile(sessionFile, result.newOffset);
		expect(incremental.timeBudgetEntries).toEqual([]);
	});

	it("folds extended overtime and open runs, ignores malformed data, and stays idempotent on resync", async () => {
		await writeFixture();
		const firstSync = await syncAllSessions({ workers: 1 });
		const secondSync = await syncAllSessions({ workers: 1 });

		expect(firstSync).toEqual({ processed: 7, files: 1 });
		expect(secondSync).toEqual({ processed: 0, files: 0 });

		const sqlite = new Database(getStatsDbPath(), { readonly: true });
		const rows = sqlite
			.query(
				"SELECT activation_entry_id, budget_ms, active_ms, overtime_ms, completed, extension_count FROM time_budget_runs ORDER BY activation_entry_id",
			)
			.all();
		sqlite.close();
		expect(rows).toEqual([
			{
				activation_entry_id: "activate-1",
				budget_ms: 900_000,
				active_ms: 960_000,
				overtime_ms: 60_000,
				completed: 1,
				extension_count: 1,
			},
			{
				activation_entry_id: "activate-2",
				budget_ms: 1_200_000,
				active_ms: 300_000,
				overtime_ms: 0,
				completed: 0,
				extension_count: 0,
			},
		]);
		expect(getTimeBudgetStats()).toEqual({
			totalRuns: 2,
			withinBudgetRuns: 0,
			overtimeRuns: 1,
			openRuns: 1,
			averageOvertimeMs: 60_000,
		});
	});
});
