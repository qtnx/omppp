/**
 * Builds the annotate extension:
 * - `dist/` — unpacked extension (load via chrome://extensions)
 * - `../coding-agent/src/tools/browser/annotate-extension-assets/*.txt` —
 *   generated text assets embedded into the ompx CLI so `ompx annotate install`
 *   works from the compiled binary (same committed-generated-output pattern as
 *   the browser-relay extension). Re-run after touching `src/`, `manifest.json`
 *   or `popup.html`, and commit the regenerated assets.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = import.meta.dir;
const dist = path.join(root, "dist");
const assetsDir = path.resolve(root, "../coding-agent/src/tools/browser/annotate-extension-assets");

const result = await Bun.build({
	entrypoints: ["src/background.ts", "src/content.ts", "src/popup.ts"],
	outdir: "dist",
	target: "browser",
	format: "iife",
	minify: false,
	naming: "[name].[ext]",
});

if (!result.success) {
	for (const log of result.logs) {
		await Bun.stderr.write(`${log}\n`);
	}
	process.exit(1);
}

await Bun.write("dist/manifest.json", Bun.file("manifest.json"));
await Bun.write("dist/popup.html", Bun.file("popup.html"));

await fs.rm(assetsDir, { recursive: true, force: true });
for (const file of ["background.js", "content.js", "popup.js", "popup.html", "manifest.json"]) {
	await Bun.write(path.join(assetsDir, `${file}.txt`), Bun.file(path.join(dist, file)));
}

console.log("built:");
console.log(`  ${dist}`);
console.log(`  ${assetsDir} (embedded CLI assets — commit these)`);
