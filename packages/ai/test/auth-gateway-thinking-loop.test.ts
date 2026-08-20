import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { THINKING_LOOP_ERROR_MARKER } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { logger } from "@oh-my-pi/pi-utils";

/** A degenerate near-duplicate reasoning loop (the gemini-3.5-flash shape). */
function loopThinking(): string {
	const variants = [
		"I am now verifying the test module to guarantee there are no compile errors and the code is completely safe.",
		"I am now verifying the test module once more to ensure there are no compile errors and the code stays completely safe.",
		"I am now re-verifying the test module to confirm there are no compile errors and the code remains completely safe.",
	];
	const out: string[] = [];
	for (let i = 0; i < 12; i++) out.push(`**Confirming Safety ${i}**\n\n${variants[i % variants.length]}`);
	return out.join("\n\n\n");
}

const AUDIT_PROMPT = "AUDIT_SECRET_PROMPT_BODY";
const EXPECTED_MOCK_USAGE = { input: 11, output: 7, cacheRead: 3, cacheWrite: 5, totalTokens: 31, reasoningTokens: 2 };

const ANTHROPIC_LOW_CREDIT_MESSAGE =
	"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const OAUTH_CREDENTIAL_A = "anthropic-oauth-test-a";
const OAUTH_CREDENTIAL_B = "anthropic-oauth-test-b";
const LOW_CREDIT_SESSION = "anthropic-low-credit-session";
const CONFIG_API_KEY_FALLBACK = "anthropic-config-fallback";

