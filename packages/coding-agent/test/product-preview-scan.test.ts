import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scanBundle } from "../src/product-preview/scan";

let root: string;

async function writeFixtureFile(relPath: string, content: string): Promise<void> {
	await Bun.write(path.join(root, relPath), content);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-preview-scan-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("scanBundle", () => {
	it("classifies product folders and extra paths", async () => {
		await Promise.all([
			writeFixtureFile("briefs/brief.md", "# Brief"),
			writeFixtureFile("specs/spec.md", "# Spec"),
			writeFixtureFile("design/flow-ui.md", "# Design"),
			writeFixtureFile("architecture/system.md", "# Architecture"),
			writeFixtureFile("superpowers/plans/rollout.md", "# Plan"),
			writeFixtureFile("mockups/demo.html", "<title>Mockup</title>"),
			writeFixtureFile("notes/general.md", "# General"),
			writeFixtureFile("extras/reference.txt", "Reference"),
		]);

		const manifest = await scanBundle({ root, extraPaths: ["extras/reference.txt"] });

		expect(Object.fromEntries(manifest.items.map(item => [item.relPath, item.kind]))).toEqual({
			"architecture/system.md": "architecture",
			"briefs/brief.md": "brief",
			"design/flow-ui.md": "design",
			"extras/reference.txt": "doc",
			"mockups/demo.html": "mockup",
			"notes/general.md": "doc",
			"specs/spec.md": "spec",
			"superpowers/plans/rollout.md": "plan",
		});
	});

	it("discovers only exact canvas suffixes with stable ids while skipping hidden directories", async () => {
		await Promise.all([
			writeFixtureFile("canvases/story.canvas.json", '{"version":1}'),
			writeFixtureFile("canvases/ignored.json", '{"version":1}'),
			writeFixtureFile("canvases/not-a-canvas.canvas.json.bak", '{"version":1}'),
			writeFixtureFile(".ompx-preview/hidden.canvas.json", '{"version":1}'),
		]);

		const first = await scanBundle({ root });
		const second = await scanBundle({ root });

		expect(first.items).toEqual([
			expect.objectContaining({
				kind: "canvas",
				relPath: "canvases/story.canvas.json",
				title: "story.canvas.json",
			}),
		]);
		expect(second.items).toEqual(first.items);
		expect(first.capabilities).toEqual({ feedback: false });
	});

	it("extracts markdown and HTML titles with a filename fallback", async () => {
		await Promise.all([
			writeFixtureFile("docs/heading.md", "intro\n# Product vision #\n## Details"),
			writeFixtureFile("mockups/screen.html", "<html><head><title>Screen title</title></head></html>"),
			writeFixtureFile("docs/untitled.md", "No heading here"),
		]);

		const manifest = await scanBundle({ root });
		const titles = Object.fromEntries(manifest.items.map(item => [item.relPath, item.title]));

		expect(titles).toEqual({
			"docs/heading.md": "Product vision",
			"docs/untitled.md": "untitled.md",
			"mockups/screen.html": "Screen title",
		});
	});

	it("rejects unsafe extra paths rather than exposing them in the manifest", async () => {
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-preview-outside-"));
		try {
			await Promise.all([
				writeFixtureFile("docs/safe.md", "# Safe"),
				Bun.write(path.join(outsideRoot, "outside.md"), "# Outside"),
			]);

			const manifest = await scanBundle({
				root,
				extraPaths: ["../outside.md", path.join(outsideRoot, "outside.md")],
			});

			expect(manifest.items.map(item => item.relPath)).toEqual(["docs/safe.md"]);
			expect(
				manifest.items.every(
					item => !path.posix.isAbsolute(item.relPath) && !item.relPath.split("/").includes(".."),
				),
			).toBe(true);
		} finally {
			await fs.rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it("rejects symlinked extra paths while retaining regular markdown, HTML, canvas, and extra files", async () => {
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-preview-symlink-outside-"));
		try {
			await Promise.all([
				writeFixtureFile("docs/safe.md", "# Safe"),
				writeFixtureFile("mockups/safe.html", "<title>Safe mockup</title>"),
				writeFixtureFile("flows/safe.canvas.json", '{"version":1}'),
				writeFixtureFile("extras/reference.txt", "Safe reference"),
				Bun.write(path.join(outsideRoot, "secret.canvas.json"), '{"secret":"must not leak"}'),
			]);
			await fs.symlink(
				path.join(outsideRoot, "secret.canvas.json"),
				path.join(root, "extras", "secret.canvas.json"),
			);

			const manifest = await scanBundle({
				root,
				extraPaths: ["extras/reference.txt", "extras/secret.canvas.json"],
			});

			expect(manifest.items.map(item => item.relPath)).toEqual([
				"flows/safe.canvas.json",
				"docs/safe.md",
				"extras/reference.txt",
				"mockups/safe.html",
			]);
			expect(manifest.items.find(item => item.relPath === "extras/secret.canvas.json")).toBeUndefined();
		} finally {
			await fs.rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it("records stat metadata for scanned files", async () => {
		const content = "# Sized artifact\n";
		await writeFixtureFile("docs/sized.md", content);

		const manifest = await scanBundle({ root });
		const item = manifest.items[0];

		expect(item).toMatchObject({ relPath: "docs/sized.md", size: new TextEncoder().encode(content).byteLength });
		expect(item?.mtimeMs).toBeGreaterThan(0);
	});

	it("creates stable ids and ordering across repeated scans", async () => {
		await Promise.all([
			writeFixtureFile("notes/zeta.md", "# Zeta"),
			writeFixtureFile("notes/alpha.md", "# Alpha"),
			writeFixtureFile("specs/roadmap.md", "# Roadmap"),
			writeFixtureFile("architecture/c4.md", "# C4"),
		]);

		const first = await scanBundle({ root, title: "Stable bundle" });
		const second = await scanBundle({ root, title: "Stable bundle" });

		expect(second.items).toEqual(first.items);
		expect(first.bundle.title).toBe("Stable bundle");
		expect(first.items.map(item => `${item.kind}:${item.relPath}`)).toEqual([
			"architecture:architecture/c4.md",
			"doc:notes/alpha.md",
			"doc:notes/zeta.md",
			"spec:specs/roadmap.md",
		]);
		expect(first.items.every(item => item.id.length === 12)).toBe(true);
	});
});
