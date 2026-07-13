#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const clientDir = path.join(import.meta.dir, "..", "src", "product-preview", "client");
const entrypoint = path.join(clientDir, "canvas-app.tsx");
const generatedDir = path.join(clientDir, "generated");
const outputNames = ["canvas-app.js", "canvas-app.css"] as const;
const checkOnly = process.argv.includes("--check");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-canvas-bundle-"));
try {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		outdir: tempDir,
		target: "browser",
		format: "iife",
		splitting: false,
		minify: false,
		sourcemap: "none",
		naming: "canvas-app.[ext]",
		define: { "import.meta.env": '"production"' },
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}

	for (const name of outputNames) {
		const generated = Bun.file(path.join(tempDir, name));
		if (!(await generated.exists())) throw new Error(`Canvas bundle did not emit ${name}`);
		const destination = path.join(generatedDir, name);
		if (checkOnly) {
			const committed = Bun.file(destination);
			if (
				!(await committed.exists()) ||
				Bun.hash(await committed.arrayBuffer()) !== Bun.hash(await generated.arrayBuffer())
			) {
				throw new Error(`Canvas bundle drifted: run bun scripts/bundle-canvas.ts`);
			}
		} else {
			await Bun.write(destination, generated);
		}
	}
	console.log(checkOnly ? "Canvas bundle is current" : "Generated canvas bundle");
} finally {
	await fs.rm(tempDir, { recursive: true, force: true });
}
