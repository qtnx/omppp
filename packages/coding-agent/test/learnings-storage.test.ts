import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	archiveLearning,
	closeLearningDb,
	computeLearningWatermark,
	findActiveByAliasPrefix,
	healCurrentCwdRows,
	healSiblingLegacyCwds,
	insertConsolidatedEntry,
	isConsolidationClaimHeld,
	learningContentHash,
	listActiveLearnings,
	markConsolidationFailed,
	markConsolidationSucceeded,
	markMergedInto,
	mergeConsolidatedEntries,
	openLearningDb,
	recordLearningFeedback,
	reinforceLearning,
	rescopeLearning,
	resolveActiveSurvivor,
	rewriteLearning,
	sweepTombstoneTouches,
	tryClaimConsolidationJob,
	upsertLearning,
} from "@oh-my-pi/pi-coding-agent/learnings/storage";

type LearningRow = {
	id: string;
	scope: string;
	cwd: string;
	content: string;
	content_hash: string;
	source_message_hash: string;
	trigger: string;
	confidence: number;
	created_at: number;
	updated_at: number;
	status: string;
	status_changed_at: number | null;
	strength: number;
	useful_count: number;
	not_useful_count: number;
	last_reinforced_at: number | null;
	merged_into: string | null;
	repo_key: string | null;
};

type JobRow = {
	status: string;
	ownership_token: string | null;
	lease_until: number | null;
	retry_remaining: number;
	retry_at: number | null;
	input_watermark: number | null;
	last_success_watermark: number | null;
};

const tempDirs = new Set<string>();

async function createDb(): Promise<Database> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-learnings-storage-"));
	tempDirs.add(dir);
	return openLearningDb(path.join(dir, "agent.db"));
}

function readLearning(db: Database, id: string): LearningRow {
	const row = db.prepare("SELECT * FROM live_learnings WHERE id = ?").get(id) as LearningRow | null;
	if (!row) throw new Error(`learning ${id} was not found`);
	return row;
}

function activeRow(db: Database, content: string): LearningRow {
	const row = db
		.prepare("SELECT * FROM live_learnings WHERE content = ? AND status = 'active'")
		.get(content) as LearningRow | null;
	if (!row) throw new Error(`active learning for ${content} was not found`);
	return row;
}

function readJob(db: Database, jobKey: string): JobRow {
	const row = db
		.prepare(
			"SELECT status, ownership_token, lease_until, retry_remaining, retry_at, input_watermark, last_success_watermark FROM live_learning_jobs WHERE kind = 'consolidation' AND job_key = ?",
		)
		.get(jobKey) as JobRow | null;
	if (!row) throw new Error(`job ${jobKey} was not found`);
	return row;
}

function store(
	db: Database,
	params: {
		content: string;
		nowSec: number;
		scope?: "global" | "repo";
		cwd?: string;
		repoKey?: string;
		confidence?: number;
	},
): void {
	upsertLearning(db, {
		scope: params.scope ?? "repo",
		cwd: params.cwd ?? "/worktree",
		repoKey: params.repoKey,
		content: params.content,
		sourceMessageHash: `message-${params.content}`,
		trigger: "test",
		confidence: params.confidence ?? 0.5,
		nowSec: params.nowSec,
	});
}

