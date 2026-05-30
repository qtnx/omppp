import { afterEach, describe, expect, type Mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	closeLearningDb,
	type LearningScope,
	openLearningDb,
	upsertLearning,
} from "@oh-my-pi/pi-coding-agent/learnings/storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getAgentDbPath, Snowflake } from "@oh-my-pi/pi-utils";

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
	const dir = path.join(os.tmpdir(), `${prefix}-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
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

function seedLearning(fixture: RuntimeFixture, scope: LearningScope, content: string): void {
	const db = openLearningDb(getAgentDbPath(fixture.agentDir));
	try {
		upsertLearning(db, {
			scope,
			cwd: fixture.cwd,
			content,
			sourceMessageHash: `message-${scope}`,
			trigger: "guideline",
			confidence: 0.91,
			nowSec: 1_800_000_000 + (scope === "repo" ? 1 : 0),
		});
	} finally {
		closeLearningDb(db);
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

	test("view shows the current live-learning injection payload", async () => {
		const fixture = await createRuntime();
		seedLearning(fixture, "repo", REPO_LEARNING);

		const result = await executeAcpBuiltinSlashCommand("/learning", fixture.runtime);

		expect(result).toEqual({ consumed: true });
		expect(fixture.output).toHaveLength(1);
		expect(fixture.output[0]).toContain("Repository-specific learnings");
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
});
