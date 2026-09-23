import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

// Clear every env var the providers under test alias, so ambient shell / ~/.env
// state can't leak an env origin into precedence assertions.
const SUPPRESS_ENV = {
	OPENAI_API_KEY: undefined,
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
	COPILOT_GITHUB_TOKEN: undefined,
} as const;

describe("AuthStorage.keys.source", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let auth: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-origin-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		auth = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("undefined when no auth is configured", async () => {
		await withEnv(SUPPRESS_ENV, () => {
			// Provider absent from the env map entirely — no env fallback can apply.
			expect(auth?.keys.source("no-such-provider")).toBeUndefined();
		});
	});

	test("env origin carries the backing variable name for single-var providers", async () => {
		await withEnv({ ...SUPPRESS_ENV, COPILOT_GITHUB_TOKEN: "ghp_fake" }, () => {
			expect(auth?.keys.source("github-copilot")).toEqual({
				kind: "env",
				envVar: "COPILOT_GITHUB_TOKEN",
				concrete: true,
			});
		});
	});

	test("env origin omits the variable name for computed resolvers", async () => {
		// anthropic resolves through $pickenv(...) — no single variable describes it.
		await withEnv({ ...SUPPRESS_ENV, ANTHROPIC_API_KEY: "sk-fake" }, () => {
			expect(auth?.keys.source("anthropic")).toEqual({ kind: "env", concrete: true });
		});
	});

	test("a stored OAuth credential outranks an env var", async () => {
		await withEnv({ ...SUPPRESS_ENV, COPILOT_GITHUB_TOKEN: "ghp_fake" }, async () => {
			await auth?.credentials.set("github-copilot", [
				{ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
			]);
			expect(auth?.keys.source("github-copilot")).toEqual({ kind: "oauth", concrete: true });
		});
	});

	test("a stored OAuth credential outranks a co-stored api key", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			// keys.get() resolves stored OAuth before a stored api_key, so the source must match.
			await auth?.credentials.set("openai", [
				{ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
				{ type: "api_key", key: "sk-stored" },
			]);
			expect(auth?.keys.source("openai")).toEqual({ kind: "oauth", concrete: true });
		});
	});

	test("an explicit env var outranks a stored api key", async () => {
		// Regression: a live env var is the user's current choice and must win over a stored
		// static api_key (e.g. a stale broker-migrated copy) so `GEMINI_API_KEY` etc. take effect.
		await withEnv({ ...SUPPRESS_ENV, OPENAI_API_KEY: "sk-env" }, async () => {
			await auth?.credentials.set("openai", [{ type: "api_key", key: "sk-stored" }]);
			expect(auth?.keys.source("openai")).toEqual({ kind: "env", envVar: "OPENAI_API_KEY", concrete: true });
			expect(await auth?.keys.get("openai")).toBe("sk-env");
		});
	});

	test("getApiKeyWithOrigin reports the same branch that returned the key", async () => {
		await withEnv({ ...SUPPRESS_ENV, OPENAI_API_KEY: "sk-env" }, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("openai", [{ type: "api_key", key: "sk-stored" }]);
			expect(await auth.keys.withOrigin("openai")).toEqual({
				apiKey: "sk-env",
				origin: { kind: "env", envVar: "OPENAI_API_KEY" },
			});
		});
	});

	test("getApiKeyWithOrigin reports OAuth when stored OAuth returns the key", async () => {
		await withEnv({ ...SUPPRESS_ENV, ANTHROPIC_API_KEY: "sk-env" }, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("anthropic", [
				{ type: "oauth", access: "sk-ant-oat-test", refresh: "refresh", expires: Date.now() + 3_600_000 },
			]);
			expect(await auth.keys.withOrigin("anthropic")).toEqual({
				apiKey: "sk-ant-oat-test",
				origin: { kind: "oauth" },
			});
		});
	});

	test("config then runtime overrides take precedence over stored credentials", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("openai", [{ type: "api_key", key: "sk-stored" }]);
			expect(auth.keys.source("openai")).toEqual({ kind: "api_key", concrete: true });

			auth.keys.setConfig("openai", "gateway-bearer");
			expect(auth.keys.source("openai")).toEqual({ kind: "config", concrete: true });

			auth.keys.setRuntime("openai", "cli-flag-bearer");
			expect(auth.keys.source("openai")).toEqual({ kind: "runtime", concrete: true });
		});
	});

	test("config API key is the fallback when login API key cannot be resolved", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!store) throw new Error("test setup failed");
			auth = new AuthStorage(store, {
				configValueResolver: async config => (config === "missing-login-key" ? undefined : config),
			});
			await auth.credentials.set("anthropic", [{ type: "api_key", key: "missing-login-key", source: "login" }]);
			auth.keys.setConfig("anthropic", "gateway-key");

			expect(await auth.keys.withOrigin("anthropic")).toEqual({
				apiKey: "gateway-key",
				origin: { kind: "config" },
			});
			expect(await auth.keys.peek("anthropic")).toBe("gateway-key");
			expect(auth.keys.source("anthropic")).toEqual({ kind: "config", concrete: true });
			expect(auth.keys.describe("anthropic")).toContain("config");
		});
	});

	test("config API key is the fallback when stored static API key cannot be resolved", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!store) throw new Error("test setup failed");
			auth = new AuthStorage(store, {
				configValueResolver: async config => (config === "missing-static-key" ? undefined : config),
			});
			await auth.credentials.set("anthropic", [{ type: "api_key", key: "missing-static-key" }]);
			auth.keys.setConfig("anthropic", "gateway-key");

			expect(await auth.keys.withOrigin("anthropic")).toEqual({
				apiKey: "gateway-key",
				origin: { kind: "config" },
			});
			expect(await auth.keys.peek("anthropic")).toBe("gateway-key");
			expect(auth.keys.source("anthropic")).toEqual({ kind: "config", concrete: true });
			expect(auth.keys.describe("anthropic")).toContain("config");
		});
	});

	test("config API key beats OAuth for anthropic credential resolution", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "sk-ant-oat-oauth",
					refresh: "refresh",
					expires: Date.now() + 3_600_000,
					accountId: "acct-oauth",
				},
			]);
			auth.keys.setConfig("anthropic", "gateway-key");

			expect(await auth.keys.withOrigin("anthropic")).toEqual({
				apiKey: "gateway-key",
				origin: { kind: "config" },
			});
		});
	});

	test("preferOAuth treats a config API key as fallback without changing default precedence", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "sk-ant-oat-preferred",
					refresh: "refresh",
					expires: Date.now() + 3_600_000,
				},
			]);
			auth.keys.setConfig("anthropic", "gateway-fallback");

			expect(await auth.keys.withOrigin("anthropic", undefined, { preferOAuth: true })).toEqual({
				apiKey: "sk-ant-oat-preferred",
				origin: { kind: "oauth" },
			});

			await auth.credentials.set("anthropic", []);
			expect(await auth.keys.withOrigin("anthropic", undefined, { preferOAuth: true })).toEqual({
				apiKey: "gateway-fallback",
				origin: { kind: "config" },
			});
		});
	});

	test("runtime API key beats OAuth and config while suppressing OAuth helpers", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "sk-ant-oat-oauth",
					refresh: "refresh",
					expires: Date.now() + 3_600_000,
					accountId: "acct-oauth",
				},
			]);
			auth.keys.setConfig("anthropic", "gateway-key");
			auth.keys.setRuntime("anthropic", "runtime-key");

			expect(await auth.keys.withOrigin("anthropic")).toEqual({
				apiKey: "runtime-key",
				origin: { kind: "runtime" },
			});
			expect(auth.oauth.accountId("anthropic")).toBeUndefined();
			expect(await auth.oauth.accounts("anthropic")).toEqual([]);
			expect(await auth.oauth.access("anthropic")).toBeUndefined();
		});
	});

	test("config API key beats OAuth origin and source description", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "sk-ant-oat-oauth",
					refresh: "refresh",
					expires: Date.now() + 3_600_000,
					accountId: "acct-oauth",
				},
			]);
			expect(auth.keys.source("anthropic")).toEqual({ kind: "oauth", concrete: true });
			expect(auth.keys.describe("anthropic")).toContain("oauth");

			auth.keys.setConfig("anthropic", "gateway-key");

			expect(auth.keys.source("anthropic")).toEqual({ kind: "config", concrete: true });
			expect(auth.keys.describe("anthropic")).toBe("config override (models.yml)");
		});
	});

	test("OAuth helpers suppress active OAuth when config API key is present", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "sk-ant-oat-oauth",
					refresh: "refresh",
					expires: Date.now() + 3_600_000,
					accountId: "acct-oauth",
				},
			]);
			expect(auth.oauth.accountId("anthropic")).toBe("acct-oauth");
			expect(await auth.oauth.accounts("anthropic")).toEqual([expect.objectContaining({ accountId: "acct-oauth" })]);
			expect(await auth.oauth.access("anthropic")).toEqual(
				expect.objectContaining({
					accessToken: "sk-ant-oat-oauth",
					accountId: "acct-oauth",
				}),
			);

			auth.keys.setConfig("anthropic", "gateway-key");

			expect(auth.oauth.accountId("anthropic")).toBeUndefined();
			expect(await auth.oauth.accounts("anthropic")).toEqual([expect.objectContaining({ accountId: "acct-oauth" })]);
			expect(await auth.oauth.access("anthropic")).toBeUndefined();
		});
	});

	test("config API key is the fallback when OAuth is expired", async () => {
		await withEnv(SUPPRESS_ENV, async () => {
			if (!auth) throw new Error("test setup failed");
			await auth.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "sk-ant-oat-expired",
					refresh: "refresh",
					expires: Date.now() - 60_000,
					accountId: "acct-expired",
				},
			]);
			auth.keys.setConfig("anthropic", "gateway-key");
			expect(auth.oauth.accountId("anthropic")).toBeUndefined();

			expect(await auth.keys.withOrigin("anthropic")).toEqual({
				apiKey: "gateway-key",
				origin: { kind: "config" },
			});
			expect(auth.keys.source("anthropic")).toEqual({ kind: "config", concrete: true });
			expect(auth.keys.describe("anthropic")).toContain("config");
		});
	});
});
