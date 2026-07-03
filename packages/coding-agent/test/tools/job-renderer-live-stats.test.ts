import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import { jobToolRenderer, setJobLiveStatsProvider } from "@oh-my-pi/pi-coding-agent/tools/job";

function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "LiveTask",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Render live stats",
		recentTools: [],
		recentOutput: [],
		toolCount: 2,
		requests: 1,
		tokens: 15_552,
		inputTokens: 12_345,
		outputTokens: 3_210,
		cost: 0,
		durationMs: 20_000,
		...overrides,
	};
}

function renderJob(job: {
	id: string;
	type: "bash" | "task" | "workflow";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
}): string {
	const component = jobToolRenderer.renderResult(
		{
			content: [{ type: "text" as const, text: "" }],
			details: { jobs: [job] },
		},
		{ expanded: true, isPartial: true, spinnerFrame: 0 } as Parameters<typeof jobToolRenderer.renderResult>[1],
		theme,
		{ poll: [] },
	);
	return Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
}

describe("job renderer live stats", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		setJobLiveStatsProvider(undefined);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	// A running task row should expose live token IO/rate, not just duration.
	it("renders live token counts and output rate for running task jobs", () => {
		setJobLiveStatsProvider(jobId => (jobId === "LiveTask" ? progress() : undefined));

		const output = renderJob({
			id: "LiveTask",
			type: "task",
			status: "running",
			label: "LiveTask",
			durationMs: 1_000,
		});
		// Locks the compact one-decimal path so 12_345 tokens stays readable as 12.3k.

		expect(output).toContain("↑12.3k ↓3.2k 161 tok/s");
		expect(output).toContain("20.0s");
	});

	// Without a provider, task rows must stay byte-compatible with the old UI.
	it("keeps the previous task row format when no provider is registered", () => {
		const output = renderJob({
			id: "PlainTask",
			type: "task",
			status: "running",
			label: "PlainTask",
			durationMs: 1_000,
		});

		expect(output).toContain("PlainTask");
		expect(output).toContain("1.0s");
		expect(output).not.toContain("tok/s");
		expect(output).not.toContain("↑");
		expect(output).not.toContain("↓");
	});

	// Even matching progress is ignored for non-task jobs to preserve old rows.
	it("keeps non-task rows byte-identical even when the provider has matching data", () => {
		const job = {
			id: "ShellJob",
			type: "bash" as const,
			status: "running" as const,
			label: "npm test",
			durationMs: 1_000,
		};
		const baseline = renderJob(job);

		setJobLiveStatsProvider(jobId => (jobId === "ShellJob" ? progress({ id: "ShellJob" }) : undefined));
		const withProvider = renderJob(job);

		expect(withProvider).toBe(baseline);
		expect(withProvider).not.toContain("tok/s");
	});
});
