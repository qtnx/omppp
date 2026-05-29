import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { computeCacheKey, WorkflowJournal } from "../../src/workflow/journal";

describe("computeCacheKey", () => {
	it("is stable for identical (prompt, opts, prevKey)", () => {
		expect(computeCacheKey("p", { model: "m" }, "prev")).toBe(computeCacheKey("p", { model: "m" }, "prev"));
	});
	it("changes when the prompt changes", () => {
		expect(computeCacheKey("a", {}, "k")).not.toBe(computeCacheKey("b", {}, "k"));
	});
	it("chains: same call with a different prevKey yields a different key", () => {
		expect(computeCacheKey("p", {}, "k1")).not.toBe(computeCacheKey("p", {}, "k2"));
	});
});

describe("WorkflowJournal", () => {
	it("replays a cached result and skips re-running, until a key diverges", async () => {
		await using dir = await TempDir.create("wf-journal");
		const file = path.join(dir.path(), "run.jsonl");
		const writer = await WorkflowJournal.open(file);
		const k1 = computeCacheKey("scan:a", {}, "");
		await writer.recordResult(k1, "0-scan", "R1");
		const k2 = computeCacheKey("verify:R1", {}, k1);
		await writer.recordResult(k2, "1-verify", "R2");
		await writer.close();

		const reader = await WorkflowJournal.openForResume(file);
		expect(reader.lookup(k1)?.result).toBe("R1");
		const k2changed = computeCacheKey("verify:DIFFERENT", {}, k1);
		expect(reader.lookup(k2changed)).toBeUndefined();
		await reader.close();
	});
});
