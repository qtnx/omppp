import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { BundleItem, BundleManifest, ItemKind } from "./types";

interface ScanBundleOptions {
	root: string;
	extraPaths?: string[];
	title?: string;
}

const SUPPORTED_SUFFIXES = [".canvas.json", ".md", ".html"] as const;

/**
 * Resolves a regular file only when it remains physically contained by the
 * preview root. `extraPaths` are configuration input, so lexical `..` checks
 * alone are not enough: a symlink can otherwise expose an arbitrary file.
 */
async function resolveSafeBundleFile(
	root: string,
	filePath: string,
): Promise<{ filePath: string; relPath: string } | null> {
	const resolved = path.resolve(filePath);
	try {
		const [entry, realRoot, realFile] = await Promise.all([
			fs.lstat(resolved),
			fs.realpath(root),
			fs.realpath(resolved),
		]);
		if (!entry.isFile()) {
			logger.warn("Skipping non-regular preview bundle path", { path: resolved });
			return null;
		}
		const relPath = path.relative(realRoot, realFile);
		if (!relPath || path.isAbsolute(relPath) || relPath.split(path.sep).includes("..")) {
			logger.warn("Skipping preview bundle file outside root", { root, path: filePath });
			return null;
		}
		return { filePath: resolved, relPath: relPath.split(path.sep).join("/") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.warn("Skipping unreadable preview bundle path", {
				path: resolved,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return null;
	}
}

function inferKind(relPath: string): ItemKind {
	if (relPath.toLowerCase().endsWith(".canvas.json")) return "canvas";
	if (relPath.toLowerCase().endsWith(".html")) return "mockup";
	const segments = relPath.toLowerCase().split("/");
	const fileName = segments.at(-1) ?? "";
	if (segments.includes("specs")) return "spec";
	if (segments.includes("architecture")) return "architecture";
	if (segments.includes("plans")) return "plan";
	if (segments.includes("briefs")) return "brief";
	if (segments.includes("design") || fileName.endsWith("-ui.md")) return "design";
	return "doc";
}

function extractTitle(content: string, relPath: string): string {
	if (relPath.toLowerCase().endsWith(".html")) {
		const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(content)?.[1]?.trim();
		if (title) return title;
	} else {
		const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(content)?.[1]?.trim();
		if (heading) return heading;
	}
	return path.posix.basename(relPath);
}

function hashPath(relPath: string): string {
	return new Bun.CryptoHasher("sha256").update(relPath).digest("hex").slice(0, 12);
}

/** Uses code-unit ordering so manifest order does not vary with host locale. */
function compareText(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

async function collectRootFiles(root: string): Promise<string[]> {
	const files: string[] = [];

	async function walk(directory: string): Promise<void> {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => compareText(left.name, right.name));

		for (const entry of entries) {
			// Skip hidden dirs (e.g. .ompx-preview state) so review state never becomes an item.
			if (entry.name.startsWith(".")) continue;
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
				continue;
			}
			if (entry.isFile() && SUPPORTED_SUFFIXES.some(suffix => entry.name.toLowerCase().endsWith(suffix))) {
				files.push(entryPath);
			}
		}
	}

	await walk(root);
	return files;
}

async function toBundleItem(root: string, filePath: string, kind: ItemKind | undefined): Promise<BundleItem | null> {
	const safeFile = await resolveSafeBundleFile(root, filePath);
	if (!safeFile) return null;

	const stat = await fs.stat(safeFile.filePath);
	const content = await Bun.file(safeFile.filePath).text();
	return {
		id: hashPath(safeFile.relPath),
		kind: kind ?? inferKind(safeFile.relPath),
		relPath: safeFile.relPath,
		title: extractTitle(content, safeFile.relPath),
		mtimeMs: stat.mtimeMs,
		size: stat.size,
	};
}

/** Scans the product artifacts available beneath a single preview root. */
export async function scanBundle(options: ScanBundleOptions): Promise<BundleManifest> {
	const root = path.resolve(options.root);
	const candidates = await collectRootFiles(root);
	const itemsByPath = new Map<string, BundleItem>();

	for (const filePath of candidates) {
		const item = await toBundleItem(root, filePath, undefined);
		if (item) itemsByPath.set(item.relPath, item);
	}

	for (const extraPath of options.extraPaths ?? []) {
		const normalizedExtraPath = extraPath.split(path.sep).join("/");
		if (path.isAbsolute(extraPath) || normalizedExtraPath.split("/").includes("..")) {
			logger.warn("Skipping unsafe preview bundle extra path", { root, path: extraPath });
			continue;
		}

		const item = await toBundleItem(root, path.resolve(root, extraPath), "doc");
		if (item) itemsByPath.set(item.relPath, item);
	}

	const items = [...itemsByPath.values()].sort((left, right) => {
		return compareText(left.kind, right.kind) || compareText(left.relPath, right.relPath);
	});

	return {
		bundle: {
			title: options.title ?? path.basename(root),
			root,
			generatedAt: Date.now(),
		},
		capabilities: { feedback: false },
		items,
	};
}
