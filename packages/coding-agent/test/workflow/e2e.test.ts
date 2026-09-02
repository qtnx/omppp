import { afterEach, describe, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import type { ExecutorOptions } from "../../src/task/executor";
import * as taskExecutor from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { WorkflowTool } from "../../src/workflow";
import { WorkflowRun, workflowConcurrency } from "../../src/workflow/engine";
import { createWorkflowGlobals } from "../../src/workflow/runtime";
import { runWorkflowScript } from "../../src/workflow/sandbox";
import type { WorkflowProgressFrame } from "../../src/workflow/types";

describe("workflow end-to-end (stubbed subprocess)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	it("forwards compact parent context separately from repository context", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-context-");
		let capturedOptions: ExecutorOptions | undefined;

		AsyncJobManager.resetForTests();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			capturedOptions = options;
			return {
				index: options.index,
				id: options.id,
				exitCode: 0,
				output: "inspected",
				stderr: "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
			} as SingleResult;
		});

		const tool = await WorkflowTool.create({
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({ "workflow.enabled": true }),
			getArtifactsDir: () => tempDir.path(),
			getCompactContext: () => "compact parent context",
			contextFiles: [{ path: "/tmp/AGENTS.md", content: "repo-specific rule" }],
		} as ToolSession);
		const result = await tool.execute("workflow-context", {
			script: `
export const meta = { name: "inspect", description: "Inspect parent context" };
return await agent("inspect");
`,
		});

		const content = result.content[0];
		expect(content?.type).toBe("text");
		if (content?.type !== "text") throw new Error("Workflow result did not contain text");
		expect(content.text).toContain('Workflow "inspect"');

		const options = capturedOptions;
		expect(options).toBeDefined();
		if (!options?.parentContextFile) throw new Error("Workflow did not start a subprocess");
		expect(await Bun.file(options.parentContextFile).text()).toBe("compact parent context");
		expect(options.contextFiles).toContainEqual({
			path: "/tmp/AGENTS.md",
			content: "repo-specific rule",
		});
		expect(options.contextFiles).not.toContainEqual(expect.objectContaining({ path: options.parentContextFile }));
	});

	it("drives phases, pipeline, parallel, and returns a synthesis", async () => {
		const frames: WorkflowProgressFrame[] = [];
		let n = 0;
		const run = new WorkflowRun({
			runId: "e2e",
			cwd: process.cwd(),
			concurrency: workflowConcurrency(),
			budgetTotal: null,
			signal: new AbortController().signal,
			allocateId: async l => `${n++}-${l}`,
			emit: f => frames.push(f),
			resolveAgent: () => ({ name: "workflow-subagent" }) as AgentDefinition,
			runSubprocess: async o =>
				({
					index: o.index,
					id: o.id,
					exitCode: 0,
					output: `R(${o.task})`,
					stderr: "",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					usage: { output: 5 },
				}) as SingleResult,
		});
		const globals = createWorkflowGlobals(run, { topics: ["a", "b"] });

		const script = `
export const meta = { name: "demo", description: "demo", phases: ["scan", "synthesize"] };
phase("scan");
const scanned = await pipeline(args.topics, t => agent("scan:" + t), r => agent("verify:" + r));
phase("synthesize");
const merged = await parallel(scanned.map(s => () => agent("merge:" + s)));
return merged.filter(Boolean).join(" | ");
`;
		const result = await runWorkflowScript(script, globals as unknown as Record<string, unknown>, {
			topics: ["a", "b"],
		});
		expect(result).toBe("R(merge:R(verify:R(scan:a))) | R(merge:R(verify:R(scan:b)))");
		expect(frames.filter(f => f.kind === "phase").map(f => (f as { title: string }).title)).toEqual([
			"scan",
			"synthesize",
		]);
		// 2 scan + 2 verify + 2 merge = 6 completed spawns
		expect(frames.filter(f => f.kind === "agent" && f.state === "done").length).toBe(6);
	});
});