function insertLegacy(
	db: Database,
	params: {
		id: string;
		cwd: string;
		content: string;
		nowSec: number;
		contentHash?: string;
		strength?: number;
		usefulCount?: number;
		notUsefulCount?: number;
		status?: "active" | "merged" | "archived";
		mergedInto?: string | null;
		repoKey?: string | null;
	},
): void {
	const scope = "repo";
	const contentHash = params.contentHash ?? learningContentHash(scope, params.cwd, params.content);
	db.prepare(`
INSERT INTO live_learnings (
	id, scope, cwd, content, content_hash, source_message_hash, trigger, confidence, created_at, updated_at,
	status, status_changed_at, strength, useful_count, not_useful_count, last_reinforced_at, merged_into, repo_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
		params.id,
		scope,
		params.cwd,
		params.content,
		contentHash,
		`message-${params.id}`,
		"test",
		0.5,
		params.nowSec,
		params.nowSec,
		params.status ?? "active",
		params.status === "active" ? null : params.nowSec,
		params.strength ?? 1,
		params.usefulCount ?? 0,
		params.notUsefulCount ?? 0,
		params.nowSec,
		params.mergedInto ?? null,
		params.repoKey ?? null,
	);
}

afterEach(async () => {
	for (const dir of tempDirs) {
		await fs.rm(dir, { recursive: true, force: true });
	}
	tempDirs.clear();
});

describe("learnings/storage", () => {
	test("migrates a legacy-shaped database idempotently", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-learnings-migration-"));
		tempDirs.add(dir);
		const dbPath = path.join(dir, "agent.db");
		const legacy = new Database(dbPath);
		legacy.exec(`
CREATE TABLE live_learnings (
	id TEXT PRIMARY KEY, scope TEXT NOT NULL, cwd TEXT NOT NULL, content TEXT NOT NULL,
	content_hash TEXT NOT NULL, source_message_hash TEXT NOT NULL, trigger TEXT NOT NULL,
	confidence REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
	UNIQUE(scope, cwd, content_hash)
);
INSERT INTO live_learnings VALUES ('legacy', 'repo', '/legacy', 'legacy content', 'hash', 'message', 'test', 0.5, 10, 10);
`);
		legacy.close();

		const first = openLearningDb(dbPath);
		const columns = first.prepare("PRAGMA table_info(live_learnings)").all() as Array<{ name: string }>;
		expect(columns.map(column => column.name)).toEqual(
			expect.arrayContaining([
				"status",
				"status_changed_at",
				"strength",
				"useful_count",
				"not_useful_count",
				"last_reinforced_at",
				"merged_into",
				"repo_key",
			]),
		);
		const migrated = readLearning(first, "legacy");
		expect(migrated.status).toBe("active");
		expect(migrated.strength).toBe(1);
		expect(migrated.last_reinforced_at).toBe(10);
		closeLearningDb(first);

		const second = openLearningDb(dbPath);
		expect(second.prepare("SELECT COUNT(*) AS count FROM live_learning_feedback").get()).toEqual({ count: 0 });
		expect(second.prepare("SELECT COUNT(*) AS count FROM live_learning_jobs").get()).toEqual({ count: 0 });
		closeLearningDb(second);
	});

	test("allows two openers to race a legacy-column migration", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-learnings-migration-race-"));
		tempDirs.add(dir);
		const dbPath = path.join(dir, "agent.db");
		const legacy = new Database(dbPath);
		legacy.exec(`
CREATE TABLE live_learnings (
	id TEXT PRIMARY KEY, scope TEXT NOT NULL, cwd TEXT NOT NULL, content TEXT NOT NULL,
	content_hash TEXT NOT NULL, source_message_hash TEXT NOT NULL, trigger TEXT NOT NULL,
	confidence REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
	UNIQUE(scope, cwd, content_hash)
);
`);
		legacy.close();

		let concurrentOpened = false;
		const originalExec = Database.prototype.exec;
		vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
			if (
				!concurrentOpened &&
				sql === "ALTER TABLE live_learnings ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"
			) {
				concurrentOpened = true;
				const concurrent = openLearningDb(dbPath);
				closeLearningDb(concurrent);
			}
			return originalExec.call(this, sql);
		});

		const winner = openLearningDb(dbPath);
		expect(concurrentOpened).toBe(true);
		expect(winner.prepare("PRAGMA table_info(live_learnings)").all()).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "repo_key" })]),
		);
		closeLearningDb(winner);
	});

	test("deduplicates repo writes by repo key across worktrees", async () => {
		const db = await createDb();
		store(db, { content: "Keep verification current.", cwd: "/repo/worktree-a", repoKey: "/repo", nowSec: 10 });
		store(db, {
			content: "Keep verification current.",
			cwd: "/repo/worktree-b",
			repoKey: "/repo",
			nowSec: 11,
			confidence: 0.8,
		});

		const rows = db.prepare("SELECT * FROM live_learnings WHERE scope = 'repo'").all() as LearningRow[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.cwd).toBe("/repo");
		expect(rows[0]?.repo_key).toBe("/repo");
		expect(rows[0]?.strength).toBe(2);
		expect(rows[0]?.confidence).toBe(0.8);
	});

	test("redirects merged tombstone upserts and cleanly reactivates archived rows", async () => {
		const db = await createDb();
		store(db, { content: "Older wording", repoKey: "/repo", nowSec: 10 });
		store(db, { content: "Surviving wording", repoKey: "/repo", nowSec: 11 });
		const loser = activeRow(db, "Older wording");
		const survivor = activeRow(db, "Surviving wording");
		expect(
			markMergedInto(db, { id: loser.id, into: survivor.id, guardUpdatedAt: loser.updated_at, nowSec: 12 }),
		).toBe(true);

		store(db, { content: "Older wording", repoKey: "/repo", nowSec: 13, confidence: 0.9 });
		expect(readLearning(db, loser.id).status).toBe("merged");
		expect(readLearning(db, survivor.id).strength).toBe(2);

		store(db, { content: "Archived wording", repoKey: "/repo", nowSec: 14 });
		const archived = activeRow(db, "Archived wording");
		expect(
			recordLearningFeedback(db, { learningId: archived.id, sessionId: "s1", verdict: "not_useful", nowSec: 15 }),
		).toBe(true);
		expect(
			archiveLearning(db, { id: archived.id, guardUpdatedAt: readLearning(db, archived.id).updated_at, nowSec: 16 }),
		).toBe(true);
		store(db, { content: "Archived wording", repoKey: "/repo", nowSec: 17 });
		const reactivated = readLearning(db, archived.id);
		expect(reactivated.status).toBe("active");
		expect(reactivated.merged_into).toBeNull();
		expect(reactivated.not_useful_count).toBe(1);
	});

	test("reactivates and reinforces an archived duplicate upsert", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "archived-upsert-owner",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Archived duplicate",
			nowSec: 10,
			strength: 4,
		});
		expect(archiveLearning(db, { id: "archived-upsert-owner", guardUpdatedAt: 10, nowSec: 11 })).toBe(true);

		expect(
			upsertLearning(db, {
				scope: "repo",
				cwd: "/repo/worktree",
				repoKey: "/repo",
				content: "Archived duplicate",
				sourceMessageHash: "fresh-message",
				trigger: "fresh-trigger",
				confidence: 0.9,
				nowSec: 12,
			}),
		).toBe(true);

		expect(readLearning(db, "archived-upsert-owner")).toMatchObject({
			status: "active",
			strength: 5,
			confidence: 0.9,
			last_reinforced_at: 12,
			updated_at: 12,
			source_message_hash: "fresh-message",
			trigger: "fresh-trigger",
		});
	});

	test("accumulates merged statistics into a reactivated archived consolidated owner", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "archived-consolidated-owner",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Consolidated archive target",
			nowSec: 10,
			strength: 4,
			usefulCount: 10,
			notUsefulCount: 8,
		});
		db.prepare("UPDATE live_learnings SET last_reinforced_at = 30 WHERE id = ?").run("archived-consolidated-owner");
		expect(archiveLearning(db, { id: "archived-consolidated-owner", guardUpdatedAt: 10, nowSec: 11 })).toBe(true);
		insertLegacy(db, {
			id: "merge-source-a",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Merge source A",
			nowSec: 12,
			strength: 3,
			usefulCount: 4,
			notUsefulCount: 1,
		});
		insertLegacy(db, {
			id: "merge-source-b",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Merge source B",
			nowSec: 13,
			strength: 5,
			usefulCount: 6,
			notUsefulCount: 2,
		});

		expect(
			mergeConsolidatedEntries(db, {
				sources: [
					{ id: "merge-source-a", guardUpdatedAt: 12 },
					{ id: "merge-source-b", guardUpdatedAt: 13 },
				],
				scope: "repo",
				repoKey: "/repo",
				content: "Consolidated archive target",
				strength: 8,
				usefulCount: 10,
				notUsefulCount: 3,
				confidence: 0.9,
				createdAt: 12,
				lastReinforcedAt: 25,
				nowSec: 20,
			}),
		).toBe(true);

		expect(readLearning(db, "archived-consolidated-owner")).toMatchObject({
			status: "active",
			strength: 10,
			useful_count: 20,
			not_useful_count: 11,
			confidence: 0.9,
			last_reinforced_at: 30,
		});
		expect(readLearning(db, "merge-source-a")).toMatchObject({
			status: "merged",
			merged_into: "archived-consolidated-owner",
		});
		expect(readLearning(db, "merge-source-b")).toMatchObject({
			status: "merged",
			merged_into: "archived-consolidated-owner",
		});
	});

	test("does not double-accumulate a brand-new consolidated insert", async () => {
		const db = await createDb();

		const inserted = insertConsolidatedEntry(db, {
			scope: "repo",
			repoKey: "/repo",
			content: "Brand-new consolidated target",
			strength: 7,
			usefulCount: 12,
			notUsefulCount: 3,
			confidence: 0.9,
			createdAt: 10,
			lastReinforcedAt: 11,
			nowSec: 12,
		});

		expect(readLearning(db, inserted.id)).toMatchObject({
			status: "active",
			strength: 7,
			useful_count: 12,
			not_useful_count: 3,
			confidence: 0.9,
			last_reinforced_at: 11,
		});
	});

	test("guards a tombstone marker against a redirect-time old-binary bump and remains idempotent", async () => {
		const db = await createDb();
		store(db, { content: "Old", repoKey: "/repo", nowSec: 10 });
		store(db, { content: "New", repoKey: "/repo", nowSec: 11 });
		const loser = activeRow(db, "Old");
		const survivor = activeRow(db, "New");
		markMergedInto(db, { id: loser.id, into: survivor.id, guardUpdatedAt: loser.updated_at, nowSec: 12 });
		db.prepare("UPDATE live_learnings SET updated_at = 13 WHERE id = ?").run(loser.id);
		db.exec(`
CREATE TRIGGER tombstone_marker_race
AFTER UPDATE OF strength ON live_learnings
WHEN NEW.id = '${survivor.id}'
BEGIN
	UPDATE live_learnings SET updated_at = 14 WHERE id = '${loser.id}';
END;
`);

		expect(sweepTombstoneTouches(db, { repoKey: "/repo", nowSec: 14 })).toBe(0);
		expect(readLearning(db, loser.id).status_changed_at).toBe(12);
		expect(readLearning(db, loser.id).updated_at).toBe(14);
		db.exec("DROP TRIGGER tombstone_marker_race");
		expect(sweepTombstoneTouches(db, { repoKey: "/repo", nowSec: 15 })).toBe(1);
		expect(readLearning(db, survivor.id).strength).toBe(3);
		expect(readLearning(db, loser.id).status_changed_at).toBe(14);
		expect(sweepTombstoneTouches(db, { repoKey: "/repo", nowSec: 16 })).toBe(0);

		db.prepare("UPDATE live_learnings SET updated_at = 17 WHERE id = ?").run(loser.id);
		expect(sweepTombstoneTouches(db, { repoKey: "/repo", nowSec: 18 })).toBe(1);
		expect(readLearning(db, loser.id).status_changed_at).toBe(17);
		expect(readLearning(db, survivor.id).strength).toBe(4);
	});

	test("heals current-cwd rows and merges conflicting stats with caps", async () => {
		const db = await createDb();
		const content = "A durable repo rule";
		insertLegacy(db, {
			id: "legacy",
			cwd: "/repo/worktree",
			content,
			nowSec: 10,
			strength: 8,
			usefulCount: 800,
			notUsefulCount: 700,
		});
		insertLegacy(db, {
			id: "winner",
			cwd: "/repo",
			repoKey: "/repo",
			content,
			contentHash: learningContentHash("repo", "/repo", content),
			nowSec: 11,
			strength: 7,
			usefulCount: 500,
			notUsefulCount: 600,
		});

		expect(healCurrentCwdRows(db, { cwd: "/repo/worktree", repoKey: "/repo", nowSec: 12 })).toBe(1);
		const winner = readLearning(db, "winner");
		const loser = readLearning(db, "legacy");
		expect(winner.strength).toBe(10);
		expect(winner.useful_count).toBe(999);
		expect(winner.not_useful_count).toBe(999);
		expect(loser.status).toBe("merged");
		expect(loser.merged_into).toBe("winner");
	});

	test("redirects rewrite conflict stats from a merged key owner to its active survivor", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "rewrite-source",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Rewrite source",
			nowSec: 10,
			strength: 4,
			usefulCount: 2,
			notUsefulCount: 1,
		});
		insertLegacy(db, {
			id: "merged-key-owner",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Rewrite target",
			nowSec: 11,
			strength: 2,
			usefulCount: 5,
			notUsefulCount: 6,
		});
		insertLegacy(db, {
			id: "active-survivor",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Surviving target",
			nowSec: 12,
			strength: 5,
			usefulCount: 3,
			notUsefulCount: 7,
		});
		expect(
			markMergedInto(db, {
				id: "merged-key-owner",
				into: "active-survivor",
				guardUpdatedAt: 11,
				nowSec: 13,
			}),
		).toBe(true);

		expect(
			rewriteLearning(db, {
				id: "rewrite-source",
				content: "Rewrite target",
				guardUpdatedAt: 10,
				nowSec: 14,
			}),
		).toBe(true);

		const survivor = readLearning(db, "active-survivor");
		const source = readLearning(db, "rewrite-source");
		expect(survivor.status).toBe("active");
		expect(survivor.strength).toBe(9);
		expect(survivor.useful_count).toBe(5);
		expect(survivor.not_useful_count).toBe(8);
		expect(source.status).toBe("merged");
		expect(source.merged_into).toBe("active-survivor");
		expect(readLearning(db, "merged-key-owner").merged_into).toBe("active-survivor");
	});

	test("does not self-accumulate when a merged key owner resolves to the rewrite source", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "active-survivor",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Survivor wording",
			nowSec: 10,
			strength: 4,
			usefulCount: 2,
			notUsefulCount: 1,
		});
		insertLegacy(db, {
			id: "merged-key-owner",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Tombstone wording",
			nowSec: 11,
		});
		expect(
			markMergedInto(db, {
				id: "merged-key-owner",
				into: "active-survivor",
				guardUpdatedAt: 11,
				nowSec: 12,
			}),
		).toBe(true);

		expect(
			rewriteLearning(db, {
				id: "active-survivor",
				content: "Tombstone wording",
				guardUpdatedAt: 10,
				nowSec: 13,
			}),
		).toBe(false);

		const survivor = readLearning(db, "active-survivor");
		expect(survivor.status).toBe("active");
		expect(survivor.strength).toBe(4);
		expect(survivor.useful_count).toBe(2);
		expect(survivor.not_useful_count).toBe(1);
		expect(survivor.updated_at).toBe(10);
		expect(readLearning(db, "merged-key-owner").merged_into).toBe("active-survivor");
	});

	test("reactivates an archived rewrite conflict before accumulating stats", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "archived-source",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Archived source",
			nowSec: 10,
			strength: 4,
			usefulCount: 2,
			notUsefulCount: 1,
		});
		insertLegacy(db, {
			id: "archived-key-owner",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Archived target",
			nowSec: 11,
			strength: 3,
			usefulCount: 4,
			notUsefulCount: 5,
		});
		expect(archiveLearning(db, { id: "archived-key-owner", guardUpdatedAt: 11, nowSec: 12 })).toBe(true);

		expect(
			rewriteLearning(db, {
				id: "archived-source",
				content: "Archived target",
				guardUpdatedAt: 10,
				nowSec: 13,
			}),
		).toBe(true);

		const winner = readLearning(db, "archived-key-owner");
		const source = readLearning(db, "archived-source");
		expect(winner.status).toBe("active");
		expect(winner.merged_into).toBeNull();
		expect(winner.strength).toBe(7);
		expect(winner.useful_count).toBe(6);
		expect(winner.not_useful_count).toBe(6);
		expect(source.status).toBe("merged");
		expect(source.merged_into).toBe("archived-key-owner");
	});
	test("heals matching sibling legacy worktrees without crossing nested repos or probe limit", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-learnings-siblings-"));
		tempDirs.add(root);
		const db = openLearningDb(path.join(root, "agent.db"));
		const repoKey = path.join(root, "repo");
		const sibling = path.join(repoKey, "a");
		const foreign = path.join(repoKey, "b-foreign");
		const unprobed = path.join(repoKey, "c");
		await Promise.all([
			fs.mkdir(sibling, { recursive: true }),
			fs.mkdir(foreign, { recursive: true }),
			fs.mkdir(unprobed, { recursive: true }),
		]);
		insertLegacy(db, { id: "a", cwd: sibling, content: "A", nowSec: 10 });
		insertLegacy(db, { id: "foreign", cwd: foreign, content: "B", nowSec: 10 });
		insertLegacy(db, { id: "c", cwd: unprobed, content: "C", nowSec: 10 });
		const probed: string[] = [];

		const healed = await healSiblingLegacyCwds(db, {
			repoKey,
			resolveKey: async cwd => {
				probed.push(cwd);
				return cwd === foreign ? foreign : repoKey;
			},
			probeLimit: 2,
			nowSec: 20,
		});
		expect(healed).toBe(1);
		expect(probed).toEqual([sibling, foreign]);
		expect(readLearning(db, "a").repo_key).toBe(repoKey);
		expect(readLearning(db, "foreign").repo_key).toBeNull();
		expect(readLearning(db, "c").repo_key).toBeNull();
	});

	test("reads only active rows from the global and matching COALESCE keyspaces", async () => {
		const db = await createDb();
		store(db, { scope: "global", content: "Global", nowSec: 10 });
		store(db, { content: "Repo", repoKey: "/repo", nowSec: 10 });
		insertLegacy(db, { id: "legacy-match", cwd: "/repo", content: "Legacy match", nowSec: 11 });
		insertLegacy(db, { id: "foreign", cwd: "/other", content: "Foreign", nowSec: 12 });
		const foreign = readLearning(db, "foreign");
		archiveLearning(db, { id: foreign.id, guardUpdatedAt: foreign.updated_at, nowSec: 13 });

		const entries = listActiveLearnings(db, { repoKey: "/repo", limitPerScope: 10, halfLifeDays: 45, nowSec: 14 });
		expect(entries.map(entry => entry.content)).toEqual(expect.arrayContaining(["Global", "Repo", "Legacy match"]));
		expect(entries.map(entry => entry.content)).not.toContain("Foreign");
	});

	test("ranks active entries by decayed score and hides heavily rejected rows", async () => {
		const db = await createDb();
		store(db, { content: "Low score", repoKey: "/repo", nowSec: 100 });
		store(db, { content: "High score", repoKey: "/repo", nowSec: 100 });
		store(db, { content: "Hidden", repoKey: "/repo", nowSec: 100 });
		const low = activeRow(db, "Low score");
		const high = activeRow(db, "High score");
		const hidden = activeRow(db, "Hidden");
		db.prepare("UPDATE live_learnings SET strength = 4, useful_count = 2 WHERE id = ?").run(high.id);
		db.prepare("UPDATE live_learnings SET not_useful_count = 3 WHERE id = ?").run(hidden.id);

		const entries = listActiveLearnings(db, { repoKey: "/repo", limitPerScope: 10, halfLifeDays: 45, nowSec: 100 });
		expect(entries.filter(entry => entry.scope === "repo").map(entry => entry.id)).toEqual([high.id, low.id]);
		expect(entries.map(entry => entry.id)).not.toContain(hidden.id);
	});

	test("resolves aliases as none, one, or ambiguous across global and repo entries", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "one",
			cwd: "/repo",
			repoKey: "/repo",
			content: "One",
			contentHash: "123456abcdef0000",
			nowSec: 10,
		});
		insertLegacy(db, {
			id: "repo-duplicate",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Repo duplicate",
			contentHash: "abcdef1111111111",
			nowSec: 10,
		});
		db.prepare(`
INSERT INTO live_learnings (
	id, scope, cwd, content, content_hash, source_message_hash, trigger, confidence, created_at, updated_at,
	status, strength, useful_count, not_useful_count, repo_key
) VALUES ('global-duplicate', 'global', '', 'Global duplicate', 'abcdef2222222222', 'message', 'test', 0.5, 10, 10, 'active', 1, 0, 0, '')
`).run();

		expect(findActiveByAliasPrefix(db, { aliasPrefix: "bbbbbb", repoKey: "/repo" })).toEqual([]);
		expect(findActiveByAliasPrefix(db, { aliasPrefix: "123456", repoKey: "/repo" }).map(entry => entry.id)).toEqual([
			"one",
		]);
		expect(findActiveByAliasPrefix(db, { aliasPrefix: "abcdef", repoKey: "/repo" })).toHaveLength(2);
	});

	test("records feedback only on active hits with bounded strength math", async () => {
		const db = await createDb();
		store(db, { content: "Rated", repoKey: "/repo", nowSec: 10 });
		const rated = activeRow(db, "Rated");
		db.prepare("UPDATE live_learnings SET strength = 9.8 WHERE id = ?").run(rated.id);

		expect(
			recordLearningFeedback(db, {
				learningId: rated.id,
				sessionId: "s1",
				verdict: "useful",
				reason: "used",
				nowSec: 11,
			}),
		).toBe(true);
		for (let nowSec = 12; nowSec < 25; nowSec += 1) {
			recordLearningFeedback(db, { learningId: rated.id, sessionId: `s${nowSec}`, verdict: "not_useful", nowSec });
		}
		const updated = readLearning(db, rated.id);
		expect(updated.strength).toBe(0);
		expect(updated.useful_count).toBe(1);
		expect(updated.not_useful_count).toBe(13);

		expect(
			recordLearningFeedback(db, { learningId: "missing", sessionId: "s-miss", verdict: "useful", nowSec: 30 }),
		).toBe(false);
		expect(
			db.prepare("SELECT COUNT(*) AS count FROM live_learning_feedback WHERE learning_id = 'missing'").get(),
		).toEqual({ count: 0 });
	});

	test("applies reinforcement and optimistic guards without stale rewrites", async () => {
		const db = await createDb();
		store(db, { content: "Guarded", repoKey: "/repo", nowSec: 10 });
		const entry = activeRow(db, "Guarded");
		expect(reinforceLearning(db, { id: entry.id, confidence: 0.9, nowSec: 11 })).toBe(true);
		expect(archiveLearning(db, { id: entry.id, guardUpdatedAt: entry.updated_at, nowSec: 12 })).toBe(false);
		expect(
			rescopeLearning(db, {
				id: entry.id,
				scope: "global",
				repoKey: "",
				guardUpdatedAt: entry.updated_at,
				nowSec: 12,
			}),
		).toBe(false);
		expect(
			rewriteLearning(db, { id: entry.id, content: "Stale", guardUpdatedAt: entry.updated_at, nowSec: 12 }),
		).toBe(false);
		expect(readLearning(db, entry.id).content).toBe("Guarded");
	});

	test("merges aggregate stats into an existing consolidated entry without duplicating it", async () => {
		const db = await createDb();
		store(db, { content: "Consolidated", repoKey: "/repo", nowSec: 10 });
		const existing = activeRow(db, "Consolidated");
		insertLegacy(db, {
			id: "consolidation-source-a",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Consolidation source A",
			nowSec: 8,
			strength: 3,
			usefulCount: 4,
			notUsefulCount: 1,
		});
		insertLegacy(db, {
			id: "consolidation-source-b",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Consolidation source B",
			nowSec: 9,
			strength: 4,
			usefulCount: 6,
			notUsefulCount: 1,
		});

		expect(
			mergeConsolidatedEntries(db, {
				sources: [
					{ id: "consolidation-source-a", guardUpdatedAt: 8 },
					{ id: "consolidation-source-b", guardUpdatedAt: 9 },
				],
				scope: "repo",
				repoKey: "/repo",
				content: "Consolidated",
				strength: 7,
				usefulCount: 10,
				notUsefulCount: 2,
				confidence: 0.9,
				createdAt: 5,
				lastReinforcedAt: 9,
				nowSec: 11,
			}),
		).toBe(true);

		expect(readLearning(db, existing.id)).toMatchObject({
			status: "active",
			strength: 8,
			useful_count: 10,
			not_useful_count: 2,
			confidence: 0.9,
			last_reinforced_at: 10,
		});
		expect(readLearning(db, "consolidation-source-a")).toMatchObject({
			status: "merged",
			merged_into: existing.id,
		});
		expect(readLearning(db, "consolidation-source-b")).toMatchObject({
			status: "merged",
			merged_into: existing.id,
		});
		expect(db.prepare("SELECT COUNT(*) AS count FROM live_learnings").get()).toEqual({ count: 3 });
	});

	test("sets self-winning consolidation stats to the aggregate exactly once", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "self-winning-source-a",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Self-winning consolidation",
			nowSec: 10,
			strength: 3,
			usefulCount: 30,
			notUsefulCount: 2,
		});
		insertLegacy(db, {
			id: "self-winning-source-b",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Self-winning source B",
			nowSec: 11,
			strength: 4,
			usefulCount: 20,
			notUsefulCount: 3,
		});
		insertLegacy(db, {
			id: "self-winning-source-c",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Self-winning source C",
			nowSec: 12,
			strength: 2,
			usefulCount: 10,
			notUsefulCount: 4,
		});

		expect(
			mergeConsolidatedEntries(db, {
				sources: [
					{ id: "self-winning-source-a", guardUpdatedAt: 10 },
					{ id: "self-winning-source-b", guardUpdatedAt: 11 },
					{ id: "self-winning-source-c", guardUpdatedAt: 12 },
				],
				scope: "repo",
				repoKey: "/repo",
				content: "Self-winning consolidation",
				strength: 9,
				usefulCount: 60,
				notUsefulCount: 9,
				confidence: 0.9,
				createdAt: 10,
				lastReinforcedAt: 12,
				nowSec: 20,
			}),
		).toBe(true);

		expect(readLearning(db, "self-winning-source-a")).toMatchObject({
			status: "active",
			merged_into: null,
			strength: 9,
			useful_count: 60,
			not_useful_count: 9,
			confidence: 0.9,
			last_reinforced_at: 12,
		});
		expect(readLearning(db, "self-winning-source-b")).toMatchObject({
			status: "merged",
			merged_into: "self-winning-source-a",
		});
		expect(readLearning(db, "self-winning-source-c")).toMatchObject({
			status: "merged",
			merged_into: "self-winning-source-a",
		});
	});

	test("sets a self-winning capped aggregate instead of adding it again", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "capped-self-winning-source-a",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Capped self-winning consolidation",
			nowSec: 10,
			strength: 5,
			usefulCount: 100,
			notUsefulCount: 1,
		});
		insertLegacy(db, {
			id: "capped-self-winning-source-b",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Capped self-winning source B",
			nowSec: 11,
			strength: 5,
			usefulCount: 200,
			notUsefulCount: 2,
		});
		insertLegacy(db, {
			id: "capped-self-winning-source-c",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Capped self-winning source C",
			nowSec: 12,
			strength: 5,
			usefulCount: 300,
			notUsefulCount: 3,
		});

		expect(
			mergeConsolidatedEntries(db, {
				sources: [
					{ id: "capped-self-winning-source-a", guardUpdatedAt: 10 },
					{ id: "capped-self-winning-source-b", guardUpdatedAt: 11 },
					{ id: "capped-self-winning-source-c", guardUpdatedAt: 12 },
				],
				scope: "repo",
				repoKey: "/repo",
				content: "Capped self-winning consolidation",
				strength: 10,
				usefulCount: 600,
				notUsefulCount: 6,
				confidence: 0.9,
				createdAt: 10,
				lastReinforcedAt: 12,
				nowSec: 20,
			}),
		).toBe(true);

		expect(readLearning(db, "capped-self-winning-source-a")).toMatchObject({
			status: "active",
			strength: 10,
			useful_count: 600,
			not_useful_count: 6,
			confidence: 0.9,
			last_reinforced_at: 12,
		});
	});

	test("adds a merged aggregate to an unrelated active winner", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "unrelated-existing-winner",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Unrelated existing consolidation",
			nowSec: 10,
			strength: 2,
			usefulCount: 8,
			notUsefulCount: 4,
		});
		insertLegacy(db, {
			id: "unrelated-source-a",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Unrelated source A",
			nowSec: 11,
			strength: 3,
			usefulCount: 4,
			notUsefulCount: 1,
		});
		insertLegacy(db, {
			id: "unrelated-source-b",
			cwd: "/repo",
			repoKey: "/repo",
			content: "Unrelated source B",
			nowSec: 12,
			strength: 4,
			usefulCount: 6,
			notUsefulCount: 2,
		});

		expect(
			mergeConsolidatedEntries(db, {
				sources: [
					{ id: "unrelated-source-a", guardUpdatedAt: 11 },
					{ id: "unrelated-source-b", guardUpdatedAt: 12 },
				],
				scope: "repo",
				repoKey: "/repo",
				content: "Unrelated existing consolidation",
				strength: 7,
				usefulCount: 10,
				notUsefulCount: 3,
				confidence: 0.9,
				createdAt: 11,
				lastReinforcedAt: 12,
				nowSec: 20,
			}),
		).toBe(true);

		expect(readLearning(db, "unrelated-existing-winner")).toMatchObject({
			status: "active",
			strength: 9,
			useful_count: 18,
			not_useful_count: 7,
			confidence: 0.9,
			last_reinforced_at: 12,
		});
		expect(readLearning(db, "unrelated-source-a")).toMatchObject({
			status: "merged",
			merged_into: "unrelated-existing-winner",
		});
		expect(readLearning(db, "unrelated-source-b")).toMatchObject({
			status: "merged",
			merged_into: "unrelated-existing-winner",
		});
	});

	test("persists the full aggregate for a brand-new consolidated winner", async () => {
		const db = await createDb();
		insertLegacy(db, {
			id: "new-winner-source-a",
			cwd: "/repo",
			repoKey: "/repo",
			content: "New winner source A",
			nowSec: 10,
			strength: 3,
			usefulCount: 4,
			notUsefulCount: 1,
		});
		insertLegacy(db, {
			id: "new-winner-source-b",
			cwd: "/repo",
			repoKey: "/repo",
			content: "New winner source B",
			nowSec: 11,
			strength: 4,
			usefulCount: 6,
			notUsefulCount: 2,
		});

		expect(
			mergeConsolidatedEntries(db, {
				sources: [
					{ id: "new-winner-source-a", guardUpdatedAt: 10 },
					{ id: "new-winner-source-b", guardUpdatedAt: 11 },
				],
				scope: "repo",
				repoKey: "/repo",
				content: "Brand-new consolidation winner",
				strength: 7,
				usefulCount: 10,
				notUsefulCount: 3,
				confidence: 0.9,
				createdAt: 10,
				lastReinforcedAt: 11,
				nowSec: 20,
			}),
		).toBe(true);

		expect(activeRow(db, "Brand-new consolidation winner")).toMatchObject({
			status: "active",
			strength: 7,
			useful_count: 10,
			not_useful_count: 3,
			confidence: 0.9,
			last_reinforced_at: 11,
		});
		expect(readLearning(db, "new-winner-source-a")).toMatchObject({
			status: "merged",
			merged_into: activeRow(db, "Brand-new consolidation winner").id,
		});
		expect(readLearning(db, "new-winner-source-b")).toMatchObject({
			status: "merged",
			merged_into: activeRow(db, "Brand-new consolidation winner").id,
		});
	});

	test("detects merged survivor cycles and reactivates the touched row", async () => {
		const db = await createDb();
		store(db, { content: "Cycle A", repoKey: "/repo", nowSec: 10 });
		store(db, { content: "Cycle B", repoKey: "/repo", nowSec: 11 });
		const first = activeRow(db, "Cycle A");
		const second = activeRow(db, "Cycle B");
		db.prepare(
			"UPDATE live_learnings SET status = 'merged', status_changed_at = 12, merged_into = ?, updated_at = 12 WHERE id = ?",
		).run(second.id, first.id);
		db.prepare(
			"UPDATE live_learnings SET status = 'merged', status_changed_at = 12, merged_into = ?, updated_at = 12 WHERE id = ?",
		).run(first.id, second.id);

		expect(resolveActiveSurvivor(db, first.id)).toBeNull();
		store(db, { content: "Cycle A", repoKey: "/repo", nowSec: 13 });
		expect(readLearning(db, first.id).status).toBe("active");
		expect(readLearning(db, first.id).merged_into).toBeNull();
	});

	test("holds a consolidation claim only while its token and lease remain current", async () => {
		const db = await createDb();
		const claimed = tryClaimConsolidationJob(db, {
			jobKey: "repo:/repo",
			workerId: "worker-a",
			leaseSeconds: 10,
			nowSec: 100,
			inputWatermark: 8,
			retryLimit: 3,
		});
		if (claimed.kind !== "claimed") throw new Error("expected claim");

		expect(isConsolidationClaimHeld(db, { claim: claimed.claim, nowSec: 109 })).toBe(true);
		expect(
			isConsolidationClaimHeld(db, {
				claim: { ...claimed.claim, ownershipToken: "stale-worker" },
				nowSec: 109,
			}),
		).toBe(false);
		expect(isConsolidationClaimHeld(db, { claim: claimed.claim, nowSec: 110 })).toBe(false);
	});

	test("claims, retries, reclaims, and completes consolidation jobs with exact snapshots", async () => {
		const db = await createDb();
		const claimed = tryClaimConsolidationJob(db, {
			jobKey: "repo:/repo",
			workerId: "worker-a",
			leaseSeconds: 10,
			nowSec: 100,
			inputWatermark: 8,
			retryLimit: 3,
		});
		expect(claimed.kind).toBe("claimed");
		if (claimed.kind !== "claimed") throw new Error("expected claim");
		expect(
			tryClaimConsolidationJob(db, {
				jobKey: "repo:/repo",
				workerId: "worker-b",
				leaseSeconds: 10,
				nowSec: 100,
				inputWatermark: 8,
				retryLimit: 3,
			}).kind,
		).toBe("skipped_running");
		expect(
			markConsolidationSucceeded(db, { claim: { ...claimed.claim, ownershipToken: "wrong" }, nowSec: 101 }),
		).toBe(false);
		expect(
			markConsolidationFailed(db, { claim: claimed.claim, error: "boom", retryDelaySeconds: 10, nowSec: 101 }),
		).toBe(true);
		expect(readJob(db, "repo:/repo").retry_remaining).toBe(2);
		expect(
			tryClaimConsolidationJob(db, {
				jobKey: "repo:/repo",
				workerId: "worker-b",
				leaseSeconds: 10,
				nowSec: 105,
				inputWatermark: 8,
				retryLimit: 3,
			}).kind,
		).toBe("skipped_retry_backoff");
		const retried = tryClaimConsolidationJob(db, {
			jobKey: "repo:/repo",
			workerId: "worker-b",
			leaseSeconds: 10,
			nowSec: 111,
			inputWatermark: 9,
			retryLimit: 3,
		});
		expect(retried.kind).toBe("claimed");
		if (retried.kind !== "claimed") throw new Error("expected retry claim");
		expect(markConsolidationSucceeded(db, { claim: retried.claim, nowSec: 112 })).toBe(true);
		expect(readJob(db, "repo:/repo").last_success_watermark).toBe(retried.claim.inputWatermark);
		expect(
			tryClaimConsolidationJob(db, {
				jobKey: "repo:/repo",
				workerId: "worker-c",
				leaseSeconds: 10,
				nowSec: 113,
				inputWatermark: 9,
				retryLimit: 3,
			}).kind,
		).toBe("skipped_not_dirty");

		const lease = tryClaimConsolidationJob(db, {
			jobKey: "global",
			workerId: "worker-a",
			leaseSeconds: 5,
			nowSec: 200,
			inputWatermark: 2,
			retryLimit: 3,
		});
		expect(lease.kind).toBe("claimed");
		expect(
			tryClaimConsolidationJob(db, {
				jobKey: "global",
				workerId: "worker-b",
				leaseSeconds: 5,
				nowSec: 206,
				inputWatermark: 2,
				retryLimit: 3,
			}).kind,
		).toBe("claimed");
	});

	test("reopens an exhausted consolidation retry budget after a fresh input watermark", async () => {
		const db = await createDb();
		const first = tryClaimConsolidationJob(db, {
			jobKey: "repo:/repo",
			workerId: "worker-a",
			leaseSeconds: 10,
			nowSec: 100,
			inputWatermark: 8,
			retryLimit: 3,
		});
		if (first.kind !== "claimed") throw new Error("expected first claim");
		expect(
			markConsolidationFailed(db, { claim: first.claim, error: "first", retryDelaySeconds: 0, nowSec: 101 }),
		).toBe(true);

		const second = tryClaimConsolidationJob(db, {
			jobKey: "repo:/repo",
			workerId: "worker-b",
			leaseSeconds: 10,
			nowSec: 102,
			inputWatermark: 8,
			retryLimit: 3,
		});
		if (second.kind !== "claimed") throw new Error("expected second claim");
		expect(
			markConsolidationFailed(db, { claim: second.claim, error: "second", retryDelaySeconds: 0, nowSec: 103 }),
		).toBe(true);

		const third = tryClaimConsolidationJob(db, {
			jobKey: "repo:/repo",
			workerId: "worker-c",
			leaseSeconds: 10,
			nowSec: 104,
			inputWatermark: 8,
			retryLimit: 3,
		});
		if (third.kind !== "claimed") throw new Error("expected third claim");
		expect(
			markConsolidationFailed(db, { claim: third.claim, error: "third", retryDelaySeconds: 0, nowSec: 105 }),
		).toBe(true);
		expect(readJob(db, "repo:/repo").retry_remaining).toBe(0);

		store(db, { content: "Fresh retry input", repoKey: "/repo", nowSec: 200 });
		const freshWatermark = computeLearningWatermark(db, { scope: "repo", repoKey: "/repo", nowSec: 201 });
		expect(freshWatermark).toBeGreaterThan(8);
		expect(
			tryClaimConsolidationJob(db, {
				jobKey: "repo:/repo",
				workerId: "worker-d",
				leaseSeconds: 10,
				nowSec: 201,
				inputWatermark: freshWatermark,
				retryLimit: 3,
			}).kind,
		).toBe("claimed");
	});

	test("keeps a same-second post-claim write dirty after success", async () => {
		const db = await createDb();
		store(db, { content: "Before snapshot", repoKey: "/repo", nowSec: 300 });
		const watermark = computeLearningWatermark(db, { scope: "repo", repoKey: "/repo", nowSec: 300 });
		expect(watermark).toBe(299);
		const claimed = tryClaimConsolidationJob(db, {
			jobKey: "repo:/repo",
			workerId: "worker",
			leaseSeconds: 10,
			nowSec: 300,
			inputWatermark: watermark,
			retryLimit: 3,
		});
		if (claimed.kind !== "claimed") throw new Error("expected claim");
		store(db, { content: "Before snapshot", repoKey: "/repo", nowSec: 300 });
		store(db, { content: "Second same-second write", repoKey: "/repo", nowSec: 300 });
		expect(markConsolidationSucceeded(db, { claim: claimed.claim, nowSec: 301 })).toBe(true);
		const nextWatermark = computeLearningWatermark(db, { scope: "repo", repoKey: "/repo", nowSec: 301 });
		expect(nextWatermark).toBe(300);
		expect(
			tryClaimConsolidationJob(db, {
				jobKey: "repo:/repo",
				workerId: "next-worker",
				leaseSeconds: 10,
				nowSec: 301,
				inputWatermark: nextWatermark,
				retryLimit: 3,
			}).kind,
		).toBe("claimed");
	});
});
