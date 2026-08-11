import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type Component, Text } from "@oh-my-pi/pi-tui";

interface RenderableBlock {
	render(width: number): string[];
}

interface UsagePanelBlock extends RenderableBlock {
	setNativeScrollbackCommittedRows(rows: number): void;
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
}

function isUsagePanelBlock(value: unknown): value is UsagePanelBlock {
	return (
		isRenderableBlock(value) &&
		"setNativeScrollbackCommittedRows" in value &&
		typeof value.setNativeScrollbackCommittedRows === "function"
	);
}

function renderPresentedBlocks(value: unknown): string {
	const blocks = Array.isArray(value) ? value : [value];
	return blocks
		.filter(isRenderableBlock)
		.flatMap(block => block.render(120))
		.join("\n");
}

function createUsageSessionDouble() {
	return { getUsageReportingModelSelectors: () => [] };
}

function createUsageReport(): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: 1_700_000_000_000,
		limits: [],
		metadata: { email: "user@example.com" },
	};
}

describe("CommandController /usage", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders bars and free percentage for limits that only report remainingFraction", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders saved reset expiry lines for future and expired credits", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("clears live usage refresh eligibility when another command panel renders", async () => {
		const present = vi.fn();
		const ctx = {
			session: {
				...createUsageSessionDouble(),
				getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
			},
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [],
				metadata: { email: "user@example.com" },
			},
		];

		await controller.handleUsageCommand(reports);
		expect(controller.isUsagePanelActive()).toBe(true);

		await controller.handleJobsCommand();

		expect(controller.isUsagePanelActive()).toBe(false);
	});

	it("clears live usage refresh eligibility when memory and learning commands run", async () => {
		const ctx = {
			session: createUsageSessionDouble(),
			sessionManager: { getCwd: () => "/tmp/project" },
			settings: {
				get: () => "off",
				getAgentDir: () => "/tmp/agent",
			},
			ui: { terminal: { columns: 100 } },
			present: vi.fn(),
			presentCommandOutput: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [],
				metadata: { email: "user@example.com" },
			},
		];
		const memoryController = new CommandController(ctx);
		await memoryController.handleUsageCommand(reports);
		expect(memoryController.isUsagePanelActive()).toBe(true);

		await memoryController.handleMemoryCommand("/memory unknown");
		expect(memoryController.isUsagePanelActive()).toBe(false);

		const learningController = new CommandController(ctx);
		await learningController.handleUsageCommand(reports);
		expect(learningController.isUsagePanelActive()).toBe(true);

		await learningController.handleLearningCommand("/learning unknown");
		expect(learningController.isUsagePanelActive()).toBe(false);
	});

	it("deactivates only after every rendered /usage row enters native scrollback", async () => {
		const presented: unknown[] = [];
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present: vi.fn((component: unknown) => presented.push(component)),
			presentCommandOutput: vi.fn((component: unknown) => presented.push(component)),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleUsageCommand([createUsageReport()]);
		const panel = presented[0];
		if (!isUsagePanelBlock(panel)) throw new Error("Expected a scroll-aware usage panel");
		const rows = panel.render(120);
		expect(rows.length).toBeGreaterThan(0);

		panel.setNativeScrollbackCommittedRows(rows.length);
		expect(controller.isUsagePanelActive()).toBe(true);
		const narrowRows = panel.render(20);
		expect(narrowRows.length).toBeGreaterThan(rows.length);
		await Promise.resolve();
		expect(controller.isUsagePanelActive()).toBe(false);

		await controller.handleUsageCommand([createUsageReport()]);
		expect(controller.isUsagePanelActive()).toBe(true);
		panel.setNativeScrollbackCommittedRows(narrowRows.length);
		await Promise.resolve();
		expect(controller.isUsagePanelActive()).toBe(true);
	});

	it("keeps partial usage rows live across repeats and resize, then dismisses to the exact committed prefix", async () => {
		const presented: unknown[] = [];
		const removeChild = vi.fn();
		const requestRender = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 }, requestRender },
			chatContainer: {
				isBlockUncommitted: vi.fn(() => false),
				removeChild,
			},
			present: vi.fn((component: unknown) => presented.push(component)),
			presentCommandOutput: vi.fn((component: unknown) => presented.push(component)),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleUsageCommand([createUsageReport()]);
		const panel = presented[0];
		if (!isUsagePanelBlock(panel)) throw new Error("Expected a scroll-aware usage panel");
		const initialRows = panel.render(20);
		const committedRows = Math.max(1, initialRows.length - 1);

		panel.setNativeScrollbackCommittedRows(committedRows);
		const resizedRows = panel.render(120);
		expect(committedRows).toBeGreaterThanOrEqual(resizedRows.length);
		panel.setNativeScrollbackCommittedRows(committedRows);
		await Promise.resolve();
		expect(controller.isUsagePanelActive()).toBe(true);

		expect(controller.dismissUsagePanel()).toBe(true);
		expect(removeChild).not.toHaveBeenCalled();
		const dismissedRows = panel.render(40);
		expect(dismissedRows).toEqual(initialRows.slice(0, committedRows));
		expect(dismissedRows).not.toEqual(resizedRows);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(controller.dismissUsagePanel()).toBe(false);
	});

	it("retracts only the uncommitted usage suffix inside a real transcript", async () => {
		const transcript = new TranscriptContainer();
		const before = new Text("before history", 0, 0);
		const after = new Text("after history", 0, 0);
		let usagePanel: Component | undefined;
		transcript.addChild(before);
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 }, requestRender: vi.fn() },
			chatContainer: transcript,
			present: vi.fn((component: Component) => {
				usagePanel = component;
				transcript.addChild(component);
			}),
			presentCommandOutput: vi.fn((component: Component) => {
				usagePanel = component;
				transcript.addChild(component);
			}),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleUsageCommand([createUsageReport()]);
		if (!usagePanel) throw new Error("Expected /usage to mount a transcript component");
		transcript.addChild(after);
		const beforeDismiss = [...transcript.render(120)];
		const beforeAfterIndex = beforeDismiss.findIndex(line => line.trimEnd() === "after history");
		expect(beforeAfterIndex).toBeGreaterThan(3);
		const committedRows = beforeAfterIndex - 2;
		const committedPrefix = beforeDismiss.slice(0, committedRows);

		transcript.setNativeScrollbackCommittedRows(committedRows);
		expect(transcript.isBlockUncommitted(usagePanel)).toBe(false);
		expect(transcript.isBlockUncommitted(after)).toBe(true);
		expect(controller.dismissUsagePanel()).toBe(true);
		const afterDismiss = transcript.render(120);
		const afterAfterIndex = afterDismiss.findIndex(line => line.trimEnd() === "after history");

		expect(afterDismiss.slice(0, committedRows)).toEqual(committedPrefix);
		expect(afterAfterIndex).toBeGreaterThanOrEqual(committedRows);
		expect(afterAfterIndex).toBeLessThan(beforeAfterIndex);
		expect(afterDismiss.slice(afterAfterIndex)).toEqual(beforeDismiss.slice(beforeAfterIndex));
	});
});
