import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SaveLearningTool } from "@oh-my-pi/pi-coding-agent/advisor/save-learning-tool";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as learningStorage from "@oh-my-pi/pi-coding-agent/learnings/storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

const tempDirs = new Set<string>();

async function createFixture(enabled = true): Promise<{ agentDir: string; cwd: string; session: ToolSession }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-save-learning-"));
	tempDirs.add(dir);
	const agentDir = path.join(dir, "agent");
	const cwd = path.join(dir, "repo");
	await Promise.all([fs.mkdir(agentDir), fs.mkdir(cwd)]);
	const settings = await Settings.loadReadOnly({ agentDir, cwd, overrides: { "learning.enabled": enabled } });
	const session = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => "save-learning-test-session",
		getSessionSpawns: () => "*",
	} as ToolSession;
	return { agentDir, cwd, session };
}

function activeRows(agentDir: string): Array<{ content: string; trigger: string; scope: string; strength: number }> {
	const db = learningStorage.openLearningDb(getAgentDbPath(agentDir));
	try {
		return db
			.prepare("SELECT content, trigger, scope, strength FROM live_learnings WHERE status = 'active'")
			.all() as Array<{ content: string; trigger: string; scope: string; strength: number }>;
	} finally {
		learningStorage.closeLearningDb(db);
	}
}

afterEach(async () => {
	for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
	tempDirs.clear();
});

describe("SaveLearningTool", () => {
	test("stores a generic rule under the advisor trigger and reinforces an identical repeat", async () => {
		const fixture = await createFixture();
		const tool = SaveLearningTool.createIf(fixture.session);
		if (!tool) throw new Error("tool should be created when learning is enabled");
		const content =
			"Before using an API, config key, or flag you have not read in this checkout, read its definition; an unverified name is a guess.";

		const first = await tool.execute("1", { content, scope: "global", failure_class: "Hallucinated API" });
		expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Learning recorded") });

		const rows = activeRows(fixture.agentDir);
		expect(rows).toEqual([{ content, trigger: "advisor:hallucinated-api", scope: "global", strength: 1 }]);

		await tool.execute("2", { content: `  ${content}  `, scope: "global", failure_class: "x" });
		const after = activeRows(fixture.agentDir);
		expect(after).toHaveLength(1);
		expect(after[0].strength).toBeGreaterThan(1);
	});

	test("rejects content too short to be a rule and stores nothing", async () => {
		const fixture = await createFixture();
		const tool = SaveLearningTool.createIf(fixture.session);
		if (!tool) throw new Error("tool missing");

		await expect(
			tool.execute("1", { content: "be careful", scope: "repo", failure_class: "vague" }),
		).rejects.toBeInstanceOf(ToolError);
		expect(activeRows(fixture.agentDir)).toHaveLength(0);
	});

	test("is not created when learning is disabled", async () => {
		const fixture = await createFixture(false);
		expect(SaveLearningTool.createIf(fixture.session)).toBeNull();
	});
});
