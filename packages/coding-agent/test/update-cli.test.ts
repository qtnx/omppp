import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildBunInstallArgs,
	getBinaryNameForTest,
	replaceBinaryForUpdate,
	resolveUpdateMethodForTest,
} from "../src/cli/update-cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
describe("update-cli install target detection", () => {
	it("uses bun update when prioritized ompx is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/ompx", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses bun update when prioritized ompx is a symlink to bun global bin", async () => {
		const dir = await makeTempDir();
		const bunBin = path.join(dir, "bun-bin");
		const pathBin = path.join(dir, "path-bin");
		await fs.mkdir(bunBin, { recursive: true });
		await fs.mkdir(pathBin, { recursive: true });
		const bunManagedBinary = path.join(bunBin, "ompx");
		const symlinkedBinary = path.join(pathBin, "ompx");
		await Bun.write(bunManagedBinary, "bun-managed binary");
		await fs.symlink(bunManagedBinary, symlinkedBinary);

		const method = resolveUpdateMethodForTest(symlinkedBinary, bunBin);

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized ompx is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/ompx", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/ompx", undefined);

		expect(method).toBe("binary");
	});
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

describe("update-cli bun install command", () => {
	it("pins the official npm registry and bypasses the manifest cache so a stale mirror or snapshot cannot block a tag-matched package install", () => {
		// Regression: OMPx selects the update version from the GitHub release tag,
		// then bun-managed installs resolve the matching npm package. The install
		// MUST hit the official registry directly, otherwise:
		//   - a lagging mirror (corp proxy, Taobao, …) rejects the version with
		//     `No version matching "X" (but package exists)`,
		//   - or bun's local manifest snapshot does the same when the user's bun
		//     is already pointed at the official registry but its cache predates
		//     the release.
		// See https://github.com/can1357/oh-my-pi/issues/1686.
		const args = buildBunInstallArgs("15.7.6", "linux-x64");
		expect(args.slice(0, 5)).toEqual([
			"install",
			"-g",
			"--no-cache",
			"--registry=https://registry.npmjs.org/",
			"@oh-my-pi/pi-coding-agent@15.7.6",
		]);
	});

	it("pins the native addon core and the platform-specific leaf to the same version so the loader sentinel cannot drift on supported tags", () => {
		// Regression: bun install -g <pkg>@<v> would update only the top-level
		// package, leaving @oh-my-pi/pi-natives and @oh-my-pi/pi-natives-<tag>
		// at their previous version. The next launch then loaded a stale .node
		// file and aborted at validateLoadedBindings with `The .node file on
		// disk is from a different release than this loader`. See
		// https://github.com/can1357/oh-my-pi/issues/1824.
		for (const tag of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
			const args = buildBunInstallArgs("15.9.0", tag);
			expect(args).toContain("@oh-my-pi/pi-natives@15.9.0");
			expect(args).toContain(`@oh-my-pi/pi-natives-${tag}@15.9.0`);
		}
	});

	it("omits the leaf on unsupported platform tags so an EBADPLATFORM swap does not mask the underlying `no matching version` error", () => {
		// Defensive: an unsupported tag (e.g. linux-arm32) still installs the
		// core natives package — which will fail at module load if the platform
		// truly is unsupported — but we never request a leaf the release
		// pipeline doesn't publish, otherwise bun aborts with EBADPLATFORM
		// and hides the real diagnostic from `loadNative`'s aggregated error.
		const args = buildBunInstallArgs("15.9.0", "linux-arm");
		expect(args).toContain("@oh-my-pi/pi-natives@15.9.0");
		expect(args.some(arg => arg.startsWith("@oh-my-pi/pi-natives-"))).toBe(false);
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
