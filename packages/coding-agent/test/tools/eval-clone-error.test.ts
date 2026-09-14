import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

/**
 * Tool-call args cross the worker boundary by structured clone, and functions
 * are not cloneable. The clone failure must reject the awaiting cell — the
 * Worker `postMessage` contract — not shut down the subprocess kernel and
 * erase the eval session's accumulated state.
 */
describe("EvalTool non-serializable tool args", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	it("renders cyclic display values without poisoning JSON results or kernel state", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("display-cycle", {
			language: "js",
			code: "globalThis.__displayCycle = { name: 'deck-layer' }; __displayCycle.self = __displayCycle; display(__displayCycle);",
		});
		const serialized = JSON.stringify(result);
		expect(JSON.parse(serialized).isError).not.toBe(true);
		expect(textOf(result)).toContain("deck-layer");
		expect(textOf(result)).toContain("Circular");
		const next = await tool.execute("display-cycle-after", {
			language: "js",
			code: "display({ intact: __displayCycle.self === __displayCycle, count: 9007199254740993n });",
		});
		expect(JSON.parse(JSON.stringify(next)).details.jsonOutputs).toEqual([
			{ intact: true, count: "9007199254740993" },
		]);
	});

	it("fails the tool call inside the cell and keeps kernel state alive", async () => {
		const tool = new EvalTool(makeSession());

		const seed = await tool.execute("call-clone-seed", {
			language: "js",
			code: "globalThis.__cloneProbe = 41; console.log('seeded');",
		});
		expect(textOf(seed)).toContain("seeded");

		const bad = await tool.execute("call-clone-bad", {
			language: "js",
			code: [
				"try {",
				'\tawait __omp_call_tool__("read", { path: () => "x" });',
				'\tconsole.log("no-throw");',
				"} catch (error) {",
				'\tconsole.log("caught " + error.name);',
				"}",
			].join("\n"),
		});
		const badText = textOf(bad);
		expect(badText).toContain("caught DataCloneError");
		expect(badText).not.toContain("JS eval worker exited");

		const after = await tool.execute("call-clone-after", {
			language: "js",
			code: "console.log('probe=' + (globalThis.__cloneProbe + 1));",
		});
		expect(textOf(after)).toContain("probe=42");
	});
});
