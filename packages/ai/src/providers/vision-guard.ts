import { isDashscopeCompatibleModeUrl } from "@oh-my-pi/pi-catalog/hosts";
import { isQwenModelId } from "@oh-my-pi/pi-catalog/identity";

import type { ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";

export const UNAVAILABLE_IMAGE_PLACEHOLDER = "[image omitted: image data unavailable]";

const TRUNCATED_PERSISTED_CONTENT_MARKER = "[Session persistence truncated large content]";

export function isImageContentAvailable(block: ImageContent): boolean {
	return (
		block.data.length > 0 &&
		!block.data.startsWith("blob:") &&
		!block.data.includes(TRUNCATED_PERSISTED_CONTENT_MARKER)
	);
}

export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
): {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	omittedImages: boolean;
	unavailableImages: boolean;
} {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const allImageBlocks = content.filter((block): block is ImageContent => block.type === "image");
	const availableImageBlocks = allImageBlocks.filter(isImageContentAvailable);
	return {
		textBlocks,
		imageBlocks: supportsImages ? availableImageBlocks : [],
		omittedImages: !supportsImages && allImageBlocks.length > 0,
		unavailableImages: supportsImages && availableImageBlocks.length < allImageBlocks.length,
	};
}

export function joinTextWithImagePlaceholder(
	text: string,
	omittedImages: boolean,
	placeholder = NON_VISION_IMAGE_PLACEHOLDER,
): string {
	const parts: string[] = [];
	if (text.length > 0) {
		parts.push(text);
	}
	if (omittedImages) {
		parts.push(placeholder);
	}
	return parts.join("\n");
}

/**
 * Detect known text-only Qwen models served via Alibaba DashScope's consumer
 * `compatible-mode` endpoint that the upstream chat-completions API rejects
 * multimodal content arrays for. The compatible-mode endpoint also serves
 * multimodal Qwen SKUs without `vl` in the id (e.g. `qwen3.7-plus`), so this
 * guard only covers families verified to be text-only for issue #1859:
 * `qwen*-max` and `qwen*-coder*`.
 *
 * Used as a defensive override in `convertMessages` so a misconfigured custom
 * provider (issue #1859) can't drive the request into an unrecoverable 400.
 */
export function isDashscopeCompatibleModeTextOnlyQwen(model: Model<"openai-completions">): boolean {
	if (!isDashscopeCompatibleModeUrl(model.baseUrl)) {
		return false;
	}
	const id = model.id.toLowerCase();
	if (!isQwenModelId(model.id)) return false;
	return /\bqwen(?:[\d.]+)?-max\b/.test(id) || /\bqwen(?:[\d.]+)?-coder\b/.test(id);
}
