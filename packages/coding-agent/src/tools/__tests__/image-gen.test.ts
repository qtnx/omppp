import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import type { CustomToolContext } from "../../extensibility/custom-tools/types";
import {
	type ImageGenParams,
	imageGenTool,
	isImageProviderPreference,
	setImageProviderOrder,
	setPreferredImageProvider,
} from "../image-gen";

const SESSION_ID = "image-gen-test-session";
const IMAGE_BYTES_BASE64 = "iVBORw0KGgo=";

type ProviderKeyMap = Readonly<Record<string, string | undefined>>;

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: unknown;
}

interface RegistryOptions {
	available: readonly Model<Api>[];
	keys?: ProviderKeyMap;
}

function makeModel(provider: string, id: string, api: Api, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
		...extra,
	} as Model<Api>;
}

function makeCodexToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

function makeRegistry(options: RegistryOptions): ModelRegistry {
	const keys = options.keys ?? {};
	const registry = {
		getAvailable: () => [...options.available],
		getAll: () => [...options.available],
		find: (provider: string, modelId: string) =>
			options.available.find(model => model.provider === provider && model.id === modelId),
		getProviderBaseUrl: (provider: string) => options.available.find(model => model.provider === provider)?.baseUrl,
		getApiKey: async (model: Model<Api>) => keys[model.provider],
		getApiKeyForProvider: async (provider: string) => keys[provider],
		resolver: (modelOrProvider: Model<Api> | string) => async () =>
			keys[typeof modelOrProvider === "string" ? modelOrProvider : modelOrProvider.provider],
		authStorage: {
			hasNonEnvCredential: () => false,
		},
	};
	return registry as unknown as ModelRegistry;
}

function makeContext(options: { model: Model<Api>; registry: ModelRegistry; fetchImpl: FetchImpl }): CustomToolContext {
	const context = {
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getCwd: () => process.cwd(),
		},
		modelRegistry: options.registry,
		model: options.model,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => undefined,
		fetch: options.fetchImpl,
	};
	return context as unknown as CustomToolContext;
}

