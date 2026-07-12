import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	materializeImageReferenceLinks,
	materializeImageReferenceLinksSync,
} from "@oh-my-pi/pi-coding-agent/modes/image-references";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { getAgentDir, getBlobsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const PNG_BYTES = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
	0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4,
	0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const PNG_B64 = PNG_BYTES.toString("base64");

describe("image-references blob ref guards", () => {
	let previousAgentDir: string | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		if (previousAgentDir !== undefined) setAgentDir(previousAgentDir);
		previousAgentDir = undefined;
		if (tempDir) await tempDir.remove();
		tempDir = undefined;
	});

	function withAgentBlobs(): BlobStore {
		tempDir = TempDir.createSync("@image-ref-blob-");
		previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		fs.mkdirSync(getBlobsDir(), { recursive: true });
		return new BlobStore(getBlobsDir());
	}

	it("resolves a present blob ref through putBlob and returns a display path", () => {
		const blobs = withAgentBlobs();
		const { ref } = blobs.putSync(PNG_BYTES, { extension: "png" });
		expect(isBlobRef(ref)).toBe(true);

		const image: ImageContent = { type: "image", data: ref, mimeType: "image/png" };
		let putCalled = false;
		const links = materializeImageReferenceLinksSync([image], data => {
			putCalled = true;
			expect(Buffer.compare(data, PNG_BYTES)).toBe(0);
			return blobs.putSync(data, { extension: "png" });
		});

		expect(putCalled).toBe(true);
		expect(links?.[0]).toBeTruthy();
		expect(typeof links?.[0]).toBe("string");
	});

	it("skips a missing blob ref without throwing (sync)", () => {
		withAgentBlobs();
		const image: ImageContent = {
			type: "image",
			data: `blob:sha256:${"0".repeat(64)}`,
			mimeType: "image/png",
		};

		expect(() =>
			materializeImageReferenceLinksSync([image], () => {
				throw new Error("putBlob must not run for missing refs");
			}),
		).not.toThrow();

		const links = materializeImageReferenceLinksSync([image], () => {
			throw new Error("putBlob must not run for missing refs");
		});
		expect(links === undefined || links.every(link => link === undefined)).toBe(true);
	});

	it("skips a missing blob ref without throwing (async)", async () => {
		withAgentBlobs();
		const image: ImageContent = {
			type: "image",
			data: `blob:sha256:${"a".repeat(64)}`,
			mimeType: "image/png",
		};

		const links = await materializeImageReferenceLinks([image], async () => {
			throw new Error("putBlob must not run for missing refs");
		});
		expect(links === undefined || links.every(link => link === undefined)).toBe(true);
	});

	it("is a no-op for inline base64 (existing behavior)", () => {
		withAgentBlobs();
		const image: ImageContent = { type: "image", data: PNG_B64, mimeType: "image/png" };
		let sawBytes: Buffer | undefined;
		const links = materializeImageReferenceLinksSync([image], data => {
			sawBytes = data;
			return {
				hash: "inline",
				path: "/tmp/inline",
				displayPath: "/tmp/inline.png",
				get ref() {
					return "blob:sha256:inline";
				},
			};
		});
		expect(sawBytes && Buffer.compare(sawBytes, PNG_BYTES)).toBe(0);
		expect(links?.[0]).toBe("/tmp/inline.png");
	});
});
