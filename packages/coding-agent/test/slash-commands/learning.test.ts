import { afterEach, describe, expect, type Mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as consolidation from "@oh-my-pi/pi-coding-agent/learnings/consolidate";
import * as learningStorage from "@oh-my-pi/pi-coding-agent/learnings/storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

interface RuntimeFixture {
	agentDir: string;
	cwd: string;
	output: string[];
	refreshBaseSystemPrompt: Mock<() => Promise<void>>;
	runtime: SlashCommandRuntime;
}

const REPO_LEARNING = "Always run a fresh verification before claiming a fix.";
const GLOBAL_LEARNING = "Keep answers concise when direct execution is requested.";

const createdDirs = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
	createdDirs.add(dir);
	return dir;
}

async function createRuntime(): Promise<RuntimeFixture> {
	const agentDir = await makeTempDir("learning-command-agent");
	const cwd = await makeTempDir("learning-command-repo");
	const output: string[] = [];
	const refreshBaseSystemPrompt = vi.fn(async function refreshBaseSystemPrompt(): Promise<void> {
		return undefined;
	});
	const settings = Settings.isolated({ "learning.enabled": true });
	Object.defineProperty(settings, "getAgentDir", {
		value: function getAgentDir(): string {
			return agentDir;
		},
	});
	const session = {
		sessionId: "learning-command-session",
		modelRegistry: {},
		refreshBaseSystemPrompt,
	} as unknown as AgentSession;
	const sessionManager = {
		getCwd(): string {
			return cwd;
		},
	} as unknown as SessionManager;
	return {
		agentDir,
		cwd,
		output,
		refreshBaseSystemPrompt,
		runtime: {
			session,
			sessionManager,
			settings,
			cwd,
			output(text: string): void {
				output.push(text);
			},
			refreshCommands(): void {
				return undefined;
			},
			async reloadPlugins(): Promise<void> {
				return undefined;
			},
		},
	};
}

function seedLearning(fixture: RuntimeFixture, scope: learningStorage.LearningScope, content: string): void {
	const db = learningStorage.openLearningDb(getAgentDbPath(fixture.agentDir));
	try {
		learningStorage.upsertLearning(db, {
			scope,
			cwd: fixture.cwd,
			content,
			sourceMessageHash: `message-${scope}`,
			trigger: "guideline",
			confidence: 0.91,
			nowSec: 1_800_000_000 + (scope === "repo" ? 1 : 0),
		});
	} finally {
		learningStorage.closeLearningDb(db);
	}
}

function listRankedEntries(fixture: RuntimeFixture): learningStorage.RankedLearningEntry[] {
	const db = learningStorage.openLearningDb(getAgentDbPath(fixture.agentDir));
	try {
		return learningStorage.listActiveLearnings(db, {
			repoKey: fixture.cwd,
			limitPerScope: 40,
			halfLifeDays: 45,
			nowSec: 1_800_000_001,
		});
	} finally {
		learningStorage.closeLearningDb(db);
	}
}

