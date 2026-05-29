import { describe, expect, it } from "bun:test";
import { runWorkflowScript, validateSyntax } from "../../src/workflow/sandbox";

describe("validateSyntax", () => {
	it("accepts valid script with top-level await and export meta", () => {
		expect(validateSyntax(`export const meta = { name: "x", description: "d" };\nawait agent("hi");`).ok).toBe(true);
	});
	it("rejects a syntax error", () => {
		const r = validateSyntax(`export const meta = { name: "x" `);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("SyntaxError");
	});
});

describe("runWorkflowScript", () => {
	it("runs the body, exposes globals, returns the top-level return value", async () => {
		const calls: string[] = [];
		const result = await runWorkflowScript(
			`export const meta = { name: "x", description: "d" };\nconst a = await agent("one");\nlog(a);\nreturn a + "!";`,
			{ agent: async (p: string) => `ran:${p}`, log: (m: string) => calls.push(m) },
			{},
		);
		expect(result).toBe("ran:one!");
		expect(calls).toEqual(["ran:one"]);
	});
	it("blocks Date.now()", async () => {
		await expect(
			runWorkflowScript(`export const meta = { name: "x", description: "d" };\nreturn Date.now();`, {}, {}),
		).rejects.toThrow(/Date\.now\(\) is unavailable/);
	});
	it("blocks new Date() with no args but allows new Date(ts)", async () => {
		await expect(
			runWorkflowScript(`export const meta = { name: "x", description: "d" };\nreturn new Date();`, {}, {}),
		).rejects.toThrow(/new Date\(\) is unavailable/);
		expect(
			await runWorkflowScript(
				`export const meta = { name: "x", description: "d" };\nreturn new Date(0).getUTCFullYear();`,
				{},
				{},
			),
		).toBe(1970);
	});
	it("blocks Math.random()", async () => {
		await expect(
			runWorkflowScript(`export const meta = { name: "x", description: "d" };\nreturn Math.random();`, {}, {}),
		).rejects.toThrow(/Math\.random\(\) is unavailable/);
	});
	it("exposes args as a global", async () => {
		expect(
			await runWorkflowScript(
				`export const meta = { name: "x", description: "d" };\nreturn args.n * 2;`,
				{},
				{ n: 21 },
			),
		).toBe(42);
	});
});
