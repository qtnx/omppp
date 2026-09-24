import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { blobExtensionForImageMimeType } from "./image-format";
import { fileHyperlink } from "../render/hyperlink";

/** Materialized image destination returned by the host blob writer. */
interface ImageBlobResult {
	displayPath: string;
}

/**
 * Blob-store reference (`blob:<algo>:<hash>`): the bytes live in the host's blob
 * store, so this render layer can neither decode nor resolve one.
 */
export function isBlobRef(data: string): boolean {
	return data.startsWith("blob:");
}

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

type ImageBlobWriter = (data: Buffer, options?: { extension?: string }) => Promise<ImageBlobResult>;
type ImageBlobWriterSync = (data: Buffer, options?: { extension?: string }) => ImageBlobResult;
/**
 * Host hook that turns a blob ref back into base64. The blob store lives
 * outside this render layer, so an archived image only materializes a link
 * when the host supplies this; without it the ref is skipped.
 */
type ImageBlobRefResolver = (ref: string) => string | undefined;

/** Base64 bytes for an image, resolving a store ref through the host when possible. */
function imageBase64Data(image: ImageContent, resolveBlobRef: ImageBlobRefResolver | undefined): string | undefined {
	if (!isBlobRef(image.data)) return image.data;
	// A blob ref is a store handle, not base64: never hand one to the writer.
	const resolved = resolveBlobRef?.(image.data);
	return !resolved || isBlobRef(resolved) ? undefined : resolved;
}

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
	resolveBlobRef?: ImageBlobRefResolver,
): Promise<string | undefined> {
	try {
		const data = imageBase64Data(image, resolveBlobRef);
		if (data === undefined) return undefined;
		const result = await putBlob(Buffer.from(data, "base64"), {
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
	resolveBlobRef?: ImageBlobRefResolver,
): string | undefined {
	try {
		const data = imageBase64Data(image, resolveBlobRef);
		if (data === undefined) return undefined;
		const result = putBlob(Buffer.from(data, "base64"), {
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
	resolveBlobRef?: ImageBlobRefResolver,
): Promise<(string | undefined)[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const links = await Promise.all(
		images.map((image, index) => materializeImageReferenceLinkAsync(image, index + 1, putBlob, resolveBlobRef)),
	);
	return links.some(link => link !== undefined) ? links : undefined;
}

export function materializeImageReferenceLinksSync(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriterSync,
	resolveBlobRef?: ImageBlobRefResolver,
): (string | undefined)[] | undefined {
	if (!images || images.length === 0) return undefined;
	const links = images.map((image, index) => materializeImageReferenceLink(image, index + 1, putBlob, resolveBlobRef));
	return links.some(link => link !== undefined) ? links : undefined;
}