describe("/learning slash command", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of createdDirs) {
			await fs.rm(dir, { recursive: true, force: true });
		}
		createdDirs.clear();
	});

	test("view displays each active learning alias, score, strength, and vote totals", async () => {
		const fixture = await createRuntime();
		seedLearning(fixture, "repo", REPO_LEARNING);
		const [entry] = listRankedEntries(fixture);
		if (!entry) throw new Error("seeded learning missing");

		const result = await executeAcpBuiltinSlashCommand("/learning", fixture.runtime);

		expect(result).toEqual({ consumed: true });
		expect(fixture.output).toHaveLength(1);
		expect(fixture.output[0]).toContain(`[l:${entry.alias}]`);
		expect(fixture.output[0]).toMatch(/score \d+\.\d{2}/);
		expect(fixture.output[0]).toContain("strength 1");
		expect(fixture.output[0]).toContain("useful 0");
		expect(fixture.output[0]).toContain("not_useful 0");
		expect(fixture.output[0]).toContain(REPO_LEARNING);
	});

	test("clear removes only the requested live-learning scope and refreshes the prompt", async () => {
		const fixture = await createRuntime();
		seedLearning(fixture, "global", GLOBAL_LEARNING);
		seedLearning(fixture, "repo", REPO_LEARNING);

		const result = await executeAcpBuiltinSlashCommand("/learning clear repo", fixture.runtime);
		const viewResult = await executeAcpBuiltinSlashCommand("/learning view", fixture.runtime);

		expect(result).toEqual({ consumed: true });
		expect(viewResult).toEqual({ consumed: true });
		expect(fixture.output[0]).toBe("Repo live learning cleared.");
		expect(fixture.output[1]).toContain("Global learnings");
		expect(fixture.output[1]).toContain(GLOBAL_LEARNING);
		expect(fixture.output[1]).not.toContain(REPO_LEARNING);
		expect(fixture.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
	});

	test("consolidate forces a run and reports every target outcome", async () => {
		const fixture = await createRuntime();
		const runSpy = vi.spyOn(consolidation, "maybeRunLearningConsolidation").mockResolvedValue([
			{ target: "global", outcome: "applied", opsApplied: 2, opsSkippedStale: 1 },
			{ target: `repo:${fixture.cwd}`, outcome: "skipped_not_dirty", opsApplied: 0, opsSkippedStale: 0 },
		]);

		const result = await executeAcpBuiltinSlashCommand("/learning consolidate", fixture.runtime);

		expect(result).toEqual({ consumed: true });
		expect(runSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				session: fixture.runtime.session,
				settings: fixture.runtime.settings,
				modelRegistry: fixture.runtime.session.modelRegistry,
				agentDir: fixture.agentDir,
				force: true,
			}),
		);
		expect(fixture.output[0]).toContain("global: applied");
		expect(fixture.output[0]).toContain("ops applied: 2");
		expect(fixture.output[0]).toContain("ops skipped stale: 1");
		expect(fixture.output[0]).toContain(`repo:${fixture.cwd}: skipped_not_dirty`);
		expect(fixture.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
	});

	test("consolidate does not refresh the prompt when no operations apply", async () => {
		const fixture = await createRuntime();
		vi.spyOn(consolidation, "maybeRunLearningConsolidation").mockResolvedValue([
			{ target: "global", outcome: "skipped_not_dirty", opsApplied: 0, opsSkippedStale: 0 },
		]);

		await executeAcpBuiltinSlashCommand("/learning consolidate", fixture.runtime);

		expect(fixture.refreshBaseSystemPrompt).not.toHaveBeenCalled();
	});

	test("drop refreshes only after archiving a matched alias", async () => {
		const fixture = await createRuntime();
		seedLearning(fixture, "repo", REPO_LEARNING);
		const [entry] = listRankedEntries(fixture);
		if (!entry) throw new Error("seeded learning missing");

		await executeAcpBuiltinSlashCommand(`/learning drop ${entry.alias}`, fixture.runtime);
		await executeAcpBuiltinSlashCommand("/learning drop deadbeef", fixture.runtime);
		const ambiguousSpy = vi.spyOn(learningStorage, "findActiveByAliasPrefix").mockReturnValue([entry, entry]);
		await executeAcpBuiltinSlashCommand(`/learning drop ${entry.alias}`, fixture.runtime);

		expect(fixture.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ambiguousSpy).toHaveBeenCalledWith(expect.anything(), { aliasPrefix: entry.alias, repoKey: fixture.cwd });
	});

	test("drop archives a matched alias and reports unknown or ambiguous aliases", async () => {
		const fixture = await createRuntime();
		seedLearning(fixture, "repo", REPO_LEARNING);
		const [entry] = listRankedEntries(fixture);
		if (!entry) throw new Error("seeded learning missing");

		const archived = await executeAcpBuiltinSlashCommand(`/learning drop ${entry.alias}`, fixture.runtime);
		const unknown = await executeAcpBuiltinSlashCommand("/learning drop deadbeef", fixture.runtime);
		const ambiguousSpy = vi.spyOn(learningStorage, "findActiveByAliasPrefix").mockReturnValue([entry, entry]);
		const ambiguous = await executeAcpBuiltinSlashCommand(`/learning drop ${entry.alias}`, fixture.runtime);

		expect(archived).toEqual({ consumed: true });
		expect(unknown).toEqual({ consumed: true });
		expect(ambiguous).toEqual({ consumed: true });
		expect(listRankedEntries(fixture)).toEqual([]);
		expect(fixture.output[0]).toContain(`[l:${entry.alias}]`);
		expect(fixture.output[1]).toBe("Unknown live learning alias: deadbeef.");
		expect(fixture.output[2]).toBe(`Live learning alias is ambiguous: ${entry.alias}.`);
		expect(ambiguousSpy).toHaveBeenCalledWith(expect.anything(), { aliasPrefix: entry.alias, repoKey: fixture.cwd });
	});
});
