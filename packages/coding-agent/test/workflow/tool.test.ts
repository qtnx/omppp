import { beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { WorkflowTool } from "../../src/workflow";

function session(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "workflow.enabled": true }),
		...overrides,
	} as ToolSession;
}

beforeEach(() => {
	// No background manager → the tool resolves/validates but does not launch a real job.
	AsyncJobManager.resetForTests();
});

describe("WorkflowTool input validation", () => {
	it("rejects when no source is provided", async () => {
		const tool = await WorkflowTool.create(session());
		const res = await tool.execute("id", {});
		expect(res.content[0]?.type).toBe("text");
		expect((res.content[0] as { text: string }).text).toContain("Provide one of");
	});
	it("rejects a script with a syntax error", async () => {
		const tool = await WorkflowTool.create(session());
		const res = await tool.execute("id", { script: "export const meta = { name: 'x' " });
		expect((res.content[0] as { text: string }).text).toContain("SyntaxError");
	});
	it("rejects a script with a non-literal meta", async () => {
		const tool = await WorkflowTool.create(session());
		const res = await tool.execute("id", { script: "export const meta = { name: makeName(), description: 'd' };\n" });
		expect((res.content[0] as { text: string }).text).toContain("PURE LITERAL");
	});
	it("rejects a script missing meta entirely", async () => {
		const tool = await WorkflowTool.create(session());
		const res = await tool.execute("id", { script: "await agent('hi');\n" });
		expect((res.content[0] as { text: string }).text).toContain("must begin with");
	});
});

describe("WorkflowTool named-workflow resolution", () => {
	it("resolves a bundled workflow name and extracts its meta", async () => {
		const tool = await WorkflowTool.create(session());
		// Abort up front so agent() short-circuits to null — assert name resolution, spawn no real subagents.
		const ac = new AbortController();
		ac.abort();
		const res = await tool.execute("id", { name: "investigate", args: { question: "why?" } }, ac.signal);
		expect(res.details?.meta?.name).toBe("investigate");
	});
	it("errors for an unknown workflow name", async () => {
		const tool = await WorkflowTool.create(session());
		const res = await tool.execute("id", { name: "does-not-exist" });
		expect((res.content[0] as { text: string }).text).toContain("Unknown workflow");
	});
});
