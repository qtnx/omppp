import { describe, expect, it } from "bun:test";
import { createWorkflowGlobals } from "../../src/workflow/runtime";

function fakeGlobals(spawn: (p: string, o: unknown) => Promise<string | null>, args: unknown = {}) {
	const run = {
		spawn,
		nextPhase: () => {},
		log: () => {},
		budget: { total: null as number | null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
	};
	return createWorkflowGlobals(run as never, args, { runWorkflow: async () => "nested" });
}

describe("parallel", () => {
	it("is a barrier and maps thrown thunks to null", async () => {
		const g = fakeGlobals(async p => (p === "boom" ? Promise.reject(new Error("x")) : `ok:${p}`));
		expect(await g.parallel([() => g.agent("a"), () => g.agent("boom"), () => g.agent("b")])).toEqual([
			"ok:a",
			null,
			"ok:b",
		]);
	});
	it("rejects non-array input", async () => {
		await expect(fakeGlobals(async p => p).parallel("nope" as never)).rejects.toThrow(/array of functions/);
	});
});

describe("pipeline", () => {
	it("runs items through all stages, no barrier, passing (prev,item,index)", async () => {
		const seen: Array<[unknown, unknown, number]> = [];
		const g = fakeGlobals(async p => p);
		const out = await g.pipeline(
			["x", "y"],
			(item: unknown) => g.agent(`s1:${item}`),
			(prev: unknown, item: unknown, i: number) => {
				seen.push([prev, item, i]);
				return g.agent(`s2:${prev}`);
			},
		);
		expect(out).toEqual(["s2:s1:x", "s2:s1:y"]);
		expect(seen).toEqual([
			["s1:x", "x", 0],
			["s1:y", "y", 1],
		]);
	});
	it("drops a throwing item to null and skips remaining stages", async () => {
		const g = fakeGlobals(async p => (p.includes("y") ? Promise.reject(new Error("boom")) : p));
		const out = await g.pipeline(
			["x", "y"],
			(i: unknown) => g.agent(`s1:${i}`),
			(prev: unknown) => g.agent(`s2:${prev}`),
		);
		expect(out[0]).toBe("s2:s1:x");
		expect(out[1]).toBeNull();
	});
	it("rejects non-array items", async () => {
		await expect(fakeGlobals(async p => p).pipeline("nope" as never)).rejects.toThrow(/array as the first argument/);
	});
});

describe("workflow()", () => {
	it("delegates to injected runWorkflow", async () => {
		expect(await fakeGlobals(async p => p).workflow("bugfix", { a: 1 })).toBe("nested");
	});
});
