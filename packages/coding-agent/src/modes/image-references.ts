import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBlobsDir, logger } from "@oh-my-pi/pi-utils";
import {
	type BlobPutResult,
	BlobStore,
	blobExtensionForImageMimeType,
	isBlobRef,
	resolveImageData,
	resolveImageDataSync,
} from "../session/blob-store";
import { fileHyperlink } from "../tui/hyperlink";

/** Probed pixel dimensions riding on the draft image object itself; `null` records a failed
 *  probe so the chips band never re-decodes a corrupt header every frame. */
const kImageDims = Symbol("omp.imageDimensions");

interface ImageContentWithDims extends ImageContent {
	[kImageDims]?: { width: number; height: number } | null;
}

/** Cached probe result for a draft image: dimensions, `null` (probe failed), or `undefined`
 *  (never probed). */
export function cachedImageDimensions(image: ImageContent): { width: number; height: number } | null | undefined {
	return (image as ImageContentWithDims)[kImageDims];
}

/** Record a probe result for a draft image (see {@link cachedImageDimensions}). */
export function setCachedImageDimensions(image: ImageContent, dims: { width: number; height: number } | null): void {
	(image as ImageContentWithDims)[kImageDims] = dims;
}

type ImageBlobWriter = (data: Buffer, options?: { extension?: string }) => Promise<BlobPutResult>;
type ImageBlobWriterSync = (data: Buffer, options?: { extension?: string }) => BlobPutResult;

export function imageReferenceHyperlink(
	label: string,
	index: number,
	imageLinks: readonly (string | undefined)[] | undefined,
	renderLabel: (text: string) => string,
): string {
	const rendered = renderLabel(label);
	const target = imageLinks?.[index - 1];
	return target ? fileHyperlink(target, rendered) : rendered;
}

async function materializeImageReferenceLinkAsync(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriter,
): Promise<string | undefined> {
	try {
		let base64Data = image.data;
		if (isBlobRef(base64Data)) {
			const resolved = await resolveImageData(new BlobStore(getBlobsDir()), base64Data);
			// Missing blob → "" (async resolver). Never put a raw ref as base64.
			if (!resolved || isBlobRef(resolved)) return undefined;
			base64Data = resolved;
		}
		const result = await putBlob(Buffer.from(base64Data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function materializeImageReferenceLink(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriterSync,
): string | undefined {
	try {
		let base64Data = image.data;
		if (isBlobRef(base64Data)) {
			const resolved = resolveImageDataSync(new BlobStore(getBlobsDir()), base64Data);
			// Sync missing-blob path returns the raw ref — treat as unavailable.
			if (!resolved || isBlobRef(resolved)) return undefined;
			base64Data = resolved;
		}
		const result = putBlob(Buffer.from(base64Data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export async function materializeImageReferenceLinks(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriter,
): Promise<(string | undefined)[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const links = await Promise.all(
		images.map((image, index) => materializeImageReferenceLinkAsync(image, index + 1, putBlob)),
	);
	return links.some(link => link !== undefined) ? links : undefined;
}

export function materializeImageReferenceLinksSync(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriterSync,
): (string | undefined)[] | undefined {
	if (!images || images.length === 0) return undefined;
	const links = images.map((image, index) => materializeImageReferenceLink(image, index + 1, putBlob));
	return links.some(link => link !== undefined) ? links : undefined;
}
