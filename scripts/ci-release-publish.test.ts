import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	inspectPackedTarball,
	isVersionAlreadyPublished,
	packages,
	prepareNativeCorePackage,
	rewriteManifest,
} from "./ci-release-publish.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("published manifest topology", () => {
	it("repoints omptype runtime entries to dist/js with a bun source condition", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/omptype");
		if (!pkg) throw new Error("omptype missing from publish set");
		expect(pkg.publishJs).toBe(true);

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./dist/js/index.js");
		expect(manifest.types).toBe("./dist/types/index.d.ts");
		expect(manifest.files).toContain("dist/js");
		expect(manifest.files).toContain("dist/types");
		// `src` must stay packed — the `bun` condition resolves into it.
		expect(manifest.files).toContain("src");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				bun: "./src/index.ts",
				default: "./dist/js/index.js",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
			"./*.js": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
		});
	});

	it("keeps source-runtime packages on src with only types repointed", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/utils");
		if (!pkg) throw new Error("utils missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./src/index.ts");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				import: "./src/*.ts",
			},
			"./*.js": "./src/*.ts",
		});
	});
});

describe("release publish", () => {
	it("uses the packed manifest identity for an exact-version registry preflight", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-release-publish-test-"));
		temporaryDirectories.push(root);
		const packageDir = path.join(root, "package");
		await fs.mkdir(packageDir);
		await Bun.write(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-test", version: "1.2.3" }),
		);
		const tarball = path.join(root, "test.tgz");
		await $`tar -czf ${tarball} -C ${root} package`.quiet();

		await expect(inspectPackedTarball(tarball)).resolves.toEqual({
			name: "@oh-my-pi/pi-test",
			version: "1.2.3",
			path: tarball,
		});
	});

	it("recognizes npm's existing-version machine codes and registry-precheck prose", () => {
		expect(isVersionAlreadyPublished("npm error code E409\nnpm error Cannot publish over existing version")).toBe(
			true,
		);
		expect(isVersionAlreadyPublished("npm ERR! code E409")).toBe(true);
		expect(isVersionAlreadyPublished("npm error code EPUBLISHCONFLICT")).toBe(true);
		expect(isVersionAlreadyPublished("You cannot publish over the previously published versions: 1.2.3.")).toBe(true);
		expect(isVersionAlreadyPublished("cannot publish over the previously published version")).toBe(false);
	});

	it("ships every file required by lazy native exports in the native core", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-core-publish-test-"));
		temporaryDirectories.push(root);
		await Bun.write(
			path.join(root, "package.json"),
			JSON.stringify({
				name: "@oh-my-pi/pi-natives",
				version: "1.2.3",
				exports: {
					"./desktop": { types: "./native/desktop.d.ts", import: "./native/desktop.js" },
					"./process": { types: "./native/process.d.ts", import: "./native/process.js" },
					"./live": { types: "./native/live.d.ts", import: "./native/live.js" },
				},
			}),
		);

		const manifest = await prepareNativeCorePackage(root, false);
		expect(manifest.files).toEqual(
			expect.arrayContaining([
				"native/desktop.js",
				"native/desktop.d.ts",
				"native/process.js",
				"native/process.d.ts",
				"native/live.js",
				"native/live.d.ts",
			]),
		);
	});
});
