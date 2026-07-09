import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const FIVE_HOUR_MS = 5 * HOUR_MS;

type UsageWindowSpec = {
	usedFraction: number;
	resetInMs: number;
};

type UsageWindowConfig = {
	windowId: string;
	windowLabel: string;
	durationMs: number;
};

type CodexUsageMetadata = {
	accountId?: string;
	allowed?: boolean;
	limitReached?: boolean;
	planType?: string;
	email?: string;
};

function createLimit(args: {
	key: "primary" | "secondary";
	windowId: string;
	windowLabel: string;
	durationMs: number;
	usedFraction: number;
	resetInMs: number;
}): UsageLimit {
	const clamped = Math.min(Math.max(args.usedFraction, 0), 1);
	const used = clamped * 100;
	return {
		id: `openai-codex:${args.key}`,
		label: args.windowLabel,
		scope: {
			provider: "openai-codex",
			windowId: args.windowId,
			shared: true,
		},
		window: {
			id: args.windowId,
			label: args.windowLabel,
			durationMs: args.durationMs,
			resetsAt: Date.now() + args.resetInMs,
		},
		amount: {
			unit: "percent",
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction: clamped,
			remainingFraction: Math.max(0, 1 - clamped),
		},
		status: clamped >= 1 ? "exhausted" : clamped >= 0.9 ? "warning" : "ok",
	};
}

function createCodexUsageReport(args: {
	accountId: string;
	primary: UsageWindowSpec;
	secondary: UsageWindowSpec;
	primaryWindow?: UsageWindowConfig;
	secondaryWindow?: UsageWindowConfig;
	metadata?: CodexUsageMetadata;
}): UsageReport {
	const primaryWindow = args.primaryWindow ?? { windowId: "1h", windowLabel: "1 Hour", durationMs: HOUR_MS };
	const secondaryWindow = args.secondaryWindow ?? { windowId: "7d", windowLabel: "7 Day", durationMs: WEEK_MS };
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits: [
			createLimit({
				key: "primary",
				windowId: primaryWindow.windowId,
				windowLabel: primaryWindow.windowLabel,
				durationMs: primaryWindow.durationMs,
				usedFraction: args.primary.usedFraction,
				resetInMs: args.primary.resetInMs,
			}),
			createLimit({
				key: "secondary",
				windowId: secondaryWindow.windowId,
				windowLabel: secondaryWindow.windowLabel,
				durationMs: secondaryWindow.durationMs,
				usedFraction: args.secondary.usedFraction,
				resetInMs: args.secondary.resetInMs,
			}),
		],
		metadata: { accountId: args.accountId, ...args.metadata },
	};
}

/**
 * Codex surfaces model-specific pools (e.g. the GPT-5.3-Codex-Spark "spark" pool)
 * alongside the shared primary/secondary windows. Build one so tests can exercise
 * the case where a model-specific pool is exhausted while the shared pool is free.
 */
function createCodexSparkLimit(args: {
	key: "primary" | "secondary";
	usedFraction: number;
	resetInMs: number;
}): UsageLimit {
	const clamped = Math.min(Math.max(args.usedFraction, 0), 1);
	const used = clamped * 100;
	const windowId = args.key === "primary" ? "5h" : "7d";
	const windowLabel = args.key === "primary" ? "5 hours (Spark)" : "7 days (Spark)";
	return {
		id: `openai-codex:spark:${args.key}`,
		label: windowLabel,
		scope: { provider: "openai-codex", tier: "spark", windowId, shared: true },
		window: {
			id: windowId,
			label: windowLabel,
			durationMs: args.key === "primary" ? FIVE_HOUR_MS : WEEK_MS,
			resetsAt: Date.now() + args.resetInMs,
		},
		amount: {
			unit: "percent",
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction: clamped,
			remainingFraction: Math.max(0, 1 - clamped),
		},
		status: clamped >= 1 ? "exhausted" : clamped >= 0.9 ? "warning" : "ok",
	};
}

function withSparkPool(
	report: UsageReport,
	spark: { primary: UsageWindowSpec; secondary: UsageWindowSpec },
): UsageReport {
	return {
		...report,
		limits: [
			...report.limits,
			createCodexSparkLimit({ key: "primary", ...spark.primary }),
			createCodexSparkLimit({ key: "secondary", ...spark.secondary }),
		],
	};
}

function createCredential(accountId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId,
		email,
	};
}

async function countApiKeySelections(
	authStorage: AuthStorage,
	provider: string,
	sessionPrefix: string,
	samples = 150,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (let index = 0; index < samples; index += 1) {
		const apiKey = await authStorage.getApiKey(provider, `${sessionPrefix}-${index}`);
		if (!apiKey) continue;
		counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
	}
	return counts;
}

function countFor(counts: Map<string, number>, apiKey: string): number {
	return counts.get(apiKey) ?? 0;
}

function expectWeightedPreference(counts: Map<string, number>, preferred: string, fallback: string): void {
	const preferredCount = countFor(counts, preferred);
	const fallbackCount = countFor(counts, fallback);
	expect(preferredCount).toBeGreaterThan(fallbackCount);
	expect(preferredCount / fallbackCount).toBeGreaterThan(1.4);
	expect(preferredCount / fallbackCount).toBeLessThan(2.4);
}

async function warmUsageCache(authStorage: AuthStorage): Promise<void> {
	const reports = await authStorage.fetchUsageReports();
	expect(reports).not.toBeNull();
}

