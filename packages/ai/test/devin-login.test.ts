import { describe, expect, test } from "bun:test";
import { exchangeDevinCliToken } from "@oh-my-pi/pi-ai/registry/oauth/devin";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

describe("Devin CLI login", () => {
	test("exchanges callback code with CLI token JSON endpoint", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const fetchImpl: FetchImpl = async (url, init) => {
			requestUrl = String(url);
			requestInit = init;
			return new Response(JSON.stringify({ token: "devin-jwt" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const token = await exchangeDevinCliToken("callback-code", "pkce-verifier", fetchImpl);

		expect(token).toBe("devin-jwt");
		expect(requestUrl).toBe("https://api.devin.ai/auth/cli/token");
		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.headers).toEqual({
			Accept: "application/json",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(requestInit?.body))).toEqual({
			code: "callback-code",
			code_verifier: "pkce-verifier",
		});
	});

	test("ignores global reasoning effort for Devin models without configurable efforts", async () => {
		const controller = new AbortController();
		controller.abort();
		const model = buildModel({
			id: "deepseek-v4",
			name: "DeepSeek V4",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://api.devin.ai",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64000,
		}) as Model<"devin-agent">;
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
		const fetchImpl: FetchImpl = async () => {
			throw new Error("aborted fetch");
		};

		const result = await streamSimple(model, context, {
			apiKey: "devin-token",
			fetch: fetchImpl,
			reasoning: Effort.High,
			signal: controller.signal,
		}).result();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage ?? "").not.toContain("Thinking effort");
	});
});
