import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as pluginCli from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import * as updateCli from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import {
	buildBunInstallArgs,
	getBinaryNameForTest,
	installScriptUrl,
	parseReportedVersion,
	parseUpdateArgs,
	pruneBunInstallCache,
	replaceBinaryForUpdate,
	resolveBunGlobalNodeModulesDirFromLocations,
	resolveUpdateMethodForTest,
	sweepStaleBackups,
	updateViaInstallScript,
} from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import Update from "@oh-my-pi/pi-coding-agent/commands/update";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("keeps normal update flags on the app updater path", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["--check", "--force"], TEST_CONFIG);
		await command.run();

		expect(updateSpy).toHaveBeenCalledWith({ force: true, check: true });
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});

describe("parseUpdateArgs", () => {
	it("preserves the legacy plugin update shorthand", () => {
		expect(parseUpdateArgs(["update", "-l"])).toEqual({ force: false, check: false, plugins: true });
	});
});

describe("update-cli install target detection", () => {
	it("uses bun update when prioritized omp is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});
});
describe("update-cli bun install command", () => {
	it("pins the official registry and natives packages in compatibility helper args", () => {
		const args = buildBunInstallArgs("15.9.0", "linux-x64");
		expect(args).toContain("--registry=https://registry.npmjs.org/");
		expect(args).toContain("@oh-my-pi/pi-coding-agent@15.9.0");
		expect(args).toContain("@oh-my-pi/pi-natives@15.9.0");
		expect(args).toContain("@oh-my-pi/pi-natives-linux-x64@15.9.0");
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

	it("derives global node_modules from supported bun global locations", () => {
		expect(resolveBunGlobalNodeModulesDirFromLocations(path.join("home", ".bun", "bin"), undefined)).toBe(
			path.join("home", ".bun", "install", "global", "node_modules"),
		);
		expect(
			resolveBunGlobalNodeModulesDirFromLocations(undefined, path.join("home", ".bun", "install", "cache")),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
	});
});

describe("update-cli bun cache pruning", () => {
	it("keeps only the newest cached version for filtered global install packages", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "react", "18.3.1@@@1"), "");
		await Bun.write(path.join(dir, "react", "19.2.6@@@1"), "");
		await Bun.write(
			path.join(dir, "react@18.3.1@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "18.3.1" }),
		);
		await Bun.write(
			path.join(dir, "react@19.2.6@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "19.2.6" }),
		);
		await Bun.write(path.join(dir, "@oh-my-pi", "pi-utils", "15.7.6@@@1"), "");
		await Bun.write(path.join(dir, "@oh-my-pi", "pi-utils", "15.8.0@@@1"), "");
		await Bun.write(
			path.join(dir, "@oh-my-pi", "pi-utils@15.7.6@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "15.7.6" }),
		);
		await Bun.write(
			path.join(dir, "@oh-my-pi", "pi-utils@15.8.0@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "15.8.0" }),
		);
		await Bun.write(path.join(dir, "chalk", "4.1.2@@@1"), "");
		await Bun.write(path.join(dir, "chalk", "5.6.2@@@1"), "");
		await Bun.write(
			path.join(dir, "chalk@4.1.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "4.1.2" }),
		);
		await Bun.write(
			path.join(dir, "chalk@5.6.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "5.6.2" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["react", "@oh-my-pi/pi-utils"]));

		expect(result).toEqual({ scannedPackages: 2, removedEntries: 4 });
		expect(await Bun.file(path.join(dir, "react", "18.3.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react@18.3.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react", "19.2.6@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "react@19.2.6@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils", "15.7.6@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils@15.7.6@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils", "15.8.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils@15.8.0@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk", "4.1.2@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk@4.1.2@@@1", "package.json")).exists()).toBe(true);
	});

	it("keeps current registry-qualified marker entries with their materialized package", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 0 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json")).exists()).toBe(true);
	});

	it("treats a stable release as newer than a matching prerelease", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0-beta.1@@@1"), "");
		await Bun.write(path.join(dir, "pkg", "1.0.0@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0-beta.1" }),
		);
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir);

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0-beta.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@@1", "package.json")).exists()).toBe(true);
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

describe("update-cli install script path", () => {
	it("pins the install script URL to the release tag on the fork repo", () => {
		expect(installScriptUrl("v1.2.0")).toBe("https://raw.githubusercontent.com/qtnx/omppp/v1.2.0/scripts/install.sh");
	});

	it("passes the install dir and pinned ref to the script, then keeps the verified result", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "ompx");
		await Bun.write(targetPath, "old binary");

		let seen: { args: string[]; installDir: string; script: string } | undefined;
		await updateViaInstallScript({
			targetPath,
			release: { tag: "v9.9.9", version: "9.9.9" },
			fetchScript: async url => `#!/bin/sh\n# from ${url}\n`,
			runScript: async (scriptPath, args, installDir) => {
				seen = { args, installDir, script: await Bun.file(scriptPath).text() };
				await Bun.write(targetPath, "new binary");
				return 0;
			},
			verifyInstalledVersion: async () => ({ ok: true, actual: "9.9.9", path: targetPath }),
		});

		expect(seen?.args).toEqual(["--binary", "--ref", "v9.9.9"]);
		expect(seen?.installDir).toBe(dir);
		expect(seen?.script).toContain(installScriptUrl("v9.9.9"));
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
	});

	it("restores the previous binary when the script fails", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "ompx");
		await Bun.write(targetPath, "old binary");

		await expect(
			updateViaInstallScript({
				targetPath,
				release: { tag: "v9.9.9", version: "9.9.9" },
				fetchScript: async () => "#!/bin/sh\n",
				runScript: async () => {
					await Bun.write(targetPath, "half-written binary");
					return 1;
				},
				verifyInstalledVersion: async () => {
					throw new Error("must not verify after a failed script");
				},
			}),
		).rejects.toThrow("restored previous ompx binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
	});

	it("restores the previous binary when the updated binary reports the wrong version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "ompx");
		await Bun.write(targetPath, "old binary");

		await expect(
			updateViaInstallScript({
				targetPath,
				release: { tag: "v9.9.9", version: "9.9.9" },
				fetchScript: async () => "#!/bin/sh\n",
				runScript: async () => {
					await Bun.write(targetPath, "wrong binary");
					return 0;
				},
				verifyInstalledVersion: async () => ({ ok: false, actual: "1.0.0", path: targetPath }),
			}),
		).rejects.toThrow("restored previous ompx binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "ompx.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale backup sweep", () => {
	it("reclaims timestamped and legacy backups while leaving unrelated .bak files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "ompx.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Must survive: foreign basename and a non-numeric middle segment.
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");

		await sweepStaleBackups(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
	});
});