describe("AuthStorage codex oauth ranking", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "openai-codex",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-codex-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return {
				apiKey: `api-${credential.accountId}`,
				newCredentials: credential,
			};
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("weights near-reset weekly account over lower-used far-reset account", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-near", "near@example.com") },
			{ type: "oauth", ...createCredential("acct-far", "far@example.com") },
		]);

		usageByAccount.set(
			"acct-near",
			createCodexUsageReport({
				accountId: "acct-near",
				primary: { usedFraction: 0.4, resetInMs: 10 * 60 * 1000 },
				secondary: { usedFraction: 0.92, resetInMs: 15 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-far",
			createCodexUsageReport({
				accountId: "acct-far",
				primary: { usedFraction: 0.3, resetInMs: 40 * 60 * 1000 },
				secondary: { usedFraction: 0.55, resetInMs: 6 * 24 * 60 * 60 * 1000 },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "openai-codex", "weighted-codex-near");
		expectWeightedPreference(counts, "api-acct-near", "api-acct-far");
	});

	test("weights fresh 5h ticker account at 0% usage", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-zero", "zero@example.com") },
			{ type: "oauth", ...createCredential("acct-progress", "progress@example.com") },
		]);

		const fiveHourWindow: UsageWindowConfig = {
			windowId: "5h",
			windowLabel: "5 Hours",
			durationMs: FIVE_HOUR_MS,
		};

		usageByAccount.set(
			"acct-zero",
			createCodexUsageReport({
				accountId: "acct-zero",
				primary: { usedFraction: 0, resetInMs: FIVE_HOUR_MS },
				secondary: { usedFraction: 0.8, resetInMs: 2 * HOUR_MS },
				primaryWindow: fiveHourWindow,
			}),
		);
		usageByAccount.set(
			"acct-progress",
			createCodexUsageReport({
				accountId: "acct-progress",
				primary: { usedFraction: 0.05, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: 6 * 24 * HOUR_MS },
				primaryWindow: fiveHourWindow,
			}),
		);

		const counts = await countApiKeySelections(authStorage, "openai-codex", "weighted-codex-zero");
		expectWeightedPreference(counts, "api-acct-zero", "api-acct-progress");
	});
	test("skips exhausted weekly account even when reset is near", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-exhausted", "exhausted@example.com") },
			{ type: "oauth", ...createCredential("acct-healthy", "healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-exhausted",
			createCodexUsageReport({
				accountId: "acct-exhausted",
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-healthy",
			createCodexUsageReport({
				accountId: "acct-healthy",
				primary: { usedFraction: 0.5, resetInMs: 20 * 60 * 1000 },
				secondary: { usedFraction: 0.4, resetInMs: 3 * 24 * 60 * 60 * 1000 },
			}),
		);

		await warmUsageCache(authStorage);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-exhausted");
		expect(apiKey).toBe("api-acct-healthy");
	});

	test("temporarily blocks only the exhausted Codex OAuth credential after a quota 429", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-A", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-B", "b@example.com") },
		]);
		usageByAccount.set(
			"acct-A",
			createCodexUsageReport({
				accountId: "acct-A",
				primary: { usedFraction: 0.1, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: WEEK_MS },
			}),
		);
		usageByAccount.set(
			"acct-B",
			createCodexUsageReport({
				accountId: "acct-B",
				primary: { usedFraction: 0.1, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: WEEK_MS },
			}),
		);

		const sessionId = "session-codex-quota-429";
		const firstKey = await authStorage.getApiKey("openai-codex", sessionId);
		if (!firstKey) throw new Error("expected initial Codex credential");
		const exhaustedAccount = firstKey.replace(/^api-/, "");
		const healthyAccount = exhaustedAccount === "acct-A" ? "acct-B" : "acct-A";
		usageByAccount.set(
			exhaustedAccount,
			createCodexUsageReport({
				accountId: exhaustedAccount,
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);

		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");
		const switched = await authStorage.rotateSessionCredential("openai-codex", sessionId, {
			error: Object.assign(new Error("insufficient_quota"), { status: 429 }),
		});

		expect(switched).toBe(true);
		expect(usageLimitSpy).toHaveBeenCalledTimes(1);
		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe(`api-${healthyAccount}`);
		const activeAccounts = (await authStorage.checkCredentials())
			.map(result => result.accountId)
			.filter((accountId): accountId is string => accountId !== undefined)
			.sort();
		expect(activeAccounts).toEqual(["acct-A", "acct-B"]);
	});

	test("a healthy live Codex usage report clears a stale persisted block so the account is balanced again", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-blocked", "blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-healthy", "healthy@example.com") },
		]);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		store.upsertCredentialBlock({
			credentialId: blockedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs: Date.now() + 6 * 24 * HOUR_MS,
		});

		usageByAccount.set(
			"acct-blocked",
			createCodexUsageReport({
				accountId: "acct-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "blocked@example.com",
					accountId: "acct-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-healthy",
			createCodexUsageReport({
				accountId: "acct-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "healthy@example.com",
					accountId: "acct-healthy",
				},
			}),
		);

		const blockedSelectionCounts = await countApiKeySelections(
			authStorage,
			"openai-codex",
			"stale-codex-block-before-fetch",
			40,
		);
		expect(countFor(blockedSelectionCounts, "api-acct-blocked")).toBe(0);
		expect(countFor(blockedSelectionCounts, "api-acct-healthy")).toBeGreaterThan(0);

		const generationBeforeFetch = authStorage.getGeneration();

		await authStorage.fetchUsageReports();

		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "shared")).toBeUndefined();
		expect(authStorage.getGeneration()).toBeGreaterThan(generationBeforeFetch);

		const reconciledSelectionCounts = await countApiKeySelections(
			authStorage,
			"openai-codex",
			"stale-codex-block-after-fetch",
			150,
		);
		expect(countFor(reconciledSelectionCounts, "api-acct-blocked")).toBeGreaterThan(0);
		expect(countFor(reconciledSelectionCounts, "api-acct-healthy")).toBeGreaterThan(0);
	});

	test("a healthy live Codex usage report clears stale persisted spark-scope blocks after restart", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-spark-blocked", "spark-blocked@example.com") },
		]);
		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-spark-blocked";
		});
		if (!blockedRow) throw new Error("expected spark-blocked credential row");
		store.upsertCredentialBlock({
			credentialId: blockedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "spark",
			blockedUntilMs: Date.now() + 6 * 24 * HOUR_MS,
		});
		usageByAccount.set(
			"acct-spark-blocked",
			createCodexUsageReport({
				accountId: "acct-spark-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "spark-blocked@example.com",
					accountId: "acct-spark-blocked",
				},
			}),
		);

		await authStorage.fetchUsageReports();

		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "spark")).toBeUndefined();
	});

	test("an older in-flight healthy Codex usage report does not clear a newer usage-limit block", async () => {
		if (!authStorage || !store?.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-race-blocked", "race-blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-race-healthy", "race-healthy@example.com") },
		]);

		const blockedReport = createCodexUsageReport({
			accountId: "acct-race-blocked",
			primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
			secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
			metadata: {
				allowed: true,
				limitReached: false,
				planType: "pro",
				email: "race-blocked@example.com",
				accountId: "acct-race-blocked",
			},
		});
		usageByAccount.set("acct-race-blocked", blockedReport);
		usageByAccount.set(
			"acct-race-healthy",
			createCodexUsageReport({
				accountId: "acct-race-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "race-healthy@example.com",
					accountId: "acct-race-healthy",
				},
			}),
		);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-race-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		let blockedSessionId: string | undefined;
		for (let index = 0; index < 100; index += 1) {
			const sessionId = `codex-inflight-race-selected-${index}`;
			if ((await authStorage.getApiKey("openai-codex", sessionId)) === "api-acct-race-blocked") {
				blockedSessionId = sessionId;
				break;
			}
		}
		if (!blockedSessionId) throw new Error("expected a session selecting the race-blocked account");

		const inFlightBaseUrl = "https://codex-inflight-race.example";
		const inFlightStarted = Promise.withResolvers<void>();
		const inFlightUsage = Promise.withResolvers<UsageReport | null>();
		vi.spyOn(usageProvider, "fetchUsage").mockImplementation(async params => {
			const accountId = params.credential.accountId;
			if (params.baseUrl === inFlightBaseUrl && accountId === "acct-race-blocked") {
				inFlightStarted.resolve();
				return inFlightUsage.promise;
			}
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		});

		const inFlightReports = authStorage.fetchUsageReports({
			baseUrlResolver: provider => (provider === "openai-codex" ? inFlightBaseUrl : undefined),
		});
		await inFlightStarted.promise;
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "shared")).toBeUndefined();

		const markResult = await authStorage.markUsageLimitReached("openai-codex", blockedSessionId, {
			retryAfterMs: 6 * 24 * HOUR_MS,
		});

		expect(markResult.switched).toBe(true);
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "main")).toBeDefined();

		inFlightUsage.resolve(blockedReport);
		await inFlightReports;

		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "main")).toBeDefined();
		const selectionCounts = await countApiKeySelections(
			authStorage,
			"openai-codex",
			"codex-inflight-race-after-resolve",
			40,
		);
		expect(countFor(selectionCounts, "api-acct-race-blocked")).toBe(0);
		expect(countFor(selectionCounts, "api-acct-race-healthy")).toBeGreaterThan(0);
	});

	test("broker-sourced healthy Codex usage clears remote gateway backoff", async () => {
		if (!authStorage || !store?.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-broker-blocked", "broker-blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-broker-healthy", "broker-healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-broker-blocked",
			createCodexUsageReport({
				accountId: "acct-broker-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-blocked@example.com",
					accountId: "acct-broker-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-broker-healthy",
			createCodexUsageReport({
				accountId: "acct-broker-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-healthy@example.com",
					accountId: "acct-broker-healthy",
				},
			}),
		);

		const token = "codex-broker-reconcile";
		const handle = startAuthBroker({
			storage: authStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		try {
			const brokerClient = new AuthBrokerClient({ url: handle.url, token });
			const originalUpsertCredentialBlock = brokerClient.upsertCredentialBlock.bind(brokerClient);
			const blockPersisted = Promise.withResolvers<void>();
			vi.spyOn(brokerClient, "upsertCredentialBlock").mockImplementation(async (id, block, signal) => {
				try {
					const response = await originalUpsertCredentialBlock(id, block, signal);
					blockPersisted.resolve();
					return response;
				} catch (error) {
					blockPersisted.reject(error);
					throw error;
				}
			});
			const initialResult = await brokerClient.fetchSnapshot();
			if (initialResult.status !== 200) throw new Error("expected broker snapshot");
			const blockedRow = initialResult.snapshot.credentials.find(entry => {
				const credential = entry.credential;
				return credential.type === "oauth" && credential.accountId === "acct-broker-blocked";
			});
			if (!blockedRow) throw new Error("expected blocked credential row");
			const remoteStore = new RemoteAuthCredentialStore({
				client: brokerClient,
				initialSnapshot: initialResult.snapshot,
				streamSnapshots: false,
			});
			const clientStorage = new AuthStorage(remoteStore);
			await clientStorage.reload();
			try {
				let blockedSessionId: string | undefined;
				for (let index = 0; index < 100; index += 1) {
					const sessionId = `broker-codex-local-block-${index}`;
					const apiKey = await clientStorage.getApiKey("openai-codex", sessionId);
					if (apiKey === "api-acct-broker-blocked") {
						blockedSessionId = sessionId;
						break;
					}
				}
				if (!blockedSessionId) throw new Error("expected a session selecting the blocked account");

				const markResult = await clientStorage.markUsageLimitReached("openai-codex", blockedSessionId, {
					retryAfterMs: 6 * 24 * HOUR_MS,
				});

				expect(markResult.switched).toBe(true);
				expect(remoteStore.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "main")).toBeDefined();
				await blockPersisted.promise;
				expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "main")).toBeDefined();

				await clientStorage.fetchUsageReports();

				expect(remoteStore.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "main")).toBeUndefined();
				expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "main")).toBeUndefined();
				expect(await clientStorage.getApiKey("openai-codex", blockedSessionId)).toBe("api-acct-broker-blocked");
			} finally {
				clientStorage.close();
				remoteStore.close();
			}
		} finally {
			await handle.close();
		}
	});

	test("an unhealthy live Codex usage report leaves a stale persisted block in place", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-blocked", "blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-healthy", "healthy@example.com") },
		]);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		const blockedUntilMs = Date.now() + 6 * 24 * HOUR_MS;
		store.upsertCredentialBlock({
			credentialId: blockedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs,
		});

		usageByAccount.set(
			"acct-blocked",
			createCodexUsageReport({
				accountId: "acct-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: true,
					planType: "pro",
					email: "blocked@example.com",
					accountId: "acct-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-healthy",
			createCodexUsageReport({
				accountId: "acct-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "healthy@example.com",
					accountId: "acct-healthy",
				},
			}),
		);

		await authStorage.fetchUsageReports();

		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "shared")).toBe(blockedUntilMs);
	});

	test("falls back to earliest-unblocking account when all exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-soon", "soon@example.com") },
			{ type: "oauth", ...createCredential("acct-later", "later@example.com") },
		]);

		usageByAccount.set(
			"acct-soon",
			createCodexUsageReport({
				accountId: "acct-soon",
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-later",
			createCodexUsageReport({
				accountId: "acct-later",
				primary: { usedFraction: 1, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 30 * 60 * 1000 },
			}),
		);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-all-exhausted");
		expect(apiKey).toBe("api-acct-soon");
	});

	test("works with single credential (no ranking)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [{ type: "oauth", ...createCredential("acct-solo", "solo@example.com") }]);

		usageByAccount.set(
			"acct-solo",
			createCodexUsageReport({
				accountId: "acct-solo",
				primary: { usedFraction: 0.3, resetInMs: 20 * 60 * 1000 },
				secondary: { usedFraction: 0.2, resetInMs: 5 * 24 * 60 * 60 * 1000 },
			}),
		);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-single");
		expect(apiKey).toBe("api-acct-solo");
	});

	test("prefers Pro accounts for codex spark models over Plus accounts", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-plus", "plus@example.com") },
			{ type: "oauth", ...createCredential("acct-pro", "pro@example.com") },
		]);

		const plusReport = createCodexUsageReport({
			accountId: "acct-plus",
			primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
			secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
		});
		plusReport.metadata = { ...plusReport.metadata, planType: "plus" };
		usageByAccount.set("acct-plus", plusReport);

		const proReport = createCodexUsageReport({
			accountId: "acct-pro",
			primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
			secondary: { usedFraction: 0.2, resetInMs: 6 * 24 * 60 * 60 * 1000 },
		});
		proReport.metadata = { ...proReport.metadata, planType: "pro" };
		usageByAccount.set("acct-pro", proReport);

		await warmUsageCache(authStorage);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-spark-prefers-pro", {
			modelId: "gpt-5.3-codex-spark",
		});
		expect(apiKey).toBe("api-acct-pro");
	});

	test("routes codex spark to a single Plus account when no Pro is connected", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [{ type: "oauth", ...createCredential("acct-plus", "plus@example.com") }]);

		const plusReport = createCodexUsageReport({
			accountId: "acct-plus",
			primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
			secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
		});
		plusReport.metadata = { ...plusReport.metadata, planType: "plus" };
		usageByAccount.set("acct-plus", plusReport);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-spark-single-plus", {
			modelId: "gpt-5.3-codex-spark",
		});
		expect(apiKey).toBe("api-acct-plus");
	});

	test("falls back to Plus accounts for codex spark models when no Pro is connected", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-plus-a", "plus-a@example.com") },
			{ type: "oauth", ...createCredential("acct-plus-b", "plus-b@example.com") },
		]);

		for (const accountId of ["acct-plus-a", "acct-plus-b"]) {
			const plusReport = createCodexUsageReport({
				accountId,
				primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
			});
			plusReport.metadata = { ...plusReport.metadata, planType: "plus" };
			usageByAccount.set(accountId, plusReport);
		}

		const apiKey = await authStorage.getApiKey("openai-codex", "session-spark-all-plus", {
			modelId: "gpt-5.3-codex-spark",
		});
		expect(apiKey).toBeDefined();
		expect(apiKey?.startsWith("api-acct-plus-")).toBe(true);
	});

	test("times out slow usage ranking instead of blocking first account selection", async () => {
		if (!store) throw new Error("test setup failed");

		const slowAuthStorage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "openai-codex"
					? ({
							id: "openai-codex",
							async fetchUsage(params) {
								const { promise, resolve } = Promise.withResolvers<UsageReport | null>();
								params.signal?.addEventListener("abort", () => resolve(null), { once: true });
								// 2s "would-block" fallback: if the per-request timeout below fails
								// to abort the fetch, ranking blocks for this long instead of the
								// ~10ms timeout path. Kept well above the assertion bound so a broken
								// timeout is still caught, while leaving generous slack for CI jitter.
								return Promise.race([promise, Bun.sleep(2_000).then(() => null)]);
							},
						} satisfies UsageProvider)
					: undefined,
			usageRequestTimeoutMs: 10,
		});

		await slowAuthStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-first", "first@example.com") },
			{ type: "oauth", ...createCredential("acct-second", "second@example.com") },
		]);

		const startedAt = Date.now();
		const apiKey = await slowAuthStorage.getApiKey("openai-codex");
		const elapsedMs = Date.now() - startedAt;

		expect(apiKey).toBe("api-acct-first");
		// Timeout path resolves in ~10ms; the would-block fallback is 2s. A bound
		// of 1s proves the 10ms per-request timeout fired without being fooled by
		// the block path, and absorbs scheduling jitter under parallel CI load.
		expect(elapsedMs).toBeLessThan(1_000);
	});

	test("weights 3 accounts by weekly drain rate", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-fast", "fast@example.com") },
			{ type: "oauth", ...createCredential("acct-medium", "medium@example.com") },
			{ type: "oauth", ...createCredential("acct-slow", "slow@example.com") },
		]);

		usageByAccount.set(
			"acct-slow",
			createCodexUsageReport({
				accountId: "acct-slow",
				primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.1, resetInMs: 6 * 24 * 60 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-medium",
			createCodexUsageReport({
				accountId: "acct-medium",
				primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.3, resetInMs: 5 * 24 * 60 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-fast",
			createCodexUsageReport({
				accountId: "acct-fast",
				primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.7, resetInMs: 3 * 24 * 60 * 60 * 1000 },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "openai-codex", "weighted-codex-three");
		expect(countFor(counts, "api-acct-slow")).toBeGreaterThan(countFor(counts, "api-acct-medium"));
		expect(countFor(counts, "api-acct-slow")).toBeGreaterThan(countFor(counts, "api-acct-fast"));
	});

	test("spreads concurrent Codex sessions across least-active accounts", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "b@example.com") },
			{ type: "oauth", ...createCredential("acct-c", "c@example.com") },
		]);

		const primaryResetAt = Date.now() + HOUR_MS;
		const secondaryResetAt = Date.now() + WEEK_MS;
		for (const accountId of ["acct-a", "acct-b", "acct-c"]) {
			const report = createCodexUsageReport({
				accountId,
				primary: { usedFraction: 0.1, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: WEEK_MS },
			});
			usageByAccount.set(accountId, {
				...report,
				limits: report.limits.map(limit => {
					if (!limit.window) return limit;
					return {
						...limit,
						window: {
							...limit.window,
							resetsAt: limit.scope.windowId === "1h" ? primaryResetAt : secondaryResetAt,
						},
					};
				}),
			});
		}
		await warmUsageCache(authStorage);

		const first = await authStorage.getApiKey("openai-codex", "parallel-codex-1");
		const second = await authStorage.getApiKey("openai-codex", "parallel-codex-2");
		const third = await authStorage.getApiKey("openai-codex", "parallel-codex-3");

		expect(new Set([first, second, third]).size).toBe(3);

		authStorage.releaseSessionCredentialUse("openai-codex", "parallel-codex-1");
		const fourth = await authStorage.getApiKey("openai-codex", "parallel-codex-4");

		expect(fourth).toBe(first);
	});

	test("handles usage fetch failure gracefully (null report)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-null", "null@example.com") },
			{ type: "oauth", ...createCredential("acct-known", "known@example.com") },
		]);

		// acct-null has no entry in usageByAccount — fetchUsage returns null
		usageByAccount.set(
			"acct-known",
			createCodexUsageReport({
				accountId: "acct-known",
				primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.3, resetInMs: 5 * 24 * 60 * 60 * 1000 },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "openai-codex", "weighted-codex-known", 300);
		expectWeightedPreference(counts, "api-acct-known", "api-acct-null");
	});
	test("refreshes expired oauth candidates in parallel before selection", async () => {
		if (!authStorage) throw new Error("test setup failed");

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;

			let nextCredential = credential;
			if (Date.now() >= credential.expires) {
				nextCredential = await oauthUtils.refreshOAuthToken("openai-codex", credential);
			}

			if (nextCredential.accountId === "acct-first" || nextCredential.accountId === "acct-second") {
				return null;
			}

			return {
				apiKey: nextCredential.access,
				newCredentials: nextCredential,
			};
		});

		const refreshDelayMs = 75;
		let inFlight = 0;
		let maxConcurrent = 0;
		const refreshStarts: number[] = [];
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			refreshStarts.push(Date.now());
			inFlight += 1;
			maxConcurrent = Math.max(maxConcurrent, inFlight);
			await Bun.sleep(refreshDelayMs);
			inFlight -= 1;
			return {
				...credential,
				access: `refreshed-${credential.accountId}`,
				expires: Date.now() + HOUR_MS,
			};
		});

		const expiredAt = Date.now() - HOUR_MS;
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-first", "first@example.com"), expires: expiredAt },
			{ type: "oauth", ...createCredential("acct-second", "second@example.com"), expires: expiredAt },
			{ type: "oauth", ...createCredential("acct-third", "third@example.com"), expires: expiredAt },
		]);

		const apiKey = await authStorage.getApiKey("openai-codex");

		expect(apiKey).toBe("refreshed-acct-third");
		expect(refreshStarts).toHaveLength(3);
		// Parallelism is proven deterministically by the concurrency counter: serial
		// refreshes never overlap (peak in-flight stays 1). A wall-clock bound here was
		// flaky on loaded CI runners, so maxConcurrent is the authoritative signal.
		expect(maxConcurrent).toBe(3);
	});

	// Regression: an account that has exhausted only a model-specific pool (spark)
	// while its shared "pro" pool is free must NOT be treated as rate-limited for a
	// general (non-spark) model. The bug was `#isUsageLimitReached` counting EVERY
	// window, so an exhausted spark pool parked otherwise-healthy accounts, all
	// siblings looked blocked, `markUsageLimitReached` returned false, and the agent
	// hit the multi-minute usage-limit wait instead of rotating.
	test("rotates to a sibling with free main pool when only spark pool is exhausted (non-spark model)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "b@example.com") },
		]);
		for (const accountId of ["acct-a", "acct-b"]) {
			usageByAccount.set(
				accountId,
				withSparkPool(
					createCodexUsageReport({
						accountId,
						primary: { usedFraction: 0.1, resetInMs: 2 * HOUR_MS },
						secondary: { usedFraction: 0.2, resetInMs: 5 * 24 * HOUR_MS },
					}),
					{
						primary: { usedFraction: 1, resetInMs: 90 * 60 * 1000 },
						secondary: { usedFraction: 1, resetInMs: 5 * 24 * HOUR_MS },
					},
				),
			);
		}

		const session = "session-spark-exhausted-nonspark";
		const modelId = "gpt-5.3-codex";

		// Selection for a non-spark model must not park either account on spark exhaustion.
		const firstKey = await authStorage.getApiKey("openai-codex", session, { modelId });
		expect(firstKey).toBeDefined();

		// The active credential hit a usage limit, but a sibling with free shared
		// quota is still available, so rotation MUST be reported as possible.
		const result = await authStorage.markUsageLimitReached("openai-codex", session, { modelId });
		expect(result.switched).toBe(true);

		// ...and the next acquisition for the same session actually hands off to the sibling
		// rather than re-handing the parked credential.
		const rotatedKey = await authStorage.getApiKey("openai-codex", session, { modelId });
		expect(rotatedKey).toBeDefined();
		expect(rotatedKey).not.toBe(firstKey);
	});

	// Correctness counterpart: on the SAME data, a `-spark` model genuinely draws
	// from the exhausted spark pool, so there is no sibling to rotate to and the
	// usage limit stands. This proves gating is scoped per model, not globally
	// permissive.
	test("does not rotate for a spark model when every spark pool is exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "b@example.com") },
		]);
		for (const accountId of ["acct-a", "acct-b"]) {
			usageByAccount.set(
				accountId,
				withSparkPool(
					createCodexUsageReport({
						accountId,
						primary: { usedFraction: 0.1, resetInMs: 2 * HOUR_MS },
						secondary: { usedFraction: 0.2, resetInMs: 5 * 24 * HOUR_MS },
					}),
					{
						primary: { usedFraction: 1, resetInMs: 90 * 60 * 1000 },
						secondary: { usedFraction: 1, resetInMs: 5 * 24 * HOUR_MS },
					},
				),
			);
		}

		await warmUsageCache(authStorage);

		const session = "session-spark-exhausted-spark-model";
		const modelId = "gpt-5.3-codex-spark";

		// Record a session credential first so a `false` below means "no spark sibling
		// is available", not "no session credential was ever selected".
		const sparkKey = await authStorage.getApiKey("openai-codex", session, { modelId });
		expect(sparkKey).toBeDefined();
		const result = await authStorage.markUsageLimitReached("openai-codex", session, { modelId });
		expect(result.switched).toBe(false);
	});

	// Regression (cross-model backoff contamination): a usage-limit block created by a
	// spark request is scoped to the spark pool, so it must NOT park the same accounts for
	// a later non-spark request whose shared/main pool is free. Without scoped backoff, the
	// spark block lands in the shared `provider:type` bucket and re-creates the no-rotation
	// hang for the next non-spark turn.
	test("a spark-scoped usage-limit block does not park accounts for non-spark requests", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "b@example.com") },
		]);
		// Shared "main" pool free, model-specific "spark" pool exhausted on both accounts.
		for (const accountId of ["acct-a", "acct-b"]) {
			usageByAccount.set(
				accountId,
				withSparkPool(
					createCodexUsageReport({
						accountId,
						primary: { usedFraction: 0.1, resetInMs: 2 * HOUR_MS },
						secondary: { usedFraction: 0.2, resetInMs: 5 * 24 * HOUR_MS },
					}),
					{
						primary: { usedFraction: 1, resetInMs: 90 * 60 * 1000 },
						secondary: { usedFraction: 1, resetInMs: 5 * 24 * HOUR_MS },
					},
				),
			);
		}

		// 1) A spark request parks both accounts in the spark scope (spark pool exhausted).
		await authStorage.getApiKey("openai-codex", "session-spark-turn", { modelId: "gpt-5.3-codex-spark" });
		await authStorage.markUsageLimitReached("openai-codex", "session-spark-turn", {
			modelId: "gpt-5.3-codex-spark",
		});

		// 2) A later non-spark turn must still see free shared quota on both accounts: the
		// spark-scope block must not contaminate the main scope, so rotation stays possible.
		const nonSparkKey = await authStorage.getApiKey("openai-codex", "session-main-turn", {
			modelId: "gpt-5.3-codex",
		});
		expect(nonSparkKey).toBeDefined();
		const result = await authStorage.markUsageLimitReached("openai-codex", "session-main-turn", {
			modelId: "gpt-5.3-codex",
		});
		expect(result.switched).toBe(true);
	});

	// Regression: model-scoped usage-limit backoff must NOT leak into stored API-key
	// selection. API keys have no per-model rate pools and are chosen via the global
	// block bucket, so their usage-limit block must stay global — otherwise a scoped
	// write is invisible to `#selectCredentialByType` and the parked key is handed back.
	test("rotates between API-key credentials after a usage limit (block stays global)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "api_key", key: "codex-key-a" },
			{ type: "api_key", key: "codex-key-b" },
		]);

		const session = "session-apikey-rotate";
		const modelId = "gpt-5.3-codex";

		const firstKey = await authStorage.getApiKey("openai-codex", session, { modelId });
		expect(firstKey).toBeDefined();

		const result = await authStorage.markUsageLimitReached("openai-codex", session, { modelId });
		expect(result.switched).toBe(true);

		const rotatedKey = await authStorage.getApiKey("openai-codex", session, { modelId });
		expect(rotatedKey).toBeDefined();
		expect(rotatedKey).not.toBe(firstKey);
	});

	test("skips expired access-token-only sticky credential and selects fresh sibling", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const sessionId = "sticky-token-only-session";
		await authStorage.set("openai-codex", [{ type: "oauth", ...createCredential("acct-k12", "k12@example.com") }]);
		usageByAccount.set(
			"acct-k12",
			createCodexUsageReport({
				accountId: "acct-k12",
				primary: { usedFraction: 0.3, resetInMs: 20 * 60 * 1000 },
				secondary: { usedFraction: 0.2, resetInMs: 5 * 24 * 60 * 60 * 1000 },
			}),
		);
		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe("api-acct-k12");
		usageByAccount.set(
			"acct-k12",
			createCodexUsageReport({
				accountId: "acct-k12",
				primary: { usedFraction: 1, resetInMs: FIVE_HOUR_MS },
				secondary: { usedFraction: 0.17, resetInMs: WEEK_MS },
			}),
		);
		usageByAccount.set(
			"acct-plus",
			createCodexUsageReport({
				accountId: "acct-plus",
				primary: { usedFraction: 0.2, resetInMs: FIVE_HOUR_MS },
				secondary: { usedFraction: 0.74, resetInMs: WEEK_MS },
			}),
		);

		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-acct-k12",
				refresh: "",
				expires: Date.now() - 1_000,
				accountId: "acct-k12",
				email: "k12@example.com",
			},
			{
				type: "oauth",
				...createCredential("acct-plus", "plus@example.com"),
			},
		]);

		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe("api-acct-plus");
	});

	test("ignores legacy global Codex blocks when a scoped quota window has fresh siblings", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-k12", "k12@example.com") },
			{ type: "oauth", ...createCredential("acct-plus", "plus@example.com") },
		]);
		usageByAccount.set(
			"acct-k12",
			createCodexUsageReport({
				accountId: "acct-k12",
				primary: { usedFraction: 1, resetInMs: FIVE_HOUR_MS },
				secondary: { usedFraction: 1, resetInMs: WEEK_MS },
			}),
		);
		usageByAccount.set(
			"acct-plus",
			createCodexUsageReport({
				accountId: "acct-plus",
				primary: { usedFraction: 0.2, resetInMs: FIVE_HOUR_MS },
				secondary: { usedFraction: 0.74, resetInMs: WEEK_MS },
			}),
		);
		const plus = store
			.listAuthCredentials("openai-codex")
			.find(row => row.credential.type === "oauth" && row.credential.accountId === "acct-plus");
		if (!plus || !store.upsertCredentialBlock) throw new Error("missing plus credential row");
		store.upsertCredentialBlock({
			credentialId: plus.id,
			providerKey: "openai-codex:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + WEEK_MS,
		});
		const k12 = store
			.listAuthCredentials("openai-codex")
			.find(row => row.credential.type === "oauth" && row.credential.accountId === "acct-k12");
		if (!k12 || !store.upsertCredentialBlock) throw new Error("missing k12 credential row");
		store.upsertCredentialBlock({
			credentialId: k12.id,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs: Date.now() + HOUR_MS,
		});

		expect(await authStorage.getApiKey("openai-codex", "session-with-legacy-global-block")).toBe("api-acct-plus");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude (Anthropic) ranking tests
