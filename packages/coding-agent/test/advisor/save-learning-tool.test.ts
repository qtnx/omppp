import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SaveLearningTool } from "@oh-my-pi/pi-coding-agent/advisor/save-learning-tool";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as learningStorage from "@oh-my-pi/pi-coding-agent/learnings/storage";
import { TurnSignalService, TypeSafeClient } from "@oh-my-pi/pi-coding-agent/signals/index";
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

/** Classifier whose learning verdict is fixed; `undefined` verdicts come from an explicit API failure. */
function learningService(genericRule: number | "unavailable"): TurnSignalService {
	const client = new TypeSafeClient({
		apiKey: "k",
		fetch: (async (_url: string | URL | Request, _init?: RequestInit) => {
			if (genericRule === "unavailable") return new Response("boom", { status: 500 });
			return Response.json({
				model: "jev",
				answers: { generic_rule: { type: "noul", noul: genericRule } },
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		}) as typeof fetch,
	});
	return new TurnSignalService(client);
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

	test("rejects a case-specific entry judged below the generic-rule threshold and stores nothing", async () => {
		const fixture = await createFixture();
		const tool = SaveLearningTool.createIf(fixture.session, learningService(0.2));
		if (!tool) throw new Error("tool missing");
		const content =
			"Reverting the paginate change in src/list.ts broke the last-page case; re-apply it exactly as written there.";

		await expect(tool.execute("1", { content, scope: "repo", failure_class: "case-specific" })).rejects.toThrow(
			/reads as case-specific/,
		);
		expect(activeRows(fixture.agentDir)).toHaveLength(0);
	});

	test("stores an entry judged as a generic rule", async () => {
		const fixture = await createFixture();
		const tool = SaveLearningTool.createIf(fixture.session, learningService(0.9));
		if (!tool) throw new Error("tool missing");
		const content =
			"When a fix touches a shared helper, migrate every caller in the same change instead of adding a second path.";

		await tool.execute("1", { content, scope: "global", failure_class: "partial-cutover" });

		expect(activeRows(fixture.agentDir)).toHaveLength(1);
	});

	test("stores the entry when the classifier is unavailable", async () => {
		const fixture = await createFixture();
		const tool = SaveLearningTool.createIf(fixture.session, learningService("unavailable"));
		if (!tool) throw new Error("tool missing");
		const content = "Before claiming a fix works, run the reported path once and quote its output in the report.";

		await tool.execute("1", { content, scope: "global", failure_class: "done-without-evidence" });

		expect(activeRows(fixture.agentDir)).toHaveLength(1);
	});
});
