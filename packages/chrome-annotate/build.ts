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
