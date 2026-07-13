import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetCrashReportStateForTests,
	ensureCrashSeenMarker,
	getCrashReportsDir,
	listUnreadCrashArtifacts,
	markCrashArtifactsSeen,
	reportSoftCrash,
	writeCrashReportSync,
} from "@oh-my-pi/pi-utils/crash-report";
import { __resetDirsFromEnvForTests } from "@oh-my-pi/pi-utils/dirs";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

async function readCrashRecord(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse((await fs.readFile(filePath, "utf8")).trim()) as Record<string, unknown>;
}

describe("crash reports", () => {
	let tempRoot = "";
	let originalXdgStateHome: string | undefined;

	beforeEach(async () => {
		originalXdgStateHome = process.env.XDG_STATE_HOME;
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-crash-report-"));
		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, "omp"), { recursive: true });
		__resetDirsFromEnvForTests();
		__resetCrashReportStateForTests();
	});

	afterEach(async () => {
		restoreEnv("XDG_STATE_HOME", originalXdgStateHome);
		__resetCrashReportStateForTests();
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("writes one complete JSON crash record under the logs directory", async () => {
		const error = new TypeError("bad crash input");
		const writtenPath = writeCrashReportSync({
			kind: "uncaught_exception",
			label: "Uncaught Exception",
			error,
		});

		expect(writtenPath).not.toBeNull();
		expect(path.dirname(writtenPath!)).toBe(getCrashReportsDir());
		expect(path.basename(writtenPath!)).toMatch(/^crash-uncaught_exception-\d+-\d+\.jsonl$/);
		const record = await readCrashRecord(writtenPath!);
		expect(record).toMatchObject({
			kind: "uncaught_exception",
			label: "Uncaught Exception",
			name: "TypeError",
			message: "bad crash input",
			stack: expect.any(String),
			tsMs: expect.any(Number),
			version: expect.any(String),
			pid: process.pid,
			cwd: process.cwd(),
			count: 1,
		});
	});

	it("deduplicates repeated soft crashes by redacted label and message", async () => {
		const first = reportSoftCrash({ label: "tool-renderer", error: new Error("renderer exploded") });
		const second = reportSoftCrash({ label: "tool-renderer", error: new Error("renderer exploded") });

		expect(first).toEqual({ path: first.path, deduped: false });
		expect(first.path).not.toBeNull();
		expect(second).toEqual({ path: first.path, deduped: true });
		const entries = await fs.readdir(getCrashReportsDir());
		expect(entries.filter(entry => entry.startsWith("crash-soft-") && entry.endsWith(".jsonl"))).toHaveLength(1);
	});

	it("hides historical reports on the first seen-marker creation", async () => {
		const logsDir = getCrashReportsDir();
		await fs.mkdir(logsDir, { recursive: true });
		const oldMs = Date.now() - 60_000;
		await fs.writeFile(path.join(logsDir, `native-panic-${process.pid}-${oldMs}.log`), "historical native crash");
		await fs.writeFile(
			path.join(logsDir, `crash-soft-${process.pid}-${oldMs}.jsonl`),
			`${JSON.stringify({ tsMs: oldMs, kind: "soft", label: "old", message: "old" })}\n`,
		);

		const marker = ensureCrashSeenMarker();
		expect(marker.seenUntilMs).toBeGreaterThan(oldMs);
		expect(listUnreadCrashArtifacts()).toEqual([]);
	});

	it("lists reports written after the marker and clears them after marking seen", () => {
		const marker = ensureCrashSeenMarker();
		const writtenPath = writeCrashReportSync({ kind: "soft", label: "new crash", error: new Error("new report") });

		expect(writtenPath).not.toBeNull();
		const unread = listUnreadCrashArtifacts();
		expect(unread).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: writtenPath, source: "js", kind: "soft", tsMs: expect.any(Number) }),
			]),
		);
		markCrashArtifactsSeen(marker.seenUntilMs);
		expect(listUnreadCrashArtifacts()).toEqual([]);
	});

	it("redacts sk tokens before persisting messages", async () => {
		const writtenPath = writeCrashReportSync({
			kind: "soft",
			label: "redaction",
			error: new Error("provider rejected sk-abc123SECRETtoken"),
		});

		expect(writtenPath).not.toBeNull();
		const record = await readCrashRecord(writtenPath!);
		expect(record.message).not.toContain("sk-abc123SECRETtoken");
		expect(record.message).toContain("[REDACTED]");
	});

	it("never throws when the logs directory cannot be created", async () => {
		const logsDir = getCrashReportsDir();
		// Block the logs path with a regular file so mkdirSync(dir) fails inside the
		// isolated temp fixture instead of falling back outside it.
		await fs.writeFile(logsDir, "not-a-directory");
		const writtenPath = writeCrashReportSync({
			kind: "soft",
			label: "unwritable",
			error: new Error("cannot persist"),
		});
		expect(writtenPath).toBeNull();
	});
});
