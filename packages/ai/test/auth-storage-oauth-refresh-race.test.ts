import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

describe("AuthStorage OAuth refresh race", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let events: CredentialDisabledEvent[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-oauth-race-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		events = [];
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setSystemTime();
		oauthUtils.unregisterOAuthProviders("auth-storage-oauth-refresh-race-test");
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("does not disable a credential another process already rotated", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Seed the shared DB with one expired OAuth credential; this simulates the
		// state two cooperating omp processes both load from the persisted row.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("anthropic");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		// Simulate the peer's successful refresh: another process called the real
		// `#replaceCredentialAt` path, which rotates the row in place via
		// updateAuthCredential. The in-memory snapshot we hold is now stale.
		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "fresh-access-from-peer",
			refresh: "fresh-refresh-from-peer",
			expires: Date.now() + 60 * 60_000,
		});

		// Mock mirrors Anthropic: only the stale refresh token is rejected, because
		// real rotation invalidates the previous refresh token on use.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (credential?.refresh === "stale-refresh") {
				throw new Error(
					'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
				);
			}
			return { newCredentials: credential!, apiKey: credential!.access };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-race");

			// We should have picked up the rotated credential instead of disabling
			// the row that the peer just updated.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);
			expect(authStorage!.list()).toContain("anthropic");

			// The row must still be active in storage; before the fix it would be
			// soft-deleted with disabled_cause set to the invalid_grant error.
			const stored = store!.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
			}
		});
	});

	test("does not disable when peer rotates between pre-check and CAS disable", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("anthropic");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		// Refresh genuinely fails — the pre-check that compares the persisted
		// refresh token to our snapshot will therefore see the SAME stale token
		// and fall through to the disable. We then race a peer rotation into the
		// window between the pre-check and the CAS, which the CAS must detect.
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, creds) => {
			const credential = creds[provider];
			if (credential?.refresh === "stale-refresh") {
				throw new Error(
					'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
				);
			}
			return { newCredentials: credential!, apiKey: credential!.access };
		});

		const sharedStore = store;
		const originalTryDisable = sharedStore.tryDisableAuthCredentialIfMatches.bind(sharedStore);
		const tryDisableSpy = vi
			.spyOn(sharedStore, "tryDisableAuthCredentialIfMatches")
			.mockImplementation((id, expectedData, disabledCause) => {
				// Simulate the peer's successful rotation landing in the window
				// between the pre-check (which saw the stale token) and the CAS
				// disable. The CAS predicate `data = expectedData` must now miss.
				sharedStore.updateAuthCredential(id, {
					type: "oauth",
					access: "fresh-access-from-peer",
					refresh: "fresh-refresh-from-peer",
					expires: Date.now() + 60 * 60_000,
				});
				return originalTryDisable(id, expectedData, disabledCause);
			});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-cas-race");

			// CAS lost → reload → pick up the peer-rotated credential.
			expect(apiKey).toBe("fresh-access-from-peer");
			expect(events).toHaveLength(0);
			expect(tryDisableSpy).toHaveBeenCalled();

			// Row must still be active, with the peer's rotated tokens.
			const stored = sharedStore.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).toBe(credentialId);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("fresh-refresh-from-peer");
				expect(stored[0].credential.access).toBe("fresh-access-from-peer");
			}
		});
	});

	test("still disables when the failure is real (no concurrent rotation)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		// Single-process scenario: refresh genuinely fails and no peer updated the
		// row. The credential should still be soft-deleted.
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const apiKey = await authStorage!.getApiKey("anthropic", "session-real-failure");

			expect(apiKey).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]?.disabledCause).toContain("invalid_grant");
		});
	});
	test("persists every credential refreshed during candidate preflight", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-preflight",
			name: "Unit OAuth Preflight",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: `${credentials.access}-rotated`,
					refresh: `${credentials.refresh}-rotated`,
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-preflight", [
			{ type: "oauth", access: "access-a", refresh: "refresh-a", expires },
			{ type: "oauth", access: "access-b", refresh: "refresh-b", expires },
		]);

		const apiKey = await authStorage.getApiKey("unit-oauth-preflight");
		expect(apiKey).toBe("access-a-rotated");

		const stored = store.listAuthCredentials("unit-oauth-preflight");
		expect(stored).toHaveLength(2);
		const oauth = stored.map(entry => entry.credential).filter(credential => credential.type === "oauth");
		expect(oauth.map(credential => credential.refresh).sort()).toEqual(["refresh-a-rotated", "refresh-b-rotated"]);
	});

	test("coalesces concurrent refreshes for the same credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const expires = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-mutex",
			name: "Unit OAuth Mutex",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-rotated",
					refresh: "refresh-rotated",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-mutex", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);

		const first = authStorage.getApiKey("unit-oauth-mutex", "same-session");
		const second = authStorage.getApiKey("unit-oauth-mutex", "same-session");

		await refreshStarted.promise;
		allowRefresh.resolve();

		await expect(first).resolves.toBe("access-rotated");
		await expect(second).resolves.toBe("access-rotated");
		expect(refreshCalls).toBe(1);
	});

	test("syncs peer-updated SQLite OAuth rows before returning access tokens", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() + 60 * 60_000;
		let refreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-peer-sync",
			name: "Unit OAuth Peer Sync",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: `${credentials.access}-rotated`,
					refresh: `${credentials.refresh}-rotated`,
					expires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-peer-sync", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires },
		]);
		const storedBefore = store.listAuthCredentials("unit-oauth-peer-sync");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;

		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "access-peer",
			refresh: "refresh-peer",
			expires,
		});
		const apiKey = await authStorage.getApiKey("unit-oauth-peer-sync", "session-peer-sync");
		expect(apiKey).toBe("access-peer");
		expect(refreshCalls).toBe(0);

		store.updateAuthCredential(credentialId, {
			type: "oauth",
			access: "access-peer-force",
			refresh: "refresh-peer-force",
			expires,
		});
		const forcedKey = await authStorage.getApiKey("unit-oauth-peer-sync", "session-peer-sync", {
			forceRefresh: true,
		});
		expect(forcedKey).toBe("access-peer-force");
		expect(refreshCalls).toBe(0);
	});

	test("invalidating a session-sticky OAuth credential rotates the retry to another active credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		let sessionId = "";
		for (let index = 0; index < 32; index++) {
			const candidate = `session-auth-retry-${index}`;
			if (Bun.hash.xxHash32(candidate) % 2 === 0) {
				sessionId = candidate;
				break;
			}
		}
		if (!sessionId) throw new Error("could not find test session id");

		await authStorage.set("unit-oauth-rotation", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60 * 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		const firstKey = await authStorage.getApiKey("unit-oauth-rotation", sessionId);
		expect(firstKey).toBe("access-a");

		const invalidated = await authStorage.invalidateCredentialMatching("unit-oauth-rotation", "access-a", {
			sessionId,
		});
		expect(invalidated).toBe(true);

		const retryKey = await authStorage.getApiKey("unit-oauth-rotation", sessionId);
		expect(retryKey).toBe("access-b");
	});

	test("persists a refreshed token by id when a concurrent disable shifts indices", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const now = Date.now();
		// Three distinct expired accounts → index order A, B, C by id ascending.
		await authStorage.set("anthropic", [
			{ type: "oauth", access: "a-acc", refresh: "a-ref", expires: now - 60_000, accountId: "acc-a", email: "a@x" },
			{ type: "oauth", access: "b-acc", refresh: "b-ref", expires: now - 60_000, accountId: "acc-b", email: "b@x" },
			{ type: "oauth", access: "c-acc", refresh: "c-ref", expires: now - 60_000, accountId: "acc-c", email: "c@x" },
		]);
		const seeded = store.listAuthCredentials("anthropic");
		expect(seeded).toHaveLength(3);
		const idA = seeded[0]!.id;
		const idB = seeded[1]!.id;
		const idC = seeded[2]!.id;

		// While B refreshes, a definitive failure disables A — removing index 0 and
		// shifting B from index 1 to index 0. A pre-await positional write would
		// land B's rotated token on C; the id-addressed write must hit B and leave
		// C untouched.
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			if (credential.refresh === "b-ref") {
				authStorage!.disableCredentialById(idA, "test: concurrent disable");
				return {
					access: "b-fresh",
					refresh: "b-fresh-ref",
					expires: now + 60 * 60_000,
					accountId: "acc-b",
					email: "b@x",
				};
			}
			return { ...credential, expires: now + 60 * 60_000 };
		});

		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const refreshed = await authStorage!.forceRefreshCredentialById(idB);
			expect(refreshed.id).toBe(idB);
		});

		const after = store.listAuthCredentials("anthropic");
		const bRow = after.find(row => row.id === idB);
		const cRow = after.find(row => row.id === idC);
		expect(bRow?.credential.type).toBe("oauth");
		if (bRow?.credential.type === "oauth") expect(bRow.credential.refresh).toBe("b-fresh-ref");
		expect(cRow?.credential.type).toBe("oauth");
		if (cRow?.credential.type === "oauth") expect(cRow.credential.refresh).toBe("c-ref");
	});

	test("serializes cross-process refreshes through a SQLite lease", async () => {
		if (!authStorage || !store || !(store instanceof SqliteAuthCredentialStore)) throw new Error("test setup failed");
		vi.useFakeTimers();

		const dbPath = path.join(tempDir, "agent.db");
		const secondStore = await SqliteAuthCredentialStore.open(dbPath);
		const secondAuthStorage = new AuthStorage(secondStore);
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-cross-process-lease",
			name: "Unit OAuth Cross Process Lease",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken() {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return { access: "access-rotated", refresh: "refresh-rotated", expires: refreshedExpires };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		try {
			await authStorage.set("unit-oauth-cross-process-lease", [
				{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
			]);
			await secondAuthStorage.reload();

			const first = authStorage.getApiKey("unit-oauth-cross-process-lease", "lease-a");
			await refreshStarted.promise;
			const second = secondAuthStorage.getApiKey("unit-oauth-cross-process-lease", "lease-b");
			allowRefresh.resolve();

			await expect(first).resolves.toBe("access-rotated");
			vi.advanceTimersByTime(300);
			await Promise.resolve();
			await expect(second).resolves.toBe("access-rotated");
			expect(refreshCalls).toBe(1);

			const stored = secondStore.listAuthCredentials("unit-oauth-cross-process-lease");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.refresh).toBe("refresh-rotated");
			}
		} finally {
			secondAuthStorage.close();
			secondStore.close();
		}
	});

	test("non-holder adopts peer tokens without posting while a refresh lease is held", async () => {
		if (!authStorage || !store || !(store instanceof SqliteAuthCredentialStore)) throw new Error("test setup failed");
		vi.useFakeTimers();

		const secondStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const secondAuthStorage = new AuthStorage(secondStore);
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-lease-adopt",
			name: "Unit OAuth Lease Adopt",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return { ...credentials, access: "posted", refresh: "posted-refresh", expires: Date.now() + 60 * 60_000 };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		try {
			await authStorage.set("unit-oauth-lease-adopt", [
				{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
			]);
			const credentialId = store.listAuthCredentials("unit-oauth-lease-adopt")[0]!.id;
			expect(store.tryAcquireCredentialRefreshLease(credentialId, "peer-refresh-owner", Date.now() + 30_000)).toBe(
				true,
			);
			await secondAuthStorage.reload();

			const adopted = secondAuthStorage.getApiKey("unit-oauth-lease-adopt", "lease-adopt");
			await Promise.resolve();
			store.updateAuthCredential(credentialId, {
				type: "oauth",
				access: "peer-access",
				refresh: "peer-refresh",
				expires: Date.now() + 60 * 60_000,
			});
			vi.advanceTimersByTime(300);
			await Promise.resolve();

			await expect(adopted).resolves.toBe("peer-access");
			expect(refreshCalls).toBe(0);
		} finally {
			secondAuthStorage.close();
			secondStore.close();
		}
	});

	test("takes over an expired refresh lease left by a crashed holder", async () => {
		if (!authStorage || !store || !(store instanceof SqliteAuthCredentialStore)) throw new Error("test setup failed");
		vi.useFakeTimers();

		let refreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-lease-takeover",
			name: "Unit OAuth Lease Takeover",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: "takeover-access",
					refresh: "takeover-refresh",
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-lease-takeover", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-lease-takeover")[0]!.id;
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "crashed-refresh-owner", Date.now() - 1)).toBe(true);

		await expect(authStorage.getApiKey("unit-oauth-lease-takeover", "lease-takeover")).resolves.toBe(
			"takeover-access",
		);
		expect(refreshCalls).toBe(1);
	});

	test("enforces durable refresh lease owner fencing and expiry", async () => {
		if (!store || !(store instanceof SqliteAuthCredentialStore)) throw new Error("test setup failed");

		vi.useFakeTimers();
		const now = Date.parse("2026-07-12T00:00:00.000Z");
		setSystemTime(new Date(now));
		await authStorage!.set("unit-oauth-durable-lease-fence", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: now - 60_000 },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-durable-lease-fence")[0]!.id;
		const firstExpiry = now + 30_000;

		expect(store.tryAcquireCredentialRefreshLease(credentialId, "owner-a", firstExpiry)).toBe(true);
		expect(store.renewCredentialRefreshLease(credentialId, "owner-b", firstExpiry + 30_000)).toBe(false);
		store.releaseCredentialRefreshLease(credentialId, "owner-b");
		expect(store.getCredentialRefreshLeaseExpiresAt(credentialId)).toBe(firstExpiry);
		expect(store.renewCredentialRefreshLease(credentialId, "owner-a", firstExpiry + 30_000)).toBe(true);

		setSystemTime(new Date(firstExpiry + 30_001));
		expect(store.getCredentialRefreshLeaseExpiresAt(credentialId)).toBeUndefined();
		expect(store.renewCredentialRefreshLease(credentialId, "owner-a", Date.now() + 30_000)).toBe(false);
		store.releaseCredentialRefreshLease(credentialId, "owner-a");
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "owner-b", Date.now() + 30_000)).toBe(true);
	});

	test("force refresh does not freshness-adopt the same rejected persisted token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const refreshedExpires = Date.now() + 60 * 60_000;
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-force-no-self-adopt",
			name: "Unit OAuth Force No Self Adopt",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken() {
				refreshCalls += 1;
				return { access: "fresh-access", refresh: "fresh-refresh", expires: refreshedExpires };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-force-no-self-adopt", [
			{
				type: "oauth",
				access: "rejected-access",
				refresh: "still-valid-refresh",
				expires: refreshedExpires,
			},
		]);

		await expect(
			authStorage.refreshCredentialMatching("unit-oauth-force-no-self-adopt", "rejected-access"),
		).resolves.toBe("fresh-access");
		expect(refreshCalls).toBe(1);

		const stored = store.listAuthCredentials("unit-oauth-force-no-self-adopt");
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.access).toBe("fresh-access");
			expect(stored[0].credential.refresh).toBe("fresh-refresh");
		}
	});

	test("waiter under a valid refresh lease does not post before lease expiry", async () => {
		if (!authStorage || !store || !(store instanceof SqliteAuthCredentialStore)) throw new Error("test setup failed");

		const secondStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const secondAuthStorage = new AuthStorage(secondStore, {
			oauthRefreshLeasePollMs: 1,
			oauthRefreshLeaseTimeoutMs: 3,
		});
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-lease-no-early-post",
			name: "Unit OAuth Lease No Early Post",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: "unexpected-post",
					refresh: "unexpected-refresh",
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		try {
			await authStorage.set("unit-oauth-lease-no-early-post", [
				{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
			]);
			const credentialId = store.listAuthCredentials("unit-oauth-lease-no-early-post")[0]!.id;
			expect(store.tryAcquireCredentialRefreshLease(credentialId, "valid-refresh-owner", Date.now() + 90_000)).toBe(
				true,
			);
			await secondAuthStorage.reload();
			vi.spyOn(secondStore, "tryAcquireCredentialRefreshLease").mockReturnValue(false);

			vi.useFakeTimers();
			const pending = secondAuthStorage.getApiKey("unit-oauth-lease-no-early-post", "no-early-post");
			await Promise.resolve();
			for (let index = 0; index < 20; index += 1) {
				vi.advanceTimersByTime(1);
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			}
			await expect(pending).resolves.toBe("access-old");
			expect(refreshCalls).toBe(0);
		} finally {
			secondAuthStorage.close();
			secondStore.close();
		}
	});
	test("freshness-adopt skips POST when a row rotates after the stale snapshot", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		vi.useFakeTimers();

		let refreshCalls = 0;
		oauthUtils.registerOAuthProvider({
			id: "unit-oauth-freshness-adopt",
			name: "Unit OAuth Freshness Adopt",
			sourceId: "auth-storage-oauth-refresh-race-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return { ...credentials, access: "posted", refresh: "posted-refresh", expires: Date.now() + 60 * 60_000 };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-freshness-adopt", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials("unit-oauth-freshness-adopt")[0]!.id;
		const listAuthCredentials = store.listAuthCredentials.bind(store);
		let providerReads = 0;
		vi.spyOn(store, "listAuthCredentials").mockImplementation(provider => {
			if (provider === "unit-oauth-freshness-adopt") {
				providerReads += 1;
				if (providerReads === 2) {
					listAuthCredentials(provider);
					store!.updateAuthCredential(credentialId, {
						type: "oauth",
						access: "peer-access",
						refresh: "peer-refresh",
						expires: Date.now() + 60 * 60_000,
					});
				}
			}
			return listAuthCredentials(provider);
		});

		await expect(authStorage.getApiKey("unit-oauth-freshness-adopt", "freshness-adopt")).resolves.toBe("peer-access");
		expect(refreshCalls).toBe(0);
		const stored = store.listAuthCredentials("unit-oauth-freshness-adopt");
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.refresh).toBe("peer-refresh");
		}
	});

	test("propagates CAS update storage errors instead of treating them as peer refresh wins", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("unit-oauth-cas-update-error", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: Date.now() - 60_000,
			},
		]);

		const failure = new Error("sqlite update failed");
		vi.spyOn(store, "tryUpdateAuthCredentialIfMatches").mockImplementation(() => {
			throw failure;
		});

		await expect(
			authStorage.refreshStoredOAuthCredential("unit-oauth-cas-update-error", {
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async credential => ({
					...credential,
					access: "access-fresh",
					refresh: "refresh-fresh",
					expires: Date.now() + 60 * 60_000,
				}),
			}),
		).rejects.toThrow("sqlite update failed");

		const stored = store.listAuthCredentials("unit-oauth-cas-update-error");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
	});

	test("propagates CAS disable storage errors instead of treating them as peer rotations", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("unit-oauth-cas-disable-error", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: Date.now() - 60_000,
			},
		]);

		const failure = new Error("sqlite disable failed");
		vi.spyOn(store, "tryDisableAuthCredentialIfMatches").mockImplementation(() => {
			throw failure;
		});

		await expect(
			authStorage.refreshStoredOAuthCredential("unit-oauth-cas-disable-error", {
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async () => {
					throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
				},
				isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
				disabledCause: error => `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
			}),
		).rejects.toThrow("sqlite disable failed");

		expect(events).toHaveLength(0);
		const stored = store.listAuthCredentials("unit-oauth-cas-disable-error");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
	});

	test("does not persist a refresh when durable lease ownership is lost before CAS update", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const now = Date.parse("2026-07-10T12:00:00.000Z");
		setSystemTime(new Date(now));
		await authStorage.set("unit-oauth-lease-update", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: now - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("unit-oauth-lease-update");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;
		const stealLease = store.tryAcquireCredentialRefreshLease?.bind(store);
		if (!stealLease) throw new Error("test store does not support refresh leases");
		const updateSpy = vi.spyOn(store, "tryUpdateAuthCredentialIfMatches");

		const result = await authStorage.refreshStoredOAuthCredential("unit-oauth-lease-update", {
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async credential => {
				// Keep the credential row bytes unchanged while expiring owner A's
				// lease. A non-lease-fenced final CAS would still persist this token.
				setSystemTime(new Date(now + 16_000));
				expect(stealLease(credentialId, "peer-owner", now + 31_000)).toBe(true);
				return {
					...credential,
					access: "access-from-lost-owner",
					refresh: "refresh-from-lost-owner",
					expires: now + 60 * 60_000,
				};
			},
		});

		expect(updateSpy).toHaveBeenCalled();
		expect(result).toMatchObject({ refreshed: false, removed: false });
		expect(result.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
		const stored = store.listAuthCredentials("unit-oauth-lease-update");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.id).toBe(credentialId);
		expect(stored[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
	});

	test("does not terminal-disable a credential when durable lease ownership is lost before CAS disable", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const now = Date.parse("2026-07-10T12:30:00.000Z");
		setSystemTime(new Date(now));
		await authStorage.set("unit-oauth-lease-disable", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: now - 60_000,
			},
		]);
		const storedBefore = store.listAuthCredentials("unit-oauth-lease-disable");
		expect(storedBefore).toHaveLength(1);
		const credentialId = storedBefore[0]!.id;
		const stealLease = store.tryAcquireCredentialRefreshLease?.bind(store);
		if (!stealLease) throw new Error("test store does not support refresh leases");
		const disableSpy = vi.spyOn(store, "tryDisableAuthCredentialIfMatches");

		const result = await authStorage.refreshStoredOAuthCredential("unit-oauth-lease-disable", {
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async () => {
				// The row still contains the same stale refresh token. Only the lease
				// fence distinguishes stale owner A from the current row owner.
				setSystemTime(new Date(now + 16_000));
				expect(stealLease(credentialId, "peer-owner", now + 31_000)).toBe(true);
				throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
			},
			isDefinitiveFailure: error => error instanceof Error && error.message.includes("invalid_grant"),
			disabledCause: error => `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
		});

		expect(disableSpy).toHaveBeenCalled();
		expect(result).toMatchObject({ refreshed: false, removed: false });
		expect(result.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
		expect(events).toHaveLength(0);
		const stored = store.listAuthCredentials("unit-oauth-lease-disable");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.id).toBe(credentialId);
		expect(stored[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old",
		});
	});
});