function createOpenAIImageJsonResponse(): Response {
	return new Response(
		JSON.stringify({
			output: [
				{
					type: "image_generation_call",
					result: IMAGE_BYTES_BASE64,
					revised_prompt: "A precise prompt for a red cube.",
				},
			],
			usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function createOpenAIImageSseResponse(): Response {
	const event = {
		type: "response.output_item.done",
		item: {
			type: "image_generation_call",
			result: IMAGE_BYTES_BASE64,
			revised_prompt: "A precise prompt for a red cube.",
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\n`, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function createCapturingFetch(captured: CapturedRequest[], options: { sse?: boolean } = {}): FetchImpl {
	const fetchImpl: FetchImpl = async (input, init) => {
		if (!init || typeof init.body !== "string") {
			throw new Error("Expected JSON request body");
		}
		captured.push({
			url: String(input),
			headers: new Headers(init.headers),
			body: JSON.parse(init.body) as unknown,
		});
		return options.sse ? createOpenAIImageSseResponse() : createOpenAIImageJsonResponse();
	};
	return fetchImpl;
}

async function runImageTool(options: { model: Model<Api>; registry: ModelRegistry; fetchImpl: FetchImpl }) {
	const params: ImageGenParams = {
		subject: "a red cube",
		style: "clean product render",
		aspect_ratio: "1:1",
	};
	return await imageGenTool.execute(
		"image-call-1",
		params,
		undefined,
		makeContext({ model: options.model, registry: options.registry, fetchImpl: options.fetchImpl }),
	);
}

describe("imageGenTool provider preference", () => {
	afterEach(() => {
		setPreferredImageProvider("auto");
		vi.restoreAllMocks();
	});

	it("recognizes openai-codex as an image provider preference", () => {
		expect(isImageProviderPreference("openai-codex")).toBe(true);
	});

	it("prefers the OpenAI Codex provider default over earlier suitable Codex image candidates", async () => {
		const activeModel = makeModel("anthropic", "claude-opus-4-1", "anthropic-messages");
		const nonDefaultCodexModel = makeModel("openai-codex", "gpt-5", "openai-codex-responses", {
			baseUrl: "https://chatgpt.com/backend-api",
		});
		const defaultCodexModel = makeModel("openai-codex", "gpt-5.5", "openai-codex-responses", {
			baseUrl: "https://chatgpt.com/backend-api",
		});
		const captured: CapturedRequest[] = [];
		const registry = makeRegistry({
			available: [nonDefaultCodexModel, defaultCodexModel, activeModel],
			keys: { "openai-codex": makeCodexToken("acct_codex_images") },
		});

		setPreferredImageProvider("openai-codex");
		const result = await runImageTool({
			model: activeModel,
			registry,
			fetchImpl: createCapturingFetch(captured, { sse: true }),
		});

		expect(captured).toHaveLength(1);
		const request = captured[0];
		if (!request) throw new Error("Expected an OpenAI Codex image request");
		expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(request.headers.get("chatgpt-account-id")).toBe("acct_codex_images");
		expect(request.body).toMatchObject({ model: "gpt-5.5" });
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.model).toBe("gpt-5.5");
	});

	it("falls through to the existing auto OpenAI path when preferred OpenAI Codex has no suitable model or key", async () => {
		const activeModel = makeModel("openai", "gpt-4.1", "openai-responses", {
			baseUrl: "https://api.openai.com/v1",
		});
		const captured: CapturedRequest[] = [];
		const registry = makeRegistry({
			available: [activeModel],
			keys: { openai: "sk-openai-test" },
		});

		setPreferredImageProvider("openai-codex");
		const result = await runImageTool({ model: activeModel, registry, fetchImpl: createCapturingFetch(captured) });

		expect(captured).toHaveLength(1);
		expect(captured[0]?.body).toMatchObject({ model: "gpt-4.1" });
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.model).toBe("gpt-4.1");
	});

	it("routes a non-OpenAI session to Codex under the default auto order", async () => {
		const activeModel = makeModel("anthropic", "claude-opus-4-1", "anthropic-messages");
		const openaiModel = makeModel("openai", "gpt-4.1", "openai-responses", {
			baseUrl: "https://api.openai.com/v1",
		});
		const codexModel = makeModel("openai-codex", "gpt-5.5", "openai-codex-responses", {
			baseUrl: "https://chatgpt.com/backend-api",
		});
		const captured: CapturedRequest[] = [];
		const registry = makeRegistry({
			available: [openaiModel, codexModel, activeModel],
			// Both backends are usable; the auto order must still pick Codex.
			keys: { openai: "sk-openai-test", "openai-codex": makeCodexToken("acct_codex_auto") },
		});

		const result = await runImageTool({
			model: activeModel,
			registry,
			fetchImpl: createCapturingFetch(captured, { sse: true }),
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.model).toBe("gpt-5.5");
	});

	it("does not let the session's own OpenAI provider shadow a connected Codex subscription", async () => {
		const activeModel = makeModel("openai", "gpt-4.1", "openai-responses", {
			baseUrl: "https://api.openai.com/v1",
		});
		const codexModel = makeModel("openai-codex", "gpt-5.5", "openai-codex-responses", {
			baseUrl: "https://chatgpt.com/backend-api",
		});
		const captured: CapturedRequest[] = [];
		const registry = makeRegistry({
			available: [activeModel, codexModel],
			keys: { openai: "sk-openai-test", "openai-codex": makeCodexToken("acct_codex_priority") },
		});

		const result = await runImageTool({
			model: activeModel,
			registry,
			fetchImpl: createCapturingFetch(captured, { sse: true }),
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.headers.get("chatgpt-account-id")).toBe("acct_codex_priority");
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.model).toBe("gpt-5.5");
	});

	it("still honors an explicit configured order ahead of Codex", async () => {
		const activeModel = makeModel("openai", "gpt-4.1", "openai-responses", {
			baseUrl: "https://api.openai.com/v1",
		});
		const codexModel = makeModel("openai-codex", "gpt-5.5", "openai-codex-responses", {
			baseUrl: "https://chatgpt.com/backend-api",
		});
		const captured: CapturedRequest[] = [];
		const registry = makeRegistry({
			available: [activeModel, codexModel],
			keys: { openai: "sk-openai-test", "openai-codex": makeCodexToken("acct_codex_cfg") },
		});

		// An explicit list is authoritative: Codex stays available but must not
		// preempt a provider the user put first.
		setImageProviderOrder(["openai"]);
		const result = await runImageTool({ model: activeModel, registry, fetchImpl: createCapturingFetch(captured) });

		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://api.openai.com/v1/responses");
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.model).toBe("gpt-4.1");
	});
});
