import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../config/settings";
import { WorkflowRunRegistry } from "../../workflow/run-registry";
import { getThemeByName, setThemeInstance } from "../theme/theme";
import { WorkflowHudComponent } from "./workflow-hud";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

function render(registry: WorkflowRunRegistry): string {
	return new WorkflowHudComponent({ registry })
		.render(120)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("WorkflowHudComponent", () => {
	it("renders active run and non-terminal agent rows", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest({ kind: "phase", runId: "workflow-abcdefghijkl", index: 0, title: "Build\tHUD" });
		registry.ingest({
			kind: "agent",
			runId: "workflow-abcdefghijkl",
			index: 0,
			label: "Render\tworker",
			agentId: "agent-1",
			state: "start",
			model: "test-model",
			progress: { inputTokens: 12, outputTokens: 3, toolCount: 0, durationMs: 1000 } as never,
		});

		const output = render(registry);

		expect(output).toContain("Workflows");
		expect(output).toContain("workflow-abc");
		expect(output).toContain("Build");
		expect(output).toContain("Render");
		expect(output).not.toContain("\t");
		expect(output).toContain("test-model");
		expect(output).toContain("in 12 / out 3");
	});

	it("reflects updated agent state and token counts", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest({
			kind: "agent",
			runId: "run-1",
			index: 0,
			label: "Worker",
			agentId: "agent-1",
			state: "start",
			progress: { inputTokens: 1, outputTokens: 2, toolCount: 0, durationMs: 100 } as never,
		});
		registry.ingest({
			kind: "agent",
			runId: "run-1",
			index: 0,
			label: "Worker",
			agentId: "agent-1",
			state: "start",
			progress: { inputTokens: 20, outputTokens: 30, toolCount: 1, durationMs: 2000 } as never,
		});

		const output = render(registry);

		expect(output).toContain("Worker");
		expect(output).toContain("start");
		expect(output).toContain("in 20 / out 30");
	});

	it("renders no rows after a terminal workflow frame", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest({ kind: "phase", runId: "run-1", index: 0, title: "Run" });
		registry.ingest({ kind: "done", runId: "run-1", ok: true });

		expect(render(registry)).toEqual("");
	});
});