// ─────────────────────────────────────────────────────────────────────────────

function createClaudeLimit(args: {
	key: "5h" | "7d";
	durationMs: number;
	usedFraction: number;
	resetInMs: number;
	tier?: "fable";
}): UsageLimit {
	const clamped = Math.min(Math.max(args.usedFraction, 0), 1);
	const used = clamped * 100;
	const label = args.key === "5h" ? "Claude 5 Hour" : args.tier === "fable" ? "Claude 7 Day (Fable)" : "Claude 7 Day";
	return {
		id: args.tier ? `anthropic:${args.key}:${args.tier}` : `anthropic:${args.key}`,
		label,
		scope: {
			provider: "anthropic",
			windowId: args.key,
			...(args.tier ? { tier: args.tier } : { shared: true }),
		},
		window: {
			id: args.key,
			label,
			durationMs: args.durationMs,
			resetsAt: Date.now() + args.resetInMs,
		},
		amount: {
			unit: "percent",
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction: clamped,
			remainingFraction: Math.max(0, 1 - clamped),
		},
		status: clamped >= 1 ? "exhausted" : clamped >= 0.9 ? "warning" : "ok",
	};
}

function createClaudeUsageReport(args: {
	accountId: string;
	primary: { usedFraction: number; resetInMs: number };
	secondary: { usedFraction: number; resetInMs: number };
	fableSecondary?: { usedFraction: number; resetInMs: number };
}): UsageReport {
	const limits = [
		createClaudeLimit({
			key: "5h",
			durationMs: FIVE_HOUR_MS,
			usedFraction: args.primary.usedFraction,
			resetInMs: args.primary.resetInMs,
		}),
		createClaudeLimit({
			key: "7d",
			durationMs: WEEK_MS,
			usedFraction: args.secondary.usedFraction,
			resetInMs: args.secondary.resetInMs,
		}),
	];
	if (args.fableSecondary) {
		limits.push(
			createClaudeLimit({
				key: "7d",
				durationMs: WEEK_MS,
				usedFraction: args.fableSecondary.usedFraction,
				resetInMs: args.fableSecondary.resetInMs,
				tier: "fable",
			}),
		);
	}
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits,
		metadata: { accountId: args.accountId },
	};
}

