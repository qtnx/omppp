import { AnthropicOAuthFlow, loginAnthropic, refreshAnthropicToken } from "@oh-my-pi/pi-ai/registry/oauth";
import "@oh-my-pi/pi-ai/providers/anthropic";
import "@oh-my-pi/pi-ai/auth-storage";

if (!AnthropicOAuthFlow || !loginAnthropic || !refreshAnthropicToken) {
	throw new Error("Anthropic OAuth exports are unavailable");
}
