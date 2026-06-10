import type { Page } from "puppeteer-core";
import { generateUnifiedDiffString } from "../../edit/diff";
import type { Observation, ObservationEntry } from "./tab-protocol";

export interface PixelDiffResult {
	ratio: number;
	changedPixels: number;
	totalPixels: number;
	width: number;
	height: number;
	diffPng: Uint8Array;
}

function serializeValue(value: ObservationEntry["value"]): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function serializeObservation(obs: Observation): string {
	const lines = [
		`url: ${obs.url}`,
		`title: ${obs.title ?? ""}`,
		`scroll: ${obs.scroll.x},${obs.scroll.y} ${obs.scroll.width}x${obs.scroll.height} of ${obs.scroll.scrollWidth}x${obs.scroll.scrollHeight}`,
	];

	for (const element of obs.elements) {
		const value = serializeValue(element.value);
		const valuePart = value === undefined ? "" : ` value=${value}`;
		lines.push(
			`${element.role} ${JSON.stringify(element.name ?? "")}${valuePart} states=[${element.states.join(",")}]`,
		);
	}

	return lines.join("\n");
}

export function diffObservations(prev: Observation, next: Observation): { diff: string; changed: boolean } {
	const prevText = serializeObservation(prev);
	const nextText = serializeObservation(next);
	if (prevText === nextText) return { diff: "", changed: false };
	return { diff: generateUnifiedDiffString(prevText, nextText, 2).diff, changed: true };
}

export async function pixelDiffInPage(
	page: Page,
	baselinePng: Uint8Array,
	currentPng: Uint8Array,
	threshold = 0.1,
): Promise<PixelDiffResult> {
	const baselineB64 = Buffer.from(baselinePng).toBase64();
	const currentB64 = Buffer.from(currentPng).toBase64();
	const result = await page.evaluate(
		async (baseB64, currB64, colorThreshold) => {
			interface ImageBitmapLike {
				width: number;
				height: number;
				close?: () => void;
			}

			interface ImageDataLike {
				data: Uint8ClampedArray;
			}

			interface CanvasContextLike {
				drawImage(image: unknown, dx: number, dy: number): void;
				getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike;
				putImageData(imageData: ImageDataLike, dx: number, dy: number): void;
			}

			interface OffscreenCanvasLike {
				getContext(contextId: "2d"): CanvasContextLike | null;
				convertToBlob(options: { type: string }): Promise<unknown>;
			}

			interface FileReaderLike {
				result: string | ArrayBuffer | null;
				onload: (() => void) | null;
				onerror: (() => void) | null;
				readAsDataURL(blob: unknown): void;
			}

			interface BrowserGlobals {
				atob(data: string): string;
				Blob: new (parts: Uint8Array[], options: { type: string }) => unknown;
				createImageBitmap(blob: unknown): Promise<ImageBitmapLike>;
				OffscreenCanvas: new (width: number, height: number) => OffscreenCanvasLike;
				FileReader: new () => FileReaderLike;
			}

			// Puppeteer evaluates this in the browser realm; this narrows the few DOM globals used below.
			const browser = globalThis as unknown as BrowserGlobals;
			const clampedThreshold = Math.max(0, Math.min(1, colorThreshold));
			const baseBytes = base64ToBytes(browser.atob(baseB64));
			const currBytes = base64ToBytes(browser.atob(currB64));
			const baseBitmap = await browser.createImageBitmap(new browser.Blob([baseBytes], { type: "image/png" }));
			const currBitmap = await browser.createImageBitmap(new browser.Blob([currBytes], { type: "image/png" }));

			try {
				const width = Math.max(baseBitmap.width, currBitmap.width);
				const height = Math.max(baseBitmap.height, currBitmap.height);
				const baseCanvas = new browser.OffscreenCanvas(width, height);
				const currCanvas = new browser.OffscreenCanvas(width, height);
				const diffCanvas = new browser.OffscreenCanvas(width, height);
				const baseContext = context2d(baseCanvas);
				const currContext = context2d(currCanvas);
				const diffContext = context2d(diffCanvas);

				baseContext.drawImage(baseBitmap, 0, 0);
				currContext.drawImage(currBitmap, 0, 0);

				const baseData = baseContext.getImageData(0, 0, width, height).data;
				const currImageData = currContext.getImageData(0, 0, width, height);
				const currData = currImageData.data;
				let changedPixels = 0;

				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const offset = (y * width + x) * 4;
						const inBase = x < baseBitmap.width && y < baseBitmap.height;
						const inCurr = x < currBitmap.width && y < currBitmap.height;
						const alphaChanged = baseData[offset + 3] !== currData[offset + 3];
						const colorDistance =
							Math.max(
								Math.abs(baseData[offset] - currData[offset]),
								Math.abs(baseData[offset + 1] - currData[offset + 1]),
								Math.abs(baseData[offset + 2] - currData[offset + 2]),
							) / 255;
						const changed = inBase !== inCurr || alphaChanged || colorDistance > clampedThreshold;

						if (changed) {
							changedPixels++;
							currData[offset] = 255;
							currData[offset + 1] = 0;
							currData[offset + 2] = 0;
							currData[offset + 3] = 255;
						} else {
							const luma =
								0.2126 * currData[offset] + 0.7152 * currData[offset + 1] + 0.0722 * currData[offset + 2];
							const dimmed = Math.min(255, Math.round(luma * 0.3 + 178));
							currData[offset] = dimmed;
							currData[offset + 1] = dimmed;
							currData[offset + 2] = dimmed;
							currData[offset + 3] = 255;
						}
					}
				}

				diffContext.putImageData(currImageData, 0, 0);
				const blob = await diffCanvas.convertToBlob({ type: "image/png" });
				const diffB64 = await blobToBase64(browser, blob);
				const totalPixels = width * height;
				return {
					changedPixels,
					diffB64,
					height,
					ratio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
					totalPixels,
					width,
				};
			} finally {
				baseBitmap.close?.();
				currBitmap.close?.();
			}

			function base64ToBytes(binary: string): Uint8Array {
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
				return bytes;
			}

			function context2d(canvas: OffscreenCanvasLike): CanvasContextLike {
				const context = canvas.getContext("2d");
				if (!context) throw new Error("2D canvas context unavailable");
				return context;
			}

			function blobToBase64(browserGlobals: BrowserGlobals, blob: unknown): Promise<string> {
				const done = Promise.withResolvers<string>();
				const reader = new browserGlobals.FileReader();
				reader.onload = () => {
					const result = reader.result;
					if (typeof result !== "string") {
						done.reject(new Error("FileReader did not produce a data URL"));
						return;
					}
					const comma = result.indexOf(",");
					done.resolve(comma < 0 ? result : result.slice(comma + 1));
				};
				reader.onerror = () => done.reject(new Error("Failed to read diff image"));
				reader.readAsDataURL(blob);
				return done.promise;
			}
		},
		baselineB64,
		currentB64,
		threshold,
	);

	return {
		changedPixels: result.changedPixels,
		diffPng: Buffer.from(result.diffB64, "base64"),
		height: result.height,
		ratio: result.ratio,
		totalPixels: result.totalPixels,
		width: result.width,
	};
}
