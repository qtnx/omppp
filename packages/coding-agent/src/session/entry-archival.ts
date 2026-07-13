import { logger } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { type BlobStore, blobExtensionForImageMimeType, isBlobRef, isImageDataUrl, parseBlobRef } from "./blob-store";
import type { SessionEntry } from "./session-entries";

export const TEXT_ARCHIVE_THRESHOLD = 16 * 1024;
const ARCHIVED_CONTENT_PLACEHOLDER = "[content archived]";

type MutableImageData = { data: string; mimeType?: string };
type MutableTextBlock = { type: "text"; text: string };
type MutableThinkingBlock = { type: "thinking"; thinking: string; thinkingSignature?: string };

/** Provider image data URLs below this size stay inline in custom-entry data. */
const IMAGE_DATA_URL_ARCHIVE_MIN = 1024;

function isMutableImageData(value: unknown): value is MutableImageData {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof value.data === "string" &&
		(!("mimeType" in value) || value.mimeType === undefined || typeof value.mimeType === "string")
	);
}

function isMutableImageBlock(value: unknown): value is MutableImageData {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "image" &&
		isMutableImageData(value)
	);
}

function isMutableTextBlock(value: unknown): value is MutableTextBlock {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "text" &&
		"text" in value &&
		typeof value.text === "string"
	);
}

function isMutableThinkingBlock(value: unknown): value is MutableThinkingBlock {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "thinking" &&
		"thinking" in value &&
		typeof value.thinking === "string" &&
		(!("thinkingSignature" in value) ||
			value.thinkingSignature === undefined ||
			typeof value.thinkingSignature === "string")
	);
}

function archiveText(value: string, blobs: BlobStore): string {
	if (value.length <= TEXT_ARCHIVE_THRESHOLD || isBlobRef(value)) return value;
	return blobs.putSync(Buffer.from(value, "utf8")).ref;
}

function archiveImage(value: MutableImageData, blobs: BlobStore): void {
	if (isBlobRef(value.data)) return;
	value.data = blobs.putSync(Buffer.from(value.data, "base64"), {
		extension: blobExtensionForImageMimeType(value.mimeType),
	}).ref;
}

function resolveText(value: string, blobs: BlobStore): string {
	const hash = parseBlobRef(value);
	if (!hash) return value;
	const data = blobs.getSync(hash);
	if (!data) {
		logger.warn("Blob not found for archived session text", { hash });
		return ARCHIVED_CONTENT_PLACEHOLDER;
	}
	return data.toString("utf8");
}

function resolveImage(value: MutableImageData, blobs: BlobStore): void {
	const hash = parseBlobRef(value.data);
	if (!hash) return;
	const data = blobs.getSync(hash);
	if (!data) {
		logger.warn("Blob not found for archived session image", { hash });
		value.data = "";
		return;
	}
	value.data = data.toString("base64");
}

function archiveContent(content: unknown, blobs: BlobStore): void {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (isMutableTextBlock(block)) {
			block.text = archiveText(block.text, blobs);
		} else if (isMutableImageBlock(block)) {
			archiveImage(block, blobs);
		} else if (isMutableThinkingBlock(block)) {
			block.thinking = archiveText(block.thinking, blobs);
			if (typeof block.thinkingSignature === "string") {
				block.thinkingSignature = archiveText(block.thinkingSignature, blobs);
			}
		}
	}
}

function rehydrateContent(content: unknown, blobs: BlobStore): void {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (isMutableTextBlock(block)) {
			block.text = resolveText(block.text, blobs);
		} else if (isMutableImageBlock(block)) {
			resolveImage(block, blobs);
		} else if (isMutableThinkingBlock(block)) {
			block.thinking = resolveText(block.thinking, blobs);
			if (typeof block.thinkingSignature === "string") {
				block.thinkingSignature = resolveText(block.thinkingSignature, blobs);
			}
		}
	}
}

/**
 * Walk custom-entry data for the two heavy shapes persistence already
 * round-trips on disk: provider `image_url` data URLs and typed image blocks.
 * Generic strings stay inline — they have no persisted blob counterpart, so a
 * ref would leak into JSONL as an unresolvable opaque string.
 */
