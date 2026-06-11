import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { getBundledAgent } from "../src/task/agents";
import type { AgentDefinition, SingleResult } from "../src/task/types";
import { resolveWorkflowAgentModelOverride } from "../src/workflow";
import { WorkflowRun } from "../src/workflow/engine";
import { createWorkflowGlobals } from "../src/workflow/runtime";
import { runWorkflowScript } from "../src/workflow/sandbox";

const STRUCTURED_SCHEMA = {
	type: "object",
	properties: {
		failures: { type: "array", items: { type: "string" } },
	},
	required: ["failures"],
};

function result(output: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Agent",
		agent: "workflow-subagent",
		agentSource: "bundled",
		task: "task",
		assignment: "task",
		description: "agent",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function makeRun(runSubprocess: (opts: { task: string; modelOverride?: string | string[] }) => Promise<SingleResult>) {
	return new WorkflowRun({
		runId: "run",
		cwd: "/tmp/workflow",
		concurrency: 4,
		budgetTotal: null,
		signal: new AbortController().signal,
		allocateId: async label => `0-${label}`,
		emit: () => {},
		resolveAgent: () =>
			({
				name: "workflow-subagent",
				description: "Workflow subagent",
				source: "bundled",
				systemPrompt: "Run workflow task.",
			}) as AgentDefinition,
		runSubprocess,
	});
}

describe("workflow agent regressions", () => {
	it("returns parsed structured data when schema is supplied", async () => {
		const run = makeRun(async () => result('{"failures":[]}'));

		const gate = await run.spawn("review", { schema: STRUCTURED_SCHEMA });

		expect(gate).toEqual({ failures: [] });
	});

	it("treats subagent schema violations as failed agent calls", async () => {
		const run = makeRun(async () =>
			result('{"error":"schema_violation","missingRequired":["failures"]}', {
				exitCode: 1,
				stderr: "schema_violation: missing required fields: failures",
			}),
		);
		const globals = createWorkflowGlobals(run, undefined);

		await expect(run.spawn("review", { schema: STRUCTURED_SCHEMA })).rejects.toThrow(
			"schema_violation: missing required fields: failures",
		);
		await expect(globals.parallel([() => globals.agent("review", { schema: STRUCTURED_SCHEMA })])).resolves.toEqual([
			null,
		]);
	});

	it("resolves returned agent promises before serializing the workflow result", async () => {
		const run = makeRun(async opts => {
			await Bun.sleep(1);
			return result(`done:${opts.task}`);
		});
		const globals = createWorkflowGlobals(run, undefined);

		const value = await runWorkflowScript(
			`export const meta = { name: "promise-return", description: "d" };
const review = agent("review");
return { review };`,
			globals as unknown as Record<string, unknown>,
			undefined,
		);

		expect(value).toEqual({ review: "done:review" });
	});

	it("waits for spawned agents that were not awaited by the script", async () => {
		let completed = false;
		const run = makeRun(async () => {
			await Bun.sleep(1);
			completed = true;
			return result("done");
		});

		void run.spawn("background", {});
		await run.waitForIdle();

		expect(completed).toBe(true);
	});

	it("resolves default workflow subagents through the task role instead of the parent active model", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "anthropic/claude-sonnet-4-0",
				task: "openai-codex/gpt-5.5:medium",
			},
		});
		const agent = getBundledAgent("workflow-subagent");
		expect(agent?.model).toEqual(["pi/task"]);

		const modelOverride = resolveWorkflowAgentModelOverride({
			settings,
			agent: agent!,
			explicitModel: undefined,
			parentActiveModelPattern: "anthropic/claude-sonnet-4-0",
			fallbackModelPattern: "anthropic/claude-sonnet-4-0",
		});

		expect(modelOverride).toEqual(["openai-codex/gpt-5.5:medium"]);
	});

	it("lets workflow opts.model override agent and settings models", () => {
		const settings = Settings.isolated({
			modelRoles: {
				task: "openai-codex/gpt-5.5:medium",
			},
		});
		const agent = getBundledAgent("workflow-subagent");

		const modelOverride = resolveWorkflowAgentModelOverride({
			settings,
			agent: agent!,
			explicitModel: "cursor/composer-2.5-fast",
			parentActiveModelPattern: "anthropic/claude-sonnet-4-0",
			fallbackModelPattern: "anthropic/claude-sonnet-4-0",
		});

		expect(modelOverride).toEqual(["cursor/composer-2.5-fast"]);
	});
});
