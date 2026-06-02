import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { CommandController } from "../../../src/modes/controllers/command-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";

type DumpFileHandler = (target: "file") => Promise<void>;

function createController(transcript: string) {
	const showStatus = vi.fn();
	const showError = vi.fn();
	const ctx = {
		session: {
			formatSessionAsText: () => transcript,
		},
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;

	return { controller: new CommandController(ctx), showStatus, showError };
}

describe("/dump file command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes the session transcript to a private temporary text file", async () => {
		const { controller, showStatus, showError } = createController("user: hello\nassistant: hi");
		let filePath: string | undefined;
		let dirPath: string | undefined;
		try {
			await (controller.handleDumpCommand as DumpFileHandler)("file");
			const status = showStatus.mock.calls[0]?.[0];

			expect(typeof status).toBe("string");
			if (typeof status !== "string") throw new Error("Missing dump file status.");
			expect(status).toStartWith("Session transcript written to:\n");
			filePath = status.slice("Session transcript written to:\n".length);
			dirPath = filePath.slice(0, filePath.lastIndexOf("/"));
			expect(filePath.endsWith(".txt")).toBe(true);
			expect(await Bun.file(filePath).text()).toBe("user: hello\nassistant: hi\n");
			expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
			expect((await fs.stat(dirPath)).mode & 0o777).toBe(0o700);
			expect(showError).not.toHaveBeenCalled();
		} finally {
			if (dirPath) await fs.rm(dirPath, { recursive: true, force: true });
		}
	});
});
