import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { discoverWorkflows, getWorkflowSource } from "../../src/workflow/discovery";

describe("discoverWorkflows", () => {
	it("includes bundled workflows", async () => {
		const names = (await discoverWorkflows(process.cwd())).map(w => w.name);
		expect(names).toContain("bugfix");
		expect(names).toContain("investigate");
	});
	it("discovers project-level .omp/workflows/*.js and gives it precedence", async () => {
		await using dir = await TempDir.create("wf-disc");
		await fs.mkdir(path.join(dir.path(), ".omp", "workflows"), { recursive: true });
		await Bun.write(
			path.join(dir.path(), ".omp", "workflows", "bugfix.js"),
			"export const meta={name:'bugfix',description:'custom'};",
		);
		const bugfix = (await discoverWorkflows(dir.path(), dir.path())).find(w => w.name === "bugfix");
		expect(bugfix?.source).toBe("project");
	});
	it("getWorkflowSource returns source for a bundled name", async () => {
		const r = await getWorkflowSource(process.cwd(), "bugfix");
		expect(r.source).toContain('name: "bugfix"');
	});
	it("getWorkflowSource errors for an unknown name", async () => {
		expect((await getWorkflowSource(process.cwd(), "nope")).error).toContain("Unknown workflow");
	});
});
