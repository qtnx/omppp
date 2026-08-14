/**
 * Image Generation Providers
 *
 * Leaf module (no runtime deps) shared by the image_gen tool, the settings
 * schema, and settings migrations — mirrors `web/search/types.ts` so the
 * provider list, auto order, and settings choices never drift apart.
 */

/** Image generation backends, in settings/tool vocabulary. */
export type ImageProvider = "antigravity" | "gemini" | "openai" | "openai-codex" | "openrouter" | "xai";

/**
 * Auto-resolution fallback order used after the per-request provider and the
 * configured `providers.imageOrder` list. A connected Codex (ChatGPT)
 * subscription leads: it needs no extra API key and is resolved independently
 * of the model the session is chatting with, so it must also outrank the
 * session's own provider (see `imageProviderOrder` in `image-gen.ts`).
 */
export const AUTO_IMAGE_PROVIDER_ORDER: readonly ImageProvider[] = [
	"openai-codex",
	"openai",
	"antigravity",
	"xai",
	"openrouter",
	"gemini",
];

/** Settings choices for `providers.imageOrder` (labels shared with the retired single-preference enum). */
export const IMAGE_PROVIDER_CHOICES = [
	{
		value: "openai-codex",
		label: "OpenAI Codex (ChatGPT)",
		description: "Uses a connected Codex / ChatGPT subscription — no OPENAI_API_KEY needed",
	},
	{
		value: "openai",
		label: "OpenAI",
		description: "OPENAI_API_KEY (gpt-image-2) or active GPT model; falls back to a connected Codex subscription",
	},
	{
		value: "antigravity",
		label: "Antigravity",
		description: "Requires google-antigravity OAuth",
	},
	{
		value: "xai",
		label: "xAI Grok Imagine",
		description: "Requires xAI Grok OAuth or XAI_API_KEY",
	},
	{ value: "gemini", label: "Gemini", description: "Requires GEMINI_API_KEY" },
	{ value: "openrouter", label: "OpenRouter", description: "Requires OPENROUTER_API_KEY" },
] as const satisfies ReadonlyArray<{ value: ImageProvider; label: string; description: string }>;

/**
 * xAI Grok Imagine text-to-image model ids, as exposed by `GET
 * https://api.x.ai/v1/models`. `grok-imagine-image-quality` is the API id of
 * the model xAI markets as "Imagine Image 2.0" / Quality Mode; there is no
 * `grok-imagine-image-2` id (that string 404s), so the version number never
 * appears in the model id.
 */
export type XaiImageModel = "grok-imagine-image" | "grok-imagine-image-quality";

/** Default xAI image model — the cheaper standard tier. */
export const DEFAULT_XAI_IMAGE_MODEL: XaiImageModel = "grok-imagine-image";

/** Settings choices for `providers.xaiImageModel`. */
export const XAI_IMAGE_MODEL_CHOICES = [
	{
		value: "grok-imagine-image",
		label: "Grok Imagine (standard)",
		description: "Faster and cheaper standard tier",
	},
	{
		value: "grok-imagine-image-quality",
		label: "Grok Imagine Quality (Image 2.0)",
		description: "Quality Mode — better typography, dense layouts, and edits; costs more per image",
	},
] as const satisfies ReadonlyArray<{ value: XaiImageModel; label: string; description: string }>;

export function isXaiImageModel(value: unknown): value is XaiImageModel {
	return XAI_IMAGE_MODEL_CHOICES.some(choice => choice.value === value);
}

export function isImageProviderId(value: unknown): value is ImageProvider {
	return typeof value === "string" && AUTO_IMAGE_PROVIDER_ORDER.includes(value as ImageProvider);
}
