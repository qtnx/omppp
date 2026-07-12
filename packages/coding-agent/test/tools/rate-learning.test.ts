import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as learningStorage from "@oh-my-pi/pi-coding-agent/learnings/storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { RateLearningTool } from "@oh-my-pi/pi-coding-agent/tools/rate-learning";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

const tempDirs = new Set<string>();

interface Fixture {
	agentDir: string;
	cwd: string;
	session: ToolSession;
}

interface StoredLearning {
	id: string;
	alias: string;
}

interface LearningStats {
	strength: number;
	usefulCount: number;
	notUsefulCount: number;
}

async function createFixture(options: { enabled?: boolean; taskDepth?: number } = {}): Promise<Fixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-rate-learning-"));
	tempDirs.add(dir);
	const agentDir = path.join(dir, "agent");
	const cwd = path.join(dir, "repo");
	await Promise.all([fs.mkdir(agentDir), fs.mkdir(cwd)]);
	const settings = await Settings.loadReadOnly({
		agentDir,
		cwd,
		overrides: { "learning.enabled": options.enabled ?? true },
	});
	const session = {
		cwd,
		hasUI: false,
		settings,
		taskDepth: options.taskDepth,
		getSessionFile: () => null,
		getSessionId: () => "rate-learning-test-session",
		getSessionSpawns: () => "*",
	} as ToolSession;
	return { agentDir, cwd, session };
}

function seedLearning(fixture: Fixture, content: string): StoredLearning {
	const db = learningStorage.openLearningDb(getAgentDbPath(fixture.agentDir));
	try {
		const nowSec = Math.floor(Date.now() / 1_000);
		learningStorage.upsertLearning(db, {
			scope: "repo",
			cwd: fixture.cwd,
			repoKey: fixture.cwd,
			content,
			sourceMessageHash: `message-${content}`,
			trigger: "test",
			confidence: 0.8,
			nowSec,
		});
		const row = db.prepare("SELECT id, content_hash FROM live_learnings WHERE content = ?").get(content) as {
			id: string;
			content_hash: string;
		} | null;
		if (!row) throw new Error(`seeded learning was not found: ${content}`);
		return { id: row.id, alias: row.content_hash.slice(0, 12) };
	} finally {
		learningStorage.closeLearningDb(db);
	}
}

function setStrength(fixture: Fixture, learningId: string, strength: number): void {
	const db = learningStorage.openLearningDb(getAgentDbPath(fixture.agentDir));
	try {
		db.prepare("UPDATE live_learnings SET strength = ? WHERE id = ?").run(strength, learningId);
	} finally {
		learningStorage.closeLearningDb(db);
	}
}

function readStats(fixture: Fixture, learningId: string): LearningStats {
	const db = learningStorage.openLearningDb(getAgentDbPath(fixture.agentDir));
	try {
		const row = db
			.prepare("SELECT strength, useful_count, not_useful_count FROM live_learnings WHERE id = ?")
			.get(learningId) as { strength: number; useful_count: number; not_useful_count: number } | null;
		if (!row) throw new Error(`learning was not found: ${learningId}`);
		return { strength: row.strength, usefulCount: row.useful_count, notUsefulCount: row.not_useful_count };
	} finally {
		learningStorage.closeLearningDb(db);
	}
}

function resultText(result: AgentToolResult): string {
	const text = result.content.find(item => item.type === "text");
	return text?.type === "text" ? text.text : "";
}

function insertAmbiguousAliases(fixture: Fixture): void {
	const db = learningStorage.openLearningDb(getAgentDbPath(fixture.agentDir));
	try {
		for (const suffix of ["000001", "000002"]) {
			db.prepare(`
INSERT INTO live_learnings (
	id, scope, cwd, content, content_hash, source_message_hash, trigger, confidence, created_at, updated_at,
	status, strength, useful_count, not_useful_count, last_reinforced_at, repo_key
) VALUES (?, 'repo', ?, ?, ?, 'message', 'test', 0.8, 1, 1, 'active', 1, 0, 0, 1, ?)
`).run(`ambiguous-${suffix}`, fixture.cwd, `ambiguous ${suffix}`, `abcdef${suffix}`, fixture.cwd);
		}
	} finally {
		learningStorage.closeLearningDb(db);
	}
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all([...tempDirs].map(dir => fs.rm(dir, { recursive: true, force: true })));
	tempDirs.clear();
});

describe("RateLearningTool", () => {
	test("is available only for top-level sessions with live learning enabled", async () => {
		const disabled = await createFixture({ enabled: false });
		const nested = await createFixture({ taskDepth: 1 });
		const enabled = await createFixture();

		expect(RateLearningTool.createIf(disabled.session)).toBeNull();
		expect(RateLearningTool.createIf(nested.session)).toBeNull();
		expect(RateLearningTool.createIf(enabled.session)).toBeInstanceOf(RateLearningTool);
	});

	test("records useful and not-useful feedback from prefixed and bare aliases", async () => {
		const fixture = await createFixture();
		const useful = seedLearning(fixture, "Use the repository's real command harness.");
		const notUseful = seedLearning(fixture, "Prefer task-scoped implementation notes.");
		setStrength(fixture, useful.id, 9.8);
		setStrength(fixture, notUseful.id, 0);
		const tool = RateLearningTool.createIf(fixture.session);
		if (!tool) throw new Error("rate learning tool was not created");

		const result = await tool.execute("call-1", {
			ratings: [
				{ id: `l:${useful.alias}`, verdict: "useful" },
				{ id: notUseful.alias, verdict: "not_useful", reason: "obsolete" },
			],
		});

		expect(resultText(result)).toContain("ok");
		expect(readStats(fixture, useful.id)).toEqual({ strength: 10, usefulCount: 1, notUsefulCount: 0 });
		expect(readStats(fixture, notUseful.id)).toEqual({ strength: 0, usefulCount: 0, notUsefulCount: 1 });
	});

	test("reports unknown, ambiguous, and stale aliases without throwing", async () => {
		const fixture = await createFixture();
		const stale = seedLearning(fixture, "Record only durable preferences.");
		insertAmbiguousAliases(fixture);
		const tool = RateLearningTool.createIf(fixture.session);
		if (!tool) throw new Error("rate learning tool was not created");
		vi.spyOn(learningStorage, "recordLearningFeedback").mockReturnValue(false);

		const result = await tool.execute("call-2", {
			ratings: [
				{ id: "zzzzzz", verdict: "useful" },
				{ id: "abcdef", verdict: "useful" },
				{ id: stale.alias, verdict: "not_useful" },
			],
		});
		const text = resultText(result);

		expect(text).toContain("unknown id");
		expect(text).toContain("ambiguous");
		expect(text).toContain("stale");
	});
});
