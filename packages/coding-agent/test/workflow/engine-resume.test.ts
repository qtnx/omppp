import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { WorkflowRun } from "../../src/workflow/engine";
import { computeCacheKey, WorkflowJournal } from "../../src/workflow/journal";

describe("WorkflowRun with journal", () => {
	it("returns cached results without calling runSubprocess and emits 'cached'", async () => {
		await using dir = await TempDir.create("wf-resume");
		const file = path.join(dir.path(), "run.jsonl");
		const writer = await WorkflowJournal.open(file);
		const k1 = computeCacheKey("one", {}, "");
		await writer.recordResult(k1, "0-one", "CACHED");
		await writer.close();

		const journal = await WorkflowJournal.openForResume(file);
		let calls = 0;
		const states: string[] = [];
		const run = new WorkflowRun({
			runId: "r",
			cwd: process.cwd(),
			concurrency: 2,
			budgetTotal: null,
			signal: new AbortController().signal,
			allocateId: async l => `0-${l}`,
			emit: f => {
				if (f.kind === "agent") states.push(f.state);
			},
			resolveAgent: () => ({ name: "workflow-subagent" }) as AgentDefinition,
			runSubprocess: async o => {
				calls++;
				return { index: o.index, id: o.id, output: "LIVE" } as SingleResult;
			},
			journal,
		});
		expect(await run.spawn("one", {})).toBe("CACHED");
		expect(calls).toBe(0);
		expect(states).toContain("cached");
		expect(await run.spawn("two", {})).toBe("LIVE");
		expect(calls).toBe(1);
		await journal.close();
	});
});
