import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import type { WorkflowRunRecord } from "../../workflow/run-registry";
import { WorkflowRunRegistry } from "../../workflow/run-registry";
import { getThemeByName, setThemeInstance } from "../theme/theme";
import { WorkflowHudComponent } from "./workflow-hud";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

function render(registry: { list(): WorkflowRunRecord[] }, width = 120): string {
	return new WorkflowHudComponent({ registry })
		.render(width)
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
		expect(output).toContain("running");
		expect(output).toContain("in 20 / out 30");
	});

	it("renders no rows after a terminal workflow frame", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest({ kind: "phase", runId: "run-1", index: 0, title: "Run" });
		registry.ingest({ kind: "done", runId: "run-1", ok: true });

		expect(render(registry)).toEqual("");
	});
	it("renders a failed terminal workflow header as failed instead of running", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest({
			kind: "agent",
			runId: "terminal",
			index: 0,
			label: "Failed worker",
			agentId: "terminal-failed-agent",
			state: "error",
			error: "quota exceeded",
		});
		registry.ingest({ kind: "done", runId: "terminal", ok: false });

		const header = render(registry)
			.split("\n")
			.find(line => line.includes("terminal"));

		expect(header).toContain("✘");
		expect(header).not.toContain("⟳");
	});
	it("stops a failed workflow duration at its completion time", () => {
		const now = Date.now();
		const registry: { list(): WorkflowRunRecord[] } = {
			list: () => [
				{
					runId: "terminal-duration",
					status: "failed",
					startedAt: now - 5_000,
					endedAt: now - 2_000,
					phases: [],
					logs: [],
					agents: [],
					lastFrameAt: now - 2_000,
				},
			],
		};

		const header = render(registry)
			.split("\n")
			.find(line => line.includes("terminal-dur"));

		expect(header).toContain("3.0s");
	});

	it("hides a completed workflow despite a historical failed agent", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest({
			kind: "agent",
			runId: "run-recovered-error",
			index: 0,
			label: "Recovered worker",
			agentId: "agent-recovered-error",
			state: "error",
			error: "transient failure",
		});
		registry.ingest({ kind: "done", runId: "run-recovered-error", ok: true });

		expect(render(registry)).toEqual("");
	});

	it("renders failed emitted agents with their sanitized error message inside the terminal width", () => {
		const label = "Wide\t界".repeat(20);
		const registry = new WorkflowRunRegistry();
		registry.ingest({
			kind: "agent",
			runId: "run-error",
			index: 0,
			label,
			agentId: "agent-error",
			state: "error",
			error: "quota\texceeded",
		});
		registry.ingest({ kind: "done", runId: "run-error", ok: false });

		const output = render(registry, 80);

		expect(output).toContain("Wide   界");
		expect(output).not.toContain("Wide   界".repeat(20));

		expect(output).toContain("✘ failed");
		expect(output).toContain("Error: quota   exceeded");
		expect(output).not.toContain("\t");
		for (const line of output.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(79);
	});

	it("removes terminal control bytes from failed agent errors while retaining the failure text", () => {
		const registry = new WorkflowRunRegistry();
		registry.ingest({
			kind: "agent",
			runId: "run-escape-error",
			index: 0,
			label: "Worker",
			agentId: "agent-escape-error",
			state: "error",
			error: "\x1b[2Jquota exceeded\u0007",
		});

		const output = render(registry);

		expect(output).toContain("quota exceeded");
		expect(output).not.toContain("\x1b");
		expect(output).not.toContain("\u0007");
	});
});
