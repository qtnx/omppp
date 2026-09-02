import type { ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";
// `vision` delimited by non-alphanumerics, so `deepseek-v4-flash-vision-exp`
// and `deepseek_vision` match but `deepseek-r1-revision-0528` does not.
// Inputs are lowercased before testing.

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
 * Evaluates whether an OpenAI-compatible Chat Completions model genuinely
 * supports multimodal image inputs on the wire. Defensive guards override
 * misconfigured provider descriptors or user model entries (e.g. text-only
 * DashScope Qwen SKUs, DeepSeek models) whose endpoints reject `image_url`.
 */
export function isOpenAICompletionsVisionSupported(model: Model<"openai-completions">): boolean {
	if (!model.input.includes("image")) return false;
	if (model.compat.stripImageInput) return false;
	return true;
}
