import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

const HOUR_MS = 60 * 60 * 1000;
const SOURCE_ID = "auth-storage-refresh-matching-test";
const API = "auth-storage-refresh-matching-test" as Api;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(text => ({ type: "text" as const, text })),
		api: API,
		provider: "openai-codex",
		model: "test-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function model(): Model<Api> {
	return buildModel({
		id: "test-model",
		name: "test-model",
		api: API,
		provider: "openai-codex",
		baseUrl: "mock://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 1024,
	});
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

describe("AuthStorage.refreshCredentialMatching", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-refresh-match-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		unregisterCustomApis(SOURCE_ID);
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("force-refreshes the matching OAuth credential and returns a fresh access token", async () => {
		if (!store) throw new Error("test setup failed");
		const refreshCalls: Array<{ id: number; refresh: string }> = [];
		authStorage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, credentialId, credential) => {
				refreshCalls.push({ id: credentialId, refresh: credential.refresh });
				return {
					access: "codex-fresh-access",
					refresh: "codex-fresh-refresh",
					expires: Date.now() + HOUR_MS,
					accountId: credential.accountId,
				};
			},
		});
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "codex-stale-access",
				refresh: "codex-refresh",
				expires: Date.now() + HOUR_MS,
				accountId: "acct-a",
			},
		]);
		const credentialId = store.listAuthCredentials("openai-codex")[0]!.id;

		const newKey = await authStorage.refreshCredentialMatching("openai-codex", "codex-stale-access");

		expect(newKey).toBe("codex-fresh-access");
		expect(newKey).not.toBe("codex-stale-access");
		// Force-refresh ran exactly once against the latest persisted refresh token.
		expect(refreshCalls).toEqual([{ id: credentialId, refresh: "codex-refresh" }]);

		// The stored credential was rotated in place — same row, fresh access + refresh.
		const stored = store.listAuthCredentials("openai-codex");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.id).toBe(credentialId);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.access).toBe("codex-fresh-access");
			expect(stored[0].credential.refresh).toBe("codex-fresh-refresh");
		}
	});

	test("returns undefined and does not refresh when no credential matches the key", async () => {
		if (!store) throw new Error("test setup failed");
		let refreshed = false;
		authStorage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, _credentialId, credential) => {
				refreshed = true;
				return { access: "unused", refresh: credential.refresh, expires: Date.now() + HOUR_MS };
			},
		});
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "codex-access",
				refresh: "codex-refresh",
				expires: Date.now() + HOUR_MS,
				accountId: "acct-a",
			},
		]);

		const result = await authStorage.refreshCredentialMatching("openai-codex", "some-other-token");

		expect(result).toBeUndefined();
		expect(refreshed).toBe(false);
	});

	test("returns undefined without disabling the row when the force-refresh fails", async () => {
		if (!store) throw new Error("test setup failed");
		authStorage = new AuthStorage(store, {
			refreshOAuthCredential: async () => {
				throw new Error(
					'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token invalid"}',
				);
			},
		});
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "codex-stale-access",
				refresh: "dead-refresh",
				expires: Date.now() + HOUR_MS,
				accountId: "acct-a",
			},
		]);
		const credentialId = store.listAuthCredentials("openai-codex")[0]!.id;

		const result = await authStorage.refreshCredentialMatching("openai-codex", "codex-stale-access");

		expect(result).toBeUndefined();
		// The matched row MUST stay active and unchanged: the caller handles the
		// fallback rotation, this method never disables the credential.
		const stored = store.listAuthCredentials("openai-codex");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.id).toBe(credentialId);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.access).toBe("codex-stale-access");
			expect(stored[0].credential.refresh).toBe("dead-refresh");
		}
	});

	test("recovers a stale-access account end-to-end through streamSimple's auth retry", async () => {
		if (!store) throw new Error("test setup failed");
		authStorage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, _credentialId, credential) => ({
				access: "codex-fresh-access",
				refresh: "codex-fresh-refresh",
				expires: Date.now() + HOUR_MS,
				accountId: credential.accountId,
			}),
		});
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "codex-stale-access",
				refresh: "codex-refresh",
				expires: Date.now() + HOUR_MS,
				accountId: "acct-a",
			},
		]);

		const seenKeys: Array<string | undefined> = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				seenKeys.push(typeof options?.apiKey === "string" ? options.apiKey : undefined);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (options?.apiKey === "codex-stale-access") {
						// Mirror the codex provider's 401-tagged invalidated-token failure.
						stream.fail(
							Object.assign(new Error("Encountered invalidated oauth token for user, failing request"), {
								status: 401,
							}),
						);
						return;
					}
					const message = assistant(["ok"]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		let authErrors = 0;
		const stream = streamSimple(model(), context, {
			apiKey: async ({ error }) => {
				if (error === undefined) return "codex-stale-access";
				authErrors += 1;
				return authStorage!.refreshCredentialMatching("openai-codex", "codex-stale-access");
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		// First attempt used the stale token (failed 401), retry used the freshly minted token.
		expect(seenKeys).toEqual(["codex-stale-access", "codex-fresh-access"]);
		expect(authErrors).toBe(1);
	});
});