describe("AuthStorage claude oauth ranking", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "anthropic",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-claude-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.anthropic as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return {
				apiKey: `api-${credential.accountId}`,
				newCredentials: credential,
			};
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("weights lower secondary drain rate account", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-near", "near@example.com") },
			{ type: "oauth", ...createCredential("acct-far", "far@example.com") },
		]);

		usageByAccount.set(
			"acct-near",
			createClaudeUsageReport({
				accountId: "acct-near",
				primary: { usedFraction: 0.4, resetInMs: 2 * HOUR_MS },
				secondary: { usedFraction: 0.92, resetInMs: 15 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-far",
			createClaudeUsageReport({
				accountId: "acct-far",
				primary: { usedFraction: 0.3, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.55, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "anthropic", "weighted-claude-near");
		expectWeightedPreference(counts, "api-acct-near", "api-acct-far");
	});

	test("balances equal-priority accounts evenly", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "b@example.com") },
		]);

		for (const accountId of ["acct-a", "acct-b"]) {
			usageByAccount.set(
				accountId,
				createClaudeUsageReport({
					accountId,
					primary: { usedFraction: 0.25, resetInMs: 4 * HOUR_MS },
					secondary: { usedFraction: 0.25, resetInMs: 4 * 24 * HOUR_MS },
				}),
			);
		}

		const counts = await countApiKeySelections(authStorage, "anthropic", "weighted-claude-equal", 200);
		expect(Math.abs(countFor(counts, "api-acct-a") - countFor(counts, "api-acct-b"))).toBeLessThanOrEqual(25);
	});

	test("caps the strongest priority bucket at about 2x baseline weight", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-best", "best@example.com") },
			{ type: "oauth", ...createCredential("acct-base-a", "base-a@example.com") },
			{ type: "oauth", ...createCredential("acct-base-b", "base-b@example.com") },
		]);

		usageByAccount.set(
			"acct-best",
			createClaudeUsageReport({
				accountId: "acct-best",
				primary: { usedFraction: 0.05, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);
		for (const accountId of ["acct-base-a", "acct-base-b"]) {
			usageByAccount.set(
				accountId,
				createClaudeUsageReport({
					accountId,
					primary: { usedFraction: 0.7, resetInMs: 2 * HOUR_MS },
					secondary: { usedFraction: 0.7, resetInMs: 2 * 24 * HOUR_MS },
				}),
			);
		}

		const counts = await countApiKeySelections(authStorage, "anthropic", "claude-cap", 300);
		expectWeightedPreference(counts, "api-acct-best", "api-acct-base-a");
		expectWeightedPreference(counts, "api-acct-best", "api-acct-base-b");
		expect(Math.abs(countFor(counts, "api-acct-base-a") - countFor(counts, "api-acct-base-b"))).toBeLessThanOrEqual(
			15,
		);
	});

	test("skips exhausted account and picks healthy", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-exhausted", "exhausted@example.com") },
			{ type: "oauth", ...createCredential("acct-healthy", "healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-exhausted",
			createClaudeUsageReport({
				accountId: "acct-exhausted",
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-healthy",
			createClaudeUsageReport({
				accountId: "acct-healthy",
				primary: { usedFraction: 0.5, resetInMs: 3 * HOUR_MS },
				secondary: { usedFraction: 0.4, resetInMs: 3 * 24 * HOUR_MS },
			}),
		);

		const apiKey = await authStorage.getApiKey("anthropic", "session-claude-exhausted");
		expect(apiKey).toBe("api-acct-healthy");
	});

	test("falls back to earliest-unblocking when all exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-soon", "soon@example.com") },
			{ type: "oauth", ...createCredential("acct-later", "later@example.com") },
		]);

		usageByAccount.set(
			"acct-soon",
			createClaudeUsageReport({
				accountId: "acct-soon",
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-later",
			createClaudeUsageReport({
				accountId: "acct-later",
				primary: { usedFraction: 1, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 30 * 60 * 1000 },
			}),
		);

		await warmUsageCache(authStorage);

		const apiKey = await authStorage.getApiKey("anthropic", "session-claude-all-exhausted");
		expect(apiKey).toBe("api-acct-soon");
	});

	test("weights 3 accounts by secondary drain rate", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-fast", "fast@example.com") },
			{ type: "oauth", ...createCredential("acct-medium", "medium@example.com") },
			{ type: "oauth", ...createCredential("acct-slow", "slow@example.com") },
		]);

		usageByAccount.set(
			"acct-slow",
			createClaudeUsageReport({
				accountId: "acct-slow",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);
		usageByAccount.set(
			"acct-medium",
			createClaudeUsageReport({
				accountId: "acct-medium",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: 5 * 24 * HOUR_MS },
			}),
		);
		usageByAccount.set(
			"acct-fast",
			createClaudeUsageReport({
				accountId: "acct-fast",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.7, resetInMs: 3 * 24 * HOUR_MS },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "anthropic", "weighted-claude-three");
		expect(countFor(counts, "api-acct-slow")).toBeGreaterThan(countFor(counts, "api-acct-medium"));
		expect(countFor(counts, "api-acct-slow")).toBeGreaterThan(countFor(counts, "api-acct-fast"));
	});

	test("selects the account with lower Fable weekly usage for Claude Fable requests", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "b@example.com") },
		]);

		usageByAccount.set(
			"acct-a",
			createClaudeUsageReport({
				accountId: "acct-a",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: 6 * 24 * HOUR_MS },
				fableSecondary: { usedFraction: 0.85, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);
		usageByAccount.set(
			"acct-b",
			createClaudeUsageReport({
				accountId: "acct-b",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.7, resetInMs: 6 * 24 * HOUR_MS },
				fableSecondary: { usedFraction: 0.2, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);

		const apiKey = await authStorage.getApiKey("anthropic", undefined, { modelId: "claude-fable-5" });
		expect(apiKey).toBe("api-acct-b");
	});

	test("single credential works without ranking", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [{ type: "oauth", ...createCredential("acct-solo", "solo@example.com") }]);

		usageByAccount.set(
			"acct-solo",
			createClaudeUsageReport({
				accountId: "acct-solo",
				primary: { usedFraction: 0.3, resetInMs: 3 * HOUR_MS },
				secondary: { usedFraction: 0.2, resetInMs: 5 * 24 * HOUR_MS },
			}),
		);

		const apiKey = await authStorage.getApiKey("anthropic", "session-claude-single");
		expect(apiKey).toBe("api-acct-solo");
	});
});