function archiveCustomData(value: unknown, blobs: BlobStore): void {
	if (Array.isArray(value)) {
		for (const item of value) archiveCustomData(item, blobs);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	if (isMutableImageBlock(value)) {
		archiveImage(value, blobs);
		return;
	}
	const record = value as Record<string, unknown>;
	for (const [key, child] of Object.entries(record)) {
		if (typeof child === "string") {
			if (key === "image_url" && isImageDataUrl(child) && child.length >= IMAGE_DATA_URL_ARCHIVE_MIN) {
				record[key] = blobs.putSync(Buffer.from(child, "utf8")).ref;
			}
			continue;
		}
		archiveCustomData(child, blobs);
	}
}

function rehydrateCustomData(value: unknown, blobs: BlobStore): void {
	if (Array.isArray(value)) {
		for (const item of value) rehydrateCustomData(item, blobs);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	if (isMutableImageBlock(value)) {
		resolveImage(value, blobs);
		return;
	}
	const record = value as Record<string, unknown>;
	for (const [key, child] of Object.entries(record)) {
		if (typeof child === "string") {
			if (key === "image_url" && isBlobRef(child)) {
				const hash = parseBlobRef(child);
				const data = hash ? blobs.getSync(hash) : null;
				if (!data) {
					logger.warn("Blob not found for archived session image URL", { hash });
					record[key] = "";
				} else {
					record[key] = data.toString("utf8");
				}
			}
			continue;
		}
		rehydrateCustomData(child, blobs);
	}
}

function archiveDetailImages(details: unknown, blobs: BlobStore): void {
	if (typeof details !== "object" || details === null || !("images" in details) || !Array.isArray(details.images))
		return;
	for (const candidate of details.images) {
		if (isMutableImageData(candidate)) archiveImage(candidate, blobs);
	}
}

function rehydrateDetailImages(details: unknown, blobs: BlobStore): void {
	if (typeof details !== "object" || details === null || !("images" in details) || !Array.isArray(details.images))
		return;
	for (const candidate of details.images) {
		if (isMutableImageData(candidate)) resolveImage(candidate, blobs);
	}
}

function archiveFrames(entry: SessionEntry, blobs: BlobStore): void {
	if (entry.type !== "compaction") return;
	const archive = snapcompact.getPreservedArchive(entry.preserveData);
	if (!archive) return;
	for (const frame of archive.frames) archiveImage(frame, blobs);
}

function rehydrateFrames(entry: SessionEntry, blobs: BlobStore): void {
	if (entry.type !== "compaction") return;
	const archive = snapcompact.getPreservedArchive(entry.preserveData);
	if (!archive) return;
	for (const frame of archive.frames) resolveImage(frame, blobs);
}

/** Replaces archiveable heavy leaves with content-addressed refs in place. */
export function archiveEntries(entries: SessionEntry[], blobs: BlobStore): void {
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message as { content?: unknown; role?: string; details?: unknown };
			if (Array.isArray(message.content)) {
				archiveContent(message.content, blobs);
			} else if (typeof message.content === "string") {
				message.content = archiveText(message.content, blobs);
			}
			if (entry.message.role === "toolResult") archiveDetailImages(entry.message.details, blobs);
		} else if (entry.type === "custom_message") {
			if (Array.isArray(entry.content)) archiveContent(entry.content, blobs);
			else if (typeof entry.content === "string") entry.content = archiveText(entry.content, blobs);
		} else if (entry.type === "custom") {
			archiveCustomData(entry.data, blobs);
		}
		archiveFrames(entry, blobs);
	}
}

/** Rehydrates archived heavy leaves in place without replacing object identities. */
export function rehydrateEntries(entries: SessionEntry[], blobs: BlobStore): void {
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message as { content?: unknown; role?: string; details?: unknown };
			if (Array.isArray(message.content)) {
				rehydrateContent(message.content, blobs);
			} else if (typeof message.content === "string") {
				message.content = resolveText(message.content, blobs);
			}
			if (entry.message.role === "toolResult") rehydrateDetailImages(entry.message.details, blobs);
		} else if (entry.type === "custom_message") {
			if (Array.isArray(entry.content)) rehydrateContent(entry.content, blobs);
			else if (typeof entry.content === "string") entry.content = resolveText(entry.content, blobs);
		} else if (entry.type === "custom") {
			rehydrateCustomData(entry.data, blobs);
		}
		rehydrateFrames(entry, blobs);
	}
}
