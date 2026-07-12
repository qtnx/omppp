import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DEFAULT_FUZZY_THRESHOLD, executePatchSingle } from "@oh-my-pi/pi-coding-agent/edit";
import { writethroughNoop } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { withFileWriteLock, withFileWriteLocks } from "@oh-my-pi/pi-coding-agent/tools/file-write-lock";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { readArchiveEntries } from "@oh-my-pi/pi-coding-agent/utils/zip";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

describe("file write lock", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-write-lock-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("serializes concurrent read-modify-write operations for one file", async () => {
		const filePath = path.join(tmpDir, "shared.txt");
		await fs.writeFile(filePath, "");
		let active = 0;
		let maxActive = 0;

		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				withFileWriteLock(filePath, undefined, async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					try {
						const current = await fs.readFile(filePath, "utf8");
						await Promise.resolve();
						await fs.writeFile(filePath, `${current}${index}\n`);
					} finally {
						active--;
					}
				}),
			),
		);

		expect(maxActive).toBe(1);
		expect(
			(await fs.readFile(filePath, "utf8"))
				.trim()
				.split("\n")
				.map(Number)
				.sort((a, b) => a - b),
		).toEqual(Array.from({ length: 20 }, (_, index) => index));
	});

	it("allows different file keys to enter concurrently", async () => {
		const firstPath = path.join(tmpDir, "first.txt");
		const secondPath = path.join(tmpDir, "second.txt");
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let finished = 0;

		const first = withFileWriteLock(firstPath, undefined, async () => {
			firstStarted.resolve();
			await release.promise;
			finished++;
		});
		const second = withFileWriteLock(secondPath, undefined, async () => {
			secondStarted.resolve();
			await release.promise;
			finished++;
		});

		await Promise.all([firstStarted.promise, secondStarted.promise]);
		expect(finished).toBe(0);
		release.resolve();
		await Promise.all([first, second]);
		expect(finished).toBe(2);
	});

	it("holds a rename destination lock until the two-path mutation finishes", async () => {
		const sourcePath = path.join(tmpDir, "source.txt");
		const destinationPath = path.join(tmpDir, "destination.txt");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let destinationStarts = 0;

		const rename = withFileWriteLocks([sourcePath, destinationPath], undefined, async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const editDestination = withFileWriteLock(destinationPath, undefined, async () => {
			destinationStarts++;
		});

		await Promise.resolve();
		expect(destinationStarts).toBe(0);
		release.resolve();
		await Promise.all([rename, editDestination]);
		expect(destinationStarts).toBe(1);
	});

	it("removes an aborted queued waiter without blocking the next waiter", async () => {
		const filePath = path.join(tmpDir, "queued.txt");
		const releaseHolder = Promise.withResolvers<void>();
		const holderStarted = Promise.withResolvers<void>();
		const controller = new AbortController();
		const reason = new Error("queue cancelled");
		let abortedRan = false;
		let nextRan = false;

		const holder = withFileWriteLock(filePath, undefined, async () => {
			holderStarted.resolve();
			await releaseHolder.promise;
		});
		await holderStarted.promise;
		const aborted = withFileWriteLock(filePath, controller.signal, async () => {
			abortedRan = true;
		});
		const next = withFileWriteLock(filePath, undefined, async () => {
			nextRan = true;
		});
		controller.abort(reason);
		await expect(aborted).rejects.toBe(reason);
		expect(abortedRan).toBe(false);
		releaseHolder.resolve();
		await Promise.all([holder, next]);
		expect(nextRan).toBe(true);
	});

	it("serializes concurrent WriteTool executions from separate sessions", async () => {
		const filePath = path.join(tmpDir, "tool-race.txt");
		const firstContent = "first complete payload\n".repeat(512);
		const secondContent = "second complete payload\n".repeat(512);
		const firstTool = new WriteTool(createSession(tmpDir));
		const secondTool = new WriteTool(createSession(tmpDir));

		await Promise.all([
			firstTool.execute("first", { path: filePath, content: firstContent }),
			secondTool.execute("second", { path: filePath, content: secondContent }),
		]);

		expect(await fs.readFile(filePath, "utf8")).toSatisfy(
			content => content === firstContent || content === secondContent,
		);
	});

	it("retains both members from queued writes to a new archive", async () => {
		const archivePath = path.join(tmpDir, "bundle.zip");
		const first = new WriteTool(createSession(tmpDir)).execute("first", {
			path: `${archivePath}:first.txt`,
			content: "first member\n",
		});
		const second = new WriteTool(createSession(tmpDir)).execute("second", {
			path: `${archivePath}:second.txt`,
			content: "second member\n",
		});

		await Promise.all([first, second]);

		const entries = await readArchiveEntries(archivePath);
		const firstEntry = entries.get("first.txt");
		const secondEntry = entries.get("second.txt");
		expect(firstEntry).toBeInstanceOf(Uint8Array);
		expect(secondEntry).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(firstEntry as Uint8Array)).toBe("first member\n");
		expect(new TextDecoder().decode(secondEntry as Uint8Array)).toBe("second member\n");
	});

	it("serializes a rename against an edit of its destination", async () => {
		const sourcePath = path.join(tmpDir, "source.txt");
		const destinationPath = path.join(tmpDir, "destination.txt");
		await fs.writeFile(sourcePath, "source\n");

		const rename = executePatchSingle({
			session: createSession(tmpDir),
			path: sourcePath,
			params: { op: "update", rename: destinationPath, diff: "@@\n-source\n+moved" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: () => {
				throw new Error("deferred diagnostics unused with writethroughNoop");
			},
		});
		const editDestination = executePatchSingle({
			session: createSession(tmpDir),
			path: destinationPath,
			params: { op: "create", diff: "edited\n" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: () => {
				throw new Error("deferred diagnostics unused with writethroughNoop");
			},
		});

		const [renameResult, editResult] = await Promise.allSettled([rename, editDestination]);

		expect(renameResult.status === "fulfilled" || editResult.status === "fulfilled").toBe(true);
		expect(renameResult.status === "fulfilled" || renameResult.reason instanceof Error).toBe(true);
		expect(editResult.status === "fulfilled" || editResult.reason instanceof Error).toBe(true);
		expect(await fs.readFile(destinationPath, "utf8")).toSatisfy(
			content => content === "moved\n" || content === "edited\n",
		);
	});
});
