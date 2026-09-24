/**
 * Durable copies of browser-annotation screenshots.
 *
 * The screenshot also rides inline in the annotation message, but inline images
 * can later be stripped from context (image GC, compaction). Writing a file lets
 * the message text carry a path the agent can `read` again whenever it needs the
 * visual. Old shots are pruned on every save so the directory stays bounded.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAnnotateExtensionDir, isEnoent, logger } from "@oh-my-pi/pi-utils";

const MAX_SHOTS = 200;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};

/** Default shots directory: `~/.omp/annotate/shots`. */
export function getAnnotationShotsDir(): string {
	return path.join(getAnnotateExtensionDir(), "shots");
}

/**
 * Write one screenshot and prune the directory. Resolves to the absolute file
 * path, or `undefined` when the write failed (annotation delivery must not
 * depend on disk state, so failures are logged, not thrown).
 */
export async function saveAnnotationScreenshot(
	screenshot: { data: string; mimeType: string },
	timestamp: number,
	dir: string = getAnnotationShotsDir(),
): Promise<string | undefined> {
	const ext = EXTENSION_BY_MIME[screenshot.mimeType] ?? "img";
	const file = path.join(dir, `${timestamp}-${crypto.randomUUID().slice(0, 8)}.${ext}`);
	try {
		await Bun.write(file, Uint8Array.fromBase64(screenshot.data));
	} catch (error) {
		logger.warn("Failed to save annotation screenshot", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	await pruneAnnotationScreenshots(dir, Date.now()).catch((error: unknown) => {
		logger.warn("Failed to prune annotation screenshots", {
			error: error instanceof Error ? error.message : String(error),
		});
	});
	return file;
}

/** Keep the newest {@link MAX_SHOTS} files and drop anything older than {@link MAX_AGE_MS}. */
export async function pruneAnnotationScreenshots(dir: string, now: number): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	const files: Array<{ file: string; mtimeMs: number }> = [];
	for (const name of names) {
		const file = path.join(dir, name);
		try {
			const stat = await fs.stat(file);
			if (stat.isFile()) files.push({ file, mtimeMs: stat.mtimeMs });
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const [index, entry] of files.entries()) {
		if (index < MAX_SHOTS && now - entry.mtimeMs <= MAX_AGE_MS) continue;
		await fs.rm(entry.file, { force: true });
	}
}