function upstreamHttpError(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

async function storeAnthropicCredentialPair(storage: AuthStorage): Promise<void> {
	await storage.set("anthropic", [
		{
			type: "oauth",
			access: OAUTH_CREDENTIAL_A,
			refresh: "refresh-low-credit-a",
			expires: Date.now() + 3_600_000,
			accountId: "account-low-credit-a",
		},
		{
			type: "oauth",
			access: OAUTH_CREDENTIAL_B,
			refresh: "refresh-low-credit-b",
			expires: Date.now() + 3_600_000,
			accountId: "account-low-credit-b",
		},
	]);
	storage.setConfigApiKey("anthropic", CONFIG_API_KEY_FALLBACK);
}

function postChat(handleUrl: string, model: string, stream: boolean): Promise<Response> {
	return fetch(`${handleUrl}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hi" }],
			stream,
			prompt_cache_key: LOW_CREDIT_SESSION,
		}),
	});
}
const EXPECTED_AUDIT_USAGE = {
	inputTokens: 11,
	outputTokens: 7,
	cacheReadTokens: 3,
	cacheWriteTokens: 5,
	totalTokens: 31,
	reasoningTokens: 2,
};

function auditPayloads(calls: ReadonlyArray<readonly unknown[]>): Record<string, unknown>[] {
	return calls.filter(call => call[0] === "auth-gateway request").map(call => call[1] as Record<string, unknown>);
}

function expectAuditPayload(payload: Record<string, unknown>, expected: Record<string, unknown>): void {
	expect(typeof payload.requestId).toBe("string");
	expect((payload.requestId as string).length).toBeGreaterThan(0);
	expect(typeof payload.durationMs).toBe("number");
	expect(payload.durationMs as number).toBeGreaterThanOrEqual(0);
	expect(payload).toMatchObject(expected);
}

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway non-streaming thinking-loop retries", () => {
	it("returns an error after three guarded looping attempts", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-thinking-loop-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
		for (let i = 0; i < 4; i++) {
			mock.push({ content: [{ type: "thinking", thinking: loopThinking() }, "Unreachable cooked answer."] });
		}
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "google/gemini-3.5-flash",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});
			const body = (await res.json()) as { error?: unknown };

			expect(res.status).toBe(502);
			expect(body.error).toBeDefined();
			expect(mock.calls).toHaveLength(3);
			expect(mock.calls.every(call => call.options?.loopGuard?.enabled !== false)).toBe(true);
		} finally {
			waitSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("still surfaces a non-loop upstream error as a 502", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-thinking-loop-err-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" });
		mock.push({ throw: "upstream exploded" });
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "google/gemini-3.5-flash",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			// A genuine error is never a loop stall, so loop retry handling must not mask it.
			expect(res.status).toBe(502);
			expect(mock.calls).toHaveLength(1);
			expect(THINKING_LOOP_ERROR_MARKER.length).toBeGreaterThan(0);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps the attempted OAuth audit origin when auth fallback resolves the same bearer", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-auth-same-bearer-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		await storage.set("anthropic", [
			{
				type: "oauth",
				access: OAUTH_CREDENTIAL_A,
				refresh: "refresh-same-bearer",
				expires: Date.now() + 3_600_000,
				accountId: "account-same-bearer",
			},
		]);
		storage.setConfigApiKey("anthropic", OAUTH_CREDENTIAL_A);
		const originalGetApiKeyWithOrigin = storage.getApiKeyWithOrigin.bind(storage);
		const resolutionSpy = spyOn(storage, "getApiKeyWithOrigin").mockImplementation(
			async (provider, sessionId, options) => {
				if (options?.forceRefresh) {
					return { apiKey: OAUTH_CREDENTIAL_A, origin: { kind: "config" } };
				}
				return originalGetApiKeyWithOrigin(provider, sessionId, options);
			},
		);
		const mock = createMockModel({
			provider: "anthropic",
			id: "claude-auth-same-bearer",
			handler: () => {
				throw upstreamHttpError(401, "Invalid authentication credentials");
			},
		});
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const response = await postChat(handle.url, mock.id, false);
			await response.text();

			expect(response.status).toBe(401);
			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([OAUTH_CREDENTIAL_A]);
			expect(auditPayloads(infoSpy.mock.calls)).toMatchObject([
				{ credentialOrigin: "oauth", credentialAuthType: "oauth", status: 401 },
			]);
		} finally {
			resolutionSpy.mockRestore();
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not cycle back to a credential that already failed earlier in the request", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-auth-key-cycle-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const resolutions = [
			{ apiKey: OAUTH_CREDENTIAL_A, origin: { kind: "config" as const } },
			{ apiKey: OAUTH_CREDENTIAL_B, origin: { kind: "oauth" as const } },
			{ apiKey: OAUTH_CREDENTIAL_A, origin: { kind: "config" as const } },
		];
		const resolutionSpy = spyOn(storage, "getApiKeyWithOrigin").mockImplementation(async () => resolutions.shift());
		const mock = createMockModel({
			provider: "anthropic",
			id: "claude-auth-key-cycle",
			handler: () => {
				throw upstreamHttpError(401, "Invalid authentication credentials");
			},
		});
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const response = await postChat(handle.url, mock.id, false);
			await response.text();

			expect(response.status).toBe(401);
			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([OAUTH_CREDENTIAL_A, OAUTH_CREDENTIAL_B]);
			expect(auditPayloads(infoSpy.mock.calls)).toMatchObject([
				{ credentialOrigin: "oauth", credentialAuthType: "oauth", status: 401 },
			]);
		} finally {
			infoSpy.mockRestore();
			resolutionSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps the attempted OAuth audit origin when low-credit fallback resolves the same bearer", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-low-credit-same-bearer-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"), {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		await storage.set("anthropic", [
			{
				type: "oauth",
				access: OAUTH_CREDENTIAL_A,
				refresh: "refresh-low-credit-same-bearer",
				expires: Date.now() + 3_600_000,
				accountId: "account-low-credit-same-bearer",
			},
		]);
		storage.setConfigApiKey("anthropic", OAUTH_CREDENTIAL_A);
		const mock = createMockModel({
			provider: "anthropic",
			id: "claude-low-credit-same-bearer",
			handler: () => {
				throw upstreamHttpError(400, ANTHROPIC_LOW_CREDIT_MESSAGE);
			},
		});
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const response = await postChat(handle.url, mock.id, false);
			await response.text();

			expect(response.status).toBe(400);
			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([OAUTH_CREDENTIAL_A]);
			expect(auditPayloads(infoSpy.mock.calls)).toMatchObject([
				{ credentialOrigin: "oauth", credentialAuthType: "oauth", status: 400 },
			]);
		} finally {
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("logs credential origin and auth type without exposing the token", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-credential-log-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const token = "sk-ant-oat-test-token";
		const user = "sensitive-user@example.com";
		const previousResponseId = "resp-sensitive-chain-id";
		storage.setRuntimeApiKey("anthropic", token);
		const mock = createMockModel({ provider: "anthropic", id: "claude-test" });
		mock.push({ content: ["ok"], usage: EXPECTED_MOCK_USAGE });
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "claude-test",
					input: "hi",
					stream: false,
					user,
					previous_response_id: previousResponseId,
				}),
			});

			expect(res.status).toBe(200);
			const requestLog = infoSpy.mock.calls.find(([message]) => message === "auth-gateway request");
			expect(requestLog?.[1]).toMatchObject({
				resolvedProvider: "anthropic",
				resolvedModel: "claude-test",
				credentialOrigin: "runtime",
				credentialAuthType: "oauth",
			});
			expect(JSON.stringify(requestLog)).not.toContain(token);
			const unsupportedOptionsLog = debugSpy.mock.calls.find(
				([message]) => message === "auth-gateway dropped unsupported typed options",
			);
			expect(unsupportedOptionsLog?.[1]).toMatchObject({ hasPreviousResponseId: true, hasUser: true });
			expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(user);
			expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(previousResponseId);
		} finally {
			debugSpy.mockRestore();
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("logs stored OAuth over the gateway config fallback without exposing either secret", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-oauth-config-credential-log-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const oauthToken = "sk-ant-oat-stored-oauth-token";
		const configApiKey = "gateway-key";
		await storage.set("anthropic", [
			{
				type: "oauth",
				access: oauthToken,
				refresh: "refresh-stored-oauth",
				expires: Date.now() + 3_600_000,
				accountId: "acct-stored-oauth",
			},
		]);
		storage.setConfigApiKey("anthropic", configApiKey);
		const mock = createMockModel({ provider: "anthropic", id: "claude-test" });
		mock.push({ content: ["ok"], usage: EXPECTED_MOCK_USAGE });
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "claude-test",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			expect(res.status).toBe(200);
			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([oauthToken]);
			const requestLog = infoSpy.mock.calls.find(([message]) => message === "auth-gateway request");
			expect(requestLog?.[1]).toMatchObject({
				resolvedProvider: "anthropic",
				resolvedModel: "claude-test",
				credentialOrigin: "oauth",
				credentialAuthType: "oauth",
			});
			const requestLogJson = JSON.stringify(requestLog);
			expect(requestLogJson).not.toContain(oauthToken);
			expect(requestLogJson).not.toContain(configApiKey);
		} finally {
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("logs credential origin and auth type on pi-native requests", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-credential-log-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const token = "sk-ant-oat-pi-native-test-token";
		storage.setRuntimeApiKey("anthropic", token);
		const mock = createMockModel({ provider: "anthropic", id: "claude-test" });
		mock.push({ content: ["ok"], usage: EXPECTED_MOCK_USAGE });
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					modelId: "claude-test",
					context: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
					stream: false,
				}),
			});

			expect(res.status).toBe(200);
			const requestLog = infoSpy.mock.calls.find(([message]) => message === "auth-gateway request");
			expect(requestLog?.[1]).toMatchObject({
				format: "pi-native",
				resolvedProvider: "anthropic",
				resolvedModel: "claude-test",
				credentialOrigin: "runtime",
				credentialAuthType: "oauth",
			});
			expect(JSON.stringify(requestLog)).not.toContain(token);
		} finally {
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("auth-gateway completion audit logs", () => {
	it("logs one non-streaming chat completion audit with usage and without secrets or prompt body", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-audit-chat-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const token = "sk-openrouter-completion-audit-token";
		storage.setRuntimeApiKey("openrouter", token);
		const mock = createMockModel({ provider: "openrouter", id: "audit-chat-non-stream" });
		mock.push({ content: ["ok"], usage: EXPECTED_MOCK_USAGE });
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "audit-chat-non-stream",
					messages: [{ role: "user", content: AUDIT_PROMPT }],
					stream: false,
				}),
			});
			await res.text();

			expect(res.status).toBe(200);
			const audits = auditPayloads(infoSpy.mock.calls);
			expect(audits).toHaveLength(1);
			expectAuditPayload(audits[0] ?? {}, {
				format: "openai-chat",
				model: "audit-chat-non-stream",
				resolvedProvider: "openrouter",
				resolvedModel: "audit-chat-non-stream",
				stream: false,
				status: 200,
				credentialOrigin: "runtime",
				credentialAuthType: "api_key",
				...EXPECTED_AUDIT_USAGE,
			});
			const auditJson = JSON.stringify(audits[0]);
			expect(auditJson).not.toContain(token);
			expect(auditJson).not.toContain(AUDIT_PROMPT);
		} finally {
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("logs one non-streaming pi-native completion audit with usage and without secrets or prompt body", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-audit-pi-native-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const token = "sk-openrouter-pi-native-audit-token";
		storage.setRuntimeApiKey("openrouter", token);
		const mock = createMockModel({ provider: "openrouter", id: "audit-pi-native-non-stream" });
		mock.push({ content: ["ok"], usage: EXPECTED_MOCK_USAGE });
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					modelId: "audit-pi-native-non-stream",
					context: { messages: [{ role: "user", content: [{ type: "text", text: AUDIT_PROMPT }] }] },
					stream: false,
				}),
			});
			await res.text();

			expect(res.status).toBe(200);
			const audits = auditPayloads(infoSpy.mock.calls);
			expect(audits).toHaveLength(1);
			expectAuditPayload(audits[0] ?? {}, {
				format: "pi-native",
				model: "audit-pi-native-non-stream",
				resolvedProvider: "openrouter",
				resolvedModel: "audit-pi-native-non-stream",
				stream: false,
				status: 200,
				credentialOrigin: "runtime",
				credentialAuthType: "api_key",
				...EXPECTED_AUDIT_USAGE,
			});
			const auditJson = JSON.stringify(audits[0]);
			expect(auditJson).not.toContain(token);
			expect(auditJson).not.toContain(AUDIT_PROMPT);
		} finally {
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("waits to log a streaming chat completion audit until the SSE body is fully drained", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-audit-stream-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "audit-chat-stream" });
		mock.push({ content: ["stream ok"], usage: EXPECTED_MOCK_USAGE });
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "audit-chat-stream",
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			});
			expect(res.status).toBe(200);

			const body = await res.text();
			expect(body).toContain("[DONE]");
			const audits = auditPayloads(infoSpy.mock.calls);
			expect(audits).toHaveLength(1);
			expectAuditPayload(audits[0] ?? {}, {
				format: "openai-chat",
				model: "audit-chat-stream",
				resolvedProvider: "openrouter",
				resolvedModel: "audit-chat-stream",
				stream: true,
				status: 200,
				...EXPECTED_AUDIT_USAGE,
			});
		} finally {
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("logs a non-streaming upstream failure audit with error status and without secrets or prompt body", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-audit-failure-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const token = "sk-openrouter-failure-audit-token";
		storage.setRuntimeApiKey("openrouter", token);
		const mock = createMockModel({ provider: "openrouter", id: "audit-chat-upstream-failure" });
		mock.push({ throw: "audit upstream exploded" });
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "audit-chat-upstream-failure",
					messages: [{ role: "user", content: AUDIT_PROMPT }],
					stream: false,
				}),
			});
			await res.text();

			expect(res.status).toBe(502);
			const audits = auditPayloads(infoSpy.mock.calls);
			expect(audits).toHaveLength(1);
			expectAuditPayload(audits[0] ?? {}, {
				format: "openai-chat",
				model: "audit-chat-upstream-failure",
				resolvedProvider: "openrouter",
				resolvedModel: "audit-chat-upstream-failure",
				stream: false,
				status: 502,
				reason: "error",
			});
			const auditJson = JSON.stringify(audits[0]);
			expect(auditJson).not.toContain(token);
			expect(auditJson).not.toContain(AUDIT_PROMPT);
		} finally {
			infoSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("auth-gateway Anthropic low-credit credential failover", () => {
	it("rotates a non-streaming request to the next OAuth credential and keeps the session there", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-low-credit-non-stream-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"), {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		await storeAnthropicCredentialPair(storage);
		const mock = createMockModel({
			provider: "anthropic",
			id: "claude-low-credit-non-stream",
			handler: (_context, options) => {
				if (options?.apiKey === OAUTH_CREDENTIAL_A) {
					throw upstreamHttpError(400, ANTHROPIC_LOW_CREDIT_MESSAGE);
				}
				if (options?.apiKey !== OAUTH_CREDENTIAL_B) throw new Error("unexpected test credential");
				return { content: ["non-streaming rotated success"], usage: EXPECTED_MOCK_USAGE };
			},
		});
		const usageLimitSpy = spyOn(storage, "markUsageLimitReached");
		const invalidateSpy = spyOn(storage, "invalidateCredentialMatching");
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const first = await postChat(handle.url, mock.id, false);
			const firstBody = (await first.json()) as {
				error?: unknown;
				choices?: Array<{ message?: { content?: string | null } }>;
			};

			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([OAUTH_CREDENTIAL_A, OAUTH_CREDENTIAL_B]);
			expect(first.status).toBe(200);
			expect(firstBody.error).toBeUndefined();
			expect(firstBody.choices?.[0]?.message?.content).toBe("non-streaming rotated success");
			expect(usageLimitSpy).toHaveBeenCalledTimes(1);
			expect(usageLimitSpy).toHaveBeenCalledWith(
				"anthropic",
				LOW_CREDIT_SESSION,
				expect.objectContaining({ apiKey: OAUTH_CREDENTIAL_A, modelId: mock.id }),
			);
			expect(invalidateSpy).toHaveBeenCalledTimes(0);

			const second = await postChat(handle.url, mock.id, false);
			const secondBody = (await second.json()) as {
				choices?: Array<{ message?: { content?: string | null } }>;
			};
			expect(second.status).toBe(200);
			expect(secondBody.choices?.[0]?.message?.content).toBe("non-streaming rotated success");
			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([
				OAUTH_CREDENTIAL_A,
				OAUTH_CREDENTIAL_B,
				OAUTH_CREDENTIAL_B,
			]);
			expect(usageLimitSpy).toHaveBeenCalledTimes(1);
			expect(invalidateSpy).toHaveBeenCalledTimes(0);

			const serializedLogs = JSON.stringify([infoSpy.mock.calls, warnSpy.mock.calls, debugSpy.mock.calls]);
			expect(serializedLogs.includes(OAUTH_CREDENTIAL_A)).toBe(false);
			expect(serializedLogs.includes(OAUTH_CREDENTIAL_B)).toBe(false);
		} finally {
			debugSpy.mockRestore();
			warnSpy.mockRestore();
			infoSpy.mockRestore();
			invalidateSpy.mockRestore();
			usageLimitSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("replays a pre-output streaming failure with the next OAuth credential and emits only successful SSE", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-low-credit-stream-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"), {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		await storeAnthropicCredentialPair(storage);
		const mock = createMockModel({
			provider: "anthropic",
			id: "claude-low-credit-stream",
			handler: (_context, options) => {
				if (options?.apiKey === OAUTH_CREDENTIAL_A) {
					throw upstreamHttpError(400, ANTHROPIC_LOW_CREDIT_MESSAGE);
				}
				if (options?.apiKey !== OAUTH_CREDENTIAL_B) throw new Error("unexpected test credential");
				return { content: ["streaming rotated success"], usage: EXPECTED_MOCK_USAGE };
			},
		});
		const usageLimitSpy = spyOn(storage, "markUsageLimitReached");
		const invalidateSpy = spyOn(storage, "invalidateCredentialMatching");
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const response = await postChat(handle.url, mock.id, true);
			const body = await response.text();
			const frames = body
				.trim()
				.split("\n\n")
				.map(frame => {
					expect(frame).toStartWith("data: ");
					const data = frame.slice("data: ".length);
					return data === "[DONE]" ? data : JSON.parse(data);
				});

			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([OAUTH_CREDENTIAL_A, OAUTH_CREDENTIAL_B]);
			expect(response.status).toBe(200);
			expect(frames).toHaveLength(4);
			expect(frames[3]).toBe("[DONE]");
			expect(
				(frames.slice(0, 3) as Array<{ choices: Array<{ delta: unknown; finish_reason: string | null }> }>).map(
					frame => ({
						delta: frame.choices[0]?.delta,
						finishReason: frame.choices[0]?.finish_reason,
					}),
				),
			).toEqual([
				{ delta: { role: "assistant" }, finishReason: null },
				{ delta: { content: "streaming rotated success" }, finishReason: null },
				{ delta: {}, finishReason: "stop" },
			]);
			expect(usageLimitSpy).toHaveBeenCalledTimes(1);
			expect(usageLimitSpy).toHaveBeenCalledWith(
				"anthropic",
				LOW_CREDIT_SESSION,
				expect.objectContaining({ apiKey: OAUTH_CREDENTIAL_A, modelId: mock.id }),
			);
			expect(invalidateSpy).toHaveBeenCalledTimes(0);
		} finally {
			invalidateSpy.mockRestore();
			usageLimitSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the config API key after the only OAuth credential reaches its usage limit", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-low-credit-config-fallback-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"), {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		await storage.set("anthropic", [
			{
				type: "oauth",
				access: OAUTH_CREDENTIAL_A,
				refresh: "refresh-low-credit-a",
				expires: Date.now() + 3_600_000,
				accountId: "account-low-credit-a",
			},
		]);
		storage.setConfigApiKey("anthropic", CONFIG_API_KEY_FALLBACK);
		const mock = createMockModel({
			provider: "anthropic",
			id: "claude-low-credit-config-fallback",
			handler: (_context, options) => {
				if (options?.apiKey === OAUTH_CREDENTIAL_A) {
					throw upstreamHttpError(400, ANTHROPIC_LOW_CREDIT_MESSAGE);
				}
				if (options?.apiKey !== CONFIG_API_KEY_FALLBACK) throw new Error("unexpected test credential");
				return { content: ["config fallback success"], usage: EXPECTED_MOCK_USAGE };
			},
		});
		const usageLimitSpy = spyOn(storage, "markUsageLimitReached");
		const invalidateSpy = spyOn(storage, "invalidateCredentialMatching");
		const infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const response = await postChat(handle.url, mock.id, false);
			const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };

			expect(response.status).toBe(200);
			expect(body.choices?.[0]?.message?.content).toBe("config fallback success");
			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([OAUTH_CREDENTIAL_A, CONFIG_API_KEY_FALLBACK]);
			expect(auditPayloads(infoSpy.mock.calls)).toMatchObject([
				{ credentialOrigin: "config", credentialAuthType: "api_key", status: 200 },
			]);

			const second = await postChat(handle.url, mock.id, false);
			const secondBody = (await second.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
			expect(second.status).toBe(200);
			expect(secondBody.choices?.[0]?.message?.content).toBe("config fallback success");
			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([
				OAUTH_CREDENTIAL_A,
				CONFIG_API_KEY_FALLBACK,
				CONFIG_API_KEY_FALLBACK,
			]);
			expect(auditPayloads(infoSpy.mock.calls)).toMatchObject([
				{ credentialOrigin: "config", credentialAuthType: "api_key", status: 200 },
				{ credentialOrigin: "config", credentialAuthType: "api_key", status: 200 },
			]);
			expect(usageLimitSpy).toHaveBeenCalledTimes(1);
			expect(invalidateSpy).toHaveBeenCalledTimes(0);
		} finally {
			infoSpy.mockRestore();
			invalidateSpy.mockRestore();
			usageLimitSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not rotate stored OAuth credentials for a provider-wide 503", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-provider-503-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"), {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		await storeAnthropicCredentialPair(storage);
		const mock = createMockModel({
			provider: "anthropic",
			id: "claude-provider-503",
			handler: () => {
				throw upstreamHttpError(503, "Service unavailable");
			},
		});
		const usageLimitSpy = spyOn(storage, "markUsageLimitReached");
		const invalidateSpy = spyOn(storage, "invalidateCredentialMatching");
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const response = await postChat(handle.url, mock.id, false);
			await response.text();

			expect(response.status).toBe(503);
			expect(mock.calls.map(call => call.options?.apiKey)).toEqual([OAUTH_CREDENTIAL_A]);
			expect(usageLimitSpy).toHaveBeenCalledTimes(0);
			expect(invalidateSpy).toHaveBeenCalledTimes(0);
		} finally {
			invalidateSpy.mockRestore();
			usageLimitSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("auth-gateway auth retry", () => {
	it("treats structured generic quota errors as usage-limit blocks before invalidating credentials", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-quota-rotation-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
		const storage = new AuthStorage(store);
		await storage.set("mock", [
			{ type: "api_key", key: "quota-key" },
			{ type: "api_key", key: "healthy-key" },
		]);
		const markUsageLimitSpy = spyOn(storage, "markUsageLimitReached");
		const invalidateSpy = spyOn(storage, "invalidateCredentialMatching");
		let attempt = 0;
		const mock = createMockModel({
			provider: "mock",
			id: "gateway-quota-model",
			handler: (_context, options) => {
				attempt += 1;
				if (attempt === 1) {
					throw new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" });
				}
				return { content: [`ok:${options?.apiKey ?? "missing"}`] };
			},
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "gateway-quota-model",
					messages: [{ role: "user", content: "hi" }],
					prompt_cache_key: "gw-quota-rotation",
					stream: false,
				}),
			});
			const body = (await res.json()) as {
				choices?: Array<{ message?: { content?: string | null } }>;
			};
			const attemptedKeys = mock.calls.map(call => call.options?.apiKey);

			expect(res.status).toBe(200);
			expect(attemptedKeys).toHaveLength(2);
			const [failedKey, retriedKey] = attemptedKeys;
			if (typeof failedKey !== "string" || typeof retriedKey !== "string") {
				throw new Error("expected gateway retries to use static API keys");
			}
			expect(body.choices?.[0]?.message?.content).toBe(`ok:${retriedKey}`);
			expect(new Set([failedKey, retriedKey]).size).toBe(2);
			expect(markUsageLimitSpy.mock.calls).toHaveLength(1);
			const usageLimitCall = markUsageLimitSpy.mock.calls[0];
			if (!usageLimitCall) {
				throw new Error("expected usage-limit mark call");
			}
			const [usageLimitProvider, usageLimitSessionId, usageLimitOptions] = usageLimitCall;
			expect(usageLimitProvider).toBe("mock");
			expect(usageLimitSessionId).toBe("gw-quota-rotation");
			expect(usageLimitOptions?.apiKey).toBe(failedKey);
			expect(invalidateSpy.mock.calls).toHaveLength(0);
			expect(store.listAuthCredentials("mock")).toHaveLength(2);
			expect(await storage.getApiKey("mock", "gw-quota-rotation")).toBe(retriedKey);
		} finally {
			markUsageLimitSpy.mockRestore();
			invalidateSpy.mockRestore();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
