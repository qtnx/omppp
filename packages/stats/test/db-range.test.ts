import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, initDb, insertMessageStats, insertReminderStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getAgentDir, getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-stats-db-range-");
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	closeDb();
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

function makeMessage(timestamp: number, entryId: string, model = "gpt-5.4", provider = "openai-codex"): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model,
		provider,
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
	};
}

describe("getDashboardStats time range", () => {
	it("filters dashboard stats by selected range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const dayStats = await getDashboardStats("24h");
		expect(dayStats.overall.totalRequests).toBe(1);
		expect(dayStats.byModel[0]).toMatchObject({
			totalRequests: 1,
			model: "gpt-5.4",
			provider: "openai-codex",
		});

		const weekStats = await getDashboardStats("7d");
		expect(weekStats.overall.totalRequests).toBe(2);
		expect(weekStats.byModel[0]).toMatchObject({ totalRequests: 2, model: "gpt-5.4", provider: "openai-codex" });

		const allStats = await getDashboardStats("all");
		expect(allStats.overall.totalRequests).toBe(2);
	});

	it("falls back to 24h for unknown range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const stats = await getDashboardStats("last century");
		expect(stats.overall.totalRequests).toBe(1);
	});

	it("aggregates system-context reminder count and rate by model within the selected range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([
			makeMessage(now, "model-a-1", "gpt-5.4", "openai-codex"),
			makeMessage(now, "model-a-2", "gpt-5.4", "openai-codex"),
			makeMessage(now, "model-b-1", "claude-sonnet-4.5", "anthropic"),
		]);
		insertReminderStats([
			{
				sessionFile: "/tmp/session.jsonl",
				entryId: "reminder-a-in-range",
				folder: "/tmp/project",
				timestamp: now,
				model: "gpt-5.4",
				provider: "openai-codex",
				api: "openai-codex-responses",
			},
			{
				sessionFile: "/tmp/session.jsonl",
				entryId: "reminder-a-in-range",
				folder: "/tmp/project",
				timestamp: now,
				model: "gpt-5.4",
				provider: "openai-codex",
				api: "openai-codex-responses",
			},
			{
				sessionFile: "/tmp/session.jsonl",
				entryId: "reminder-a-out-of-range",
				folder: "/tmp/project",
				timestamp: now - 48 * 60 * 60 * 1000,
				model: "gpt-5.4",
				provider: "openai-codex",
			},
			{
				sessionFile: "/tmp/session.jsonl",
				entryId: "reminder-no-request-row",
				folder: "/tmp/project",
				timestamp: now,
				model: "missing-model",
				provider: "synthetic",
			},
		]);

		const dayStats = await getDashboardStats("24h");
		const codexModel = dayStats.byModel.find(model => model.model === "gpt-5.4" && model.provider === "openai-codex");
		const anthropicModel = dayStats.byModel.find(
			model => model.model === "claude-sonnet-4.5" && model.provider === "anthropic",
		);
		const missingModel = dayStats.byModel.find(model => model.model === "missing-model");

		expect(codexModel?.systemContextReminderCount).toBe(1);
		expect(codexModel?.systemContextReminderRate).toBe(0.5);
		expect(anthropicModel?.systemContextReminderCount).toBe(0);
		expect(anthropicModel?.systemContextReminderRate).toBe(0);
		expect(missingModel).toBeUndefined();

		const allStats = await getDashboardStats("all");
		const allCodexModel = allStats.byModel.find(
			model => model.model === "gpt-5.4" && model.provider === "openai-codex",
		);
		expect(allCodexModel?.systemContextReminderCount).toBe(2);
		expect(allCodexModel?.systemContextReminderRate).toBe(1);
	});

	it("parses persisted system-context reminder custom messages", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--project");
		await fs.mkdir(dir, { recursive: true });
		const sessionFile = path.join(dir, "reminder.jsonl");
		const timestamp = new Date("2026-06-04T00:00:00.000Z").toISOString();
		const assistantTimestamp = Date.parse("2026-06-03T23:59:00.000Z");
		await Bun.write(
			sessionFile,
			[
				{
					type: "message",
					id: "assistant-entry",
					parentId: null,
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Finished." }],
						api: "openai-codex-responses",
						provider: "openai-codex",
						model: "gpt-5.4",
						stopReason: "stop",
						timestamp: assistantTimestamp,
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				},
				{
					type: "custom_message",
					id: "reminder-entry",
					parentId: "assistant-entry",
					timestamp,
					customType: "system-context-reminder",
					content: "hidden reminder",
					display: false,
					details: {
						kind: "system-context-reminder",
						model: "gpt-5.4",
						provider: "openai-codex",
						api: "openai-codex-responses",
					},
				},
				{
					type: "custom_message",
					id: "no-kind",
					parentId: "assistant-entry",
					timestamp,
					customType: "system-context-reminder",
					content: "hidden reminder",
					display: false,
					details: { model: "claude-sonnet-4.5", provider: "anthropic" },
				},
				{
					type: "custom_message",
					id: "legacy-kind-only",
					parentId: "assistant-entry",
					timestamp,
					customType: "system-context-reminder",
					content: "hidden reminder",
					display: false,
					details: { kind: "system-context-reminder" },
				},
				{
					type: "custom_message",
					id: "missing-provider",
					parentId: "assistant-entry",
					timestamp,
					customType: "system-context-reminder",
					content: "hidden reminder",
					display: false,
					details: { kind: "system-context-reminder", model: "gpt-5.4" },
				},
				{
					type: "custom_message",
					id: "non-string-api",
					parentId: "assistant-entry",
					timestamp,
					customType: "system-context-reminder",
					content: "hidden reminder",
					display: false,
					details: { kind: "system-context-reminder", model: "gpt-5.4", provider: "openai-codex", api: 1 },
				},
				{
					type: "custom_message",
					id: "other-custom-type",
					parentId: "assistant-entry",
					timestamp,
					customType: "other",
					content: "hidden reminder",
					display: false,
					details: { kind: "system-context-reminder", model: "gpt-5.4", provider: "openai-codex" },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n"),
		);

		const parsed = await parseSessionFile(sessionFile);

		expect(parsed.reminderStats).toEqual([
			{
				sessionFile,
				entryId: "reminder-entry",
				folder: "/tmp/project",
				timestamp: assistantTimestamp,
				model: "gpt-5.4",
				provider: "openai-codex",
				api: "openai-codex-responses",
			},
			{
				sessionFile,
				entryId: "no-kind",
				folder: "/tmp/project",
				timestamp: assistantTimestamp,
				model: "claude-sonnet-4.5",
				provider: "anthropic",
			},
			{
				sessionFile,
				entryId: "legacy-kind-only",
				folder: "/tmp/project",
				timestamp: assistantTimestamp,
				model: "gpt-5.4",
				provider: "openai-codex",
				api: "openai-codex-responses",
			},
		]);
	});

	it("ingests reminder custom messages through session sync into model stats", async () => {
		const now = Date.now();
		const timestamp = new Date(now).toISOString();
		const dir = path.join(getSessionsDir(), "--tmp--project");
		await fs.mkdir(dir, { recursive: true });
		const sessionFile = path.join(dir, "sync-reminder.jsonl");
		await Bun.write(
			sessionFile,
			[
				{
					type: "session",
					version: 1,
					id: "session",
					timestamp,
					cwd: "/tmp/project",
				},
				{
					type: "message",
					id: "assistant-entry",
					parentId: null,
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Finished." }],
						api: "openai-codex-responses",
						provider: "openai-codex",
						model: "gpt-5.4",
						stopReason: "stop",
						timestamp: now,
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				},
				{
					type: "custom_message",
					id: "reminder-entry",
					parentId: "assistant-entry",
					timestamp,
					customType: "system-context-reminder",
					content: "hidden reminder",
					display: false,
					details: {
						kind: "system-context-reminder",
						model: "gpt-5.4",
						provider: "openai-codex",
						api: "openai-codex-responses",
					},
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n"),
		);

		await syncAllSessions({ workers: 1 });
		await syncAllSessions({ workers: 1 });

		const stats = await getDashboardStats("all");
		const model = stats.byModel.find(row => row.model === "gpt-5.4" && row.provider === "openai-codex");
		expect(model?.systemContextReminderCount).toBe(1);
		expect(model?.systemContextReminderRate).toBe(1);
	});
});
