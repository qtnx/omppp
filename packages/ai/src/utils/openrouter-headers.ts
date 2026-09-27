import { APP_URL, USER_AGENT } from "@oh-my-pi/pi-utils";
import { INFERENCE_APP_NAME } from "../providers/inference-headers";

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"HTTP-Referer": APP_URL,
		"X-OpenRouter-Title": INFERENCE_APP_NAME,
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
