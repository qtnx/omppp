import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pruneAnnotationScreenshots } from "../annotation-screenshots";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("pruneAnnotationScreenshots", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "annot-prune-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function writeShot(name: string, ageMs: number, now: number): Promise<void> {
		const file = path.join(dir, name);
		await Bun.write(file, "x");
		const when = new Date(now - ageMs);
		await fs.utimes(file, when, when);
	}

	it("drops shots older than a week and keeps recent ones", async () => {
		const now = Date.now();
		await writeShot("old.webp", 8 * DAY_MS, now);
		await writeShot("recent.webp", DAY_MS, now);

		await pruneAnnotationScreenshots(dir, now);

		expect((await fs.readdir(dir)).sort()).toEqual(["recent.webp"]);
	});

	it("keeps only the newest 200 shots", async () => {
		const now = Date.now();
		for (let index = 0; index < 202; index++) {
			// shot-0 is the newest; shot-200 and shot-201 are the two oldest.
			await writeShot(`shot-${index}.webp`, index * 1000, now);
		}

		await pruneAnnotationScreenshots(dir, now);

		const remaining = await fs.readdir(dir);
		expect(remaining).toHaveLength(200);
		expect(remaining).not.toContain("shot-200.webp");
		expect(remaining).not.toContain("shot-201.webp");
		expect(remaining).toContain("shot-0.webp");
	});

	it("is a no-op when the directory does not exist yet", async () => {
		await pruneAnnotationScreenshots(path.join(dir, "missing"), Date.now());
		expect(await fs.readdir(dir)).toEqual([]);
	});
});
