import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as crashReports from "@oh-my-pi/pi-utils";

function createRuntimeHarness() {
	const clearCrashReportBanner = vi.fn();
	const clearPinnedError = vi.fn();
	const setText = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		clearCrashReportBanner,
		clearPinnedError,
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		showStatus,
	} as unknown as InteractiveModeContext;

	return {
		clearCrashReportBanner,
		clearPinnedError,
		setText,
		showStatus,
		runtime: { ctx },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/crash slash command", () => {
	it("renders the newest unread report with sanitized text and a home-shortened path", async () => {
		const newestPath = `${os.homedir()}/.omp/crash reports/latest report.log`;
		vi.spyOn(crashReports, "listUnreadCrashArtifacts").mockReturnValue([
			{
				path: newestPath,
				source: "js",
				tsMs: 2,
				kind: "soft",
				summary: "Newest \x1b[31mcrash",
			},
			{
				path: "/tmp/older.log",
				source: "js",
				tsMs: 1,
				kind: "soft",
				summary: "Older crash",
			},
		]);
		const markSeen = vi.spyOn(crashReports, "markCrashArtifactsSeen");
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/crash", harness.runtime)).toBe(true);

		expect(harness.showStatus).toHaveBeenCalledWith(
			"Newest crash\nCrash report: ~/.omp/crash reports/latest report.log\nUse /crash dismiss to dismiss unread reports.",
		);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(markSeen).not.toHaveBeenCalled();
	});

	it("dismisses an owned crash banner without clearing an unrelated pinned error", async () => {
		vi.spyOn(crashReports, "listUnreadCrashArtifacts").mockReturnValue([
			{
				path: "/tmp/latest.log",
				source: "native",
				tsMs: 1,
				kind: "fatal",
				summary: "Latest crash",
			},
		]);
		const markSeen = vi.spyOn(crashReports, "markCrashArtifactsSeen");
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/crash dismiss", harness.runtime)).toBe(true);

		expect(markSeen).toHaveBeenCalledTimes(1);
		expect(harness.clearCrashReportBanner).toHaveBeenCalledTimes(1);
		expect(harness.clearPinnedError).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showStatus).toHaveBeenCalledWith("Unread crash reports dismissed.");
	});

	it("shows the exact usage message for invalid arguments without marking reports seen", async () => {
		const markSeen = vi.spyOn(crashReports, "markCrashArtifactsSeen");
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/crash later", harness.runtime)).toBe(true);

		expect(harness.showStatus).toHaveBeenCalledWith("Usage: /crash [dismiss]");
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(markSeen).not.toHaveBeenCalled();
	});
});
