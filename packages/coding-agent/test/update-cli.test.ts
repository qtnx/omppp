import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBinaryNameForTest, parseReportedVersion, replaceBinaryForUpdate } from "../src/cli/update-cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("update-cli release binary names", () => {
	it("matches the release assets published by CI", () => {
		expect(getBinaryNameForTest("linux", "x64")).toBe("ompx-linux-x64");
		expect(getBinaryNameForTest("linux", "arm64")).toBe("ompx-linux-arm64");
		expect(getBinaryNameForTest("darwin", "x64")).toBe("ompx-darwin-x64");
		expect(getBinaryNameForTest("darwin", "arm64")).toBe("ompx-darwin-arm64");
		expect(getBinaryNameForTest("win32", "x64")).toBe("ompx-windows-x64.exe");
		expect(() => getBinaryNameForTest("win32", "arm64")).toThrow("Unsupported Windows architecture");
	});
});

describe("parseReportedVersion", () => {
	// Regression: `ompx --version` prints the bare semver (main.ts writes `${VERSION}\n`).
	// The previous parser required an "ompx/" slash and never matched the real
	// output, so every downloaded update failed verification and got rolled back.
	it("parses the bare `X.Y.Z` that `ompx --version` emits", () => {
		expect(parseReportedVersion("15.10.5\n")).toBe("15.10.5");
	});

	it("tolerates optional `ompx/` or `v` prefixes", () => {
		expect(parseReportedVersion("ompx/15.10.5")).toBe("15.10.5");
		expect(parseReportedVersion("v15.10.5\n")).toBe("15.10.5");
	});

	it("returns undefined when the binary printed no version", () => {
		expect(parseReportedVersion("command not found")).toBeUndefined();
		expect(parseReportedVersion("")).toBeUndefined();
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "ompx");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous ompx binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "ompx");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});
