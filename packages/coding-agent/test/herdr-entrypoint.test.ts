import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inspectHerdrEntrypoint, installHerdrEntrypoint, uninstallHerdrEntrypoint } from "../src/herdr/entrypoint";

describe("herdr omp entrypoint", () => {
	let dir: string | undefined;

	afterEach(async () => {
		if (dir) await fs.rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	/** A directory holding a fake `ompx` binary plus an isolated fake $HOME. */
	async function fixture(): Promise<{ dir: string; target: string; homeDir: string }> {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-entrypoint-"));
		const target = path.join(dir, "ompx");
		await Bun.write(target, "#!/bin/sh\nexit 0\n");
		const homeDir = path.join(dir, "home");
		await fs.mkdir(homeDir);
		return { dir, target, homeDir };
	}

	test("links, reports linked, and removes only its own link", async () => {
		const { dir: root, target, homeDir } = await fixture();

		const installed = await installHerdrEntrypoint({ dir: root, target, homeDir });
		expect(installed.state).toBe("linked");
		expect(await fs.realpath(path.join(root, "omp"))).toBe(await fs.realpath(target));

		// Installing again is a no-op rather than an EEXIST failure.
		expect((await installHerdrEntrypoint({ dir: root, target, homeDir })).state).toBe("linked");

		const removed = await uninstallHerdrEntrypoint({ dir: root, target, homeDir });
		expect(removed.removed).toBe(true);
		expect((await inspectHerdrEntrypoint({ dir: root, target, homeDir })).state).toBe("missing");
	});

	test("treats a dangling link as a conflict that only --force repoints", async () => {
		const { dir: root, target, homeDir } = await fixture();
		// The shape left behind when a reinstall moves ompx to another directory:
		// `omp` still exists as a link, but resolves to nothing.
		await fs.symlink(path.join(root, "moved-away", "ompx"), path.join(root, "omp"));

		const status = await inspectHerdrEntrypoint({ dir: root, target, homeDir });
		expect(status.state).toBe("conflict");

		await expect(installHerdrEntrypoint({ dir: root, target, homeDir })).rejects.toThrow(/--force/);

		const forced = await installHerdrEntrypoint({ dir: root, target, homeDir, force: true });
		expect(forced.state).toBe("linked");
		expect(await fs.realpath(path.join(root, "omp"))).toBe(await fs.realpath(target));
	});

	test("refuses to clobber an unrelated omp and never removes it", async () => {
		const { dir: root, target, homeDir } = await fixture();
		const upstream = path.join(root, "omp");
		await Bun.write(upstream, "#!/bin/sh\necho upstream\n");

		expect((await inspectHerdrEntrypoint({ dir: root, target, homeDir })).state).toBe("conflict");
		await expect(installHerdrEntrypoint({ dir: root, target, homeDir })).rejects.toThrow(/--force/);

		const removed = await uninstallHerdrEntrypoint({ dir: root, target, homeDir });
		expect(removed.removed).toBe(false);
		expect(await Bun.file(upstream).text()).toContain("upstream");
	});

	test("reports a shell alias that would shadow the link", async () => {
		const { dir: root, target, homeDir } = await fixture();
		await Bun.write(path.join(homeDir, ".zshrc"), "alias k=kubectl\nalias omp=ompx\n");

		const status = await inspectHerdrEntrypoint({ dir: root, target, homeDir });
		expect(status.shadowedBy).toEqual([path.join(homeDir, ".zshrc")]);
	});
});
