/**
 * AuthStorage.getUsageHeadroom is a passive, model-scoped routing signal. These
 * tests warm synthetic usage cache entries through the normal usage fetcher spy,
 * then assert the public probe reads only the cached/scoped state.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import { isUsageLimitOutcome } from "@oh-my-pi/pi-ai/error/rate-limit";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type { UsageHeadroom, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, CacheEntry>;
}

function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, CacheEntry>();
	return {
		cache,
		close() {},
		listAuthCredentials() {
			return rows.filter(row => row.disabledCause === null);
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return rows;
		},
		upsertAuthCredentialForProvider() {
			return rows;
		},
		deleteAuthCredentialsForProvider() {},
		getCache(key, options) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (!options?.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function makeStoreBackedUsageStore(
	rows: StoredAuthCredential[],
	reportsByAccountId: Record<string, UsageReport>,
): ObservableStore {
	const store = makeStore(rows);
	return {
		...store,
		// Broker-backed stores own the usage snapshot, so sticky routing must read this hook instead of local cache.
		getUsageReport(_provider, credential) {
			if (credential.type !== "oauth" || !credential.accountId) return Promise.resolve(null);
			return Promise.resolve(reportsByAccountId[credential.accountId] ?? null);
		},
	};
}

function oauthRow(id: number, email = `user-${id}@example.com`): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

function anthropicModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1/messages",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat: undefined,
	} as Model<Api>;
}

function limit(args: {
	id: string;
	label?: string;
	windowId: string;
	usedFraction: number;
	omitUsedFraction?: boolean;
	status?: UsageLimit["status"];
	resetsAt?: number;
	durationMs?: number;
	tier?: string;
	shared?: boolean;
}): UsageLimit {
	const amount: UsageLimit["amount"] = {
		used: args.usedFraction * 100,
		limit: 100,
		remaining: Math.max(0, 100 - args.usedFraction * 100),
		remainingFraction: Math.max(0, 1 - args.usedFraction),
		unit: "percent",
	};
	if (!args.omitUsedFraction) {
		amount.usedFraction = args.usedFraction;
	}
	return {
		id: args.id,
		label: args.label ?? args.id,
		scope: {
			provider: "anthropic",
			windowId: args.windowId,
			tier: args.tier,
			shared: args.shared,
		},
		window: {
			id: args.windowId,
			label: args.windowId,
			durationMs: args.durationMs,
			resetsAt: args.resetsAt,
		},
		amount,
		status: args.status ?? (args.usedFraction >= 1 ? "exhausted" : "ok"),
	};
}

function report(limits: UsageLimit[]): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits,
		metadata: { accountId: "account-1", email: "user-1@example.com" },
	};
}

function dualWindowReport(args: {
	fiveHourFraction: number;
	weeklyFraction: number;
	fiveHourStatus?: UsageLimit["status"];
	weeklyStatus?: UsageLimit["status"];
	fiveHourResetAt?: number;
	weeklyResetAt?: number;
}): UsageReport {
	return report([
		limit({
			id: "anthropic:5h",
			windowId: "5h",
			usedFraction: args.fiveHourFraction,
			status: args.fiveHourStatus,
			resetsAt: args.fiveHourResetAt,
			durationMs: FIVE_HOURS_MS,
			shared: true,
		}),
		limit({
			id: "anthropic:7d",
			windowId: "7d",
			usedFraction: args.weeklyFraction,
			status: args.weeklyStatus,
			resetsAt: args.weeklyResetAt,
			durationMs: WEEK_MS,
			shared: true,
		}),
	]);
}

function tieredReport(args?: {
	sharedFraction?: number;
	sonnetFraction?: number;
	opusFraction?: number;
	sonnetStatus?: UsageLimit["status"];
	resetAt?: number;
}): UsageReport {
	return report([
		limit({
			id: "anthropic:5h",
			windowId: "5h",
			usedFraction: args?.sharedFraction ?? 0.1,
			durationMs: FIVE_HOURS_MS,
			shared: true,
		}),
		limit({
			id: "anthropic:7d",
			windowId: "7d",
			usedFraction: args?.sharedFraction ?? 0.1,
			durationMs: WEEK_MS,
			shared: true,
		}),
		limit({
			id: "anthropic:7d:opus",
			windowId: "7d",
			usedFraction: args?.opusFraction ?? 0.1,
			durationMs: WEEK_MS,
			tier: "opus",
		}),
		limit({
			id: "anthropic:7d:sonnet",
			windowId: "7d",
			usedFraction: args?.sonnetFraction ?? 0.1,
			status: args?.sonnetStatus,
			resetsAt: args?.resetAt,
			durationMs: WEEK_MS,
			tier: "sonnet",
		}),
	]);
}

function windowKinds(headroom: UsageHeadroom): string[] {
	return (headroom.windows ?? []).map(window => window.kind).sort();
}

function usageWindow(headroom: UsageHeadroom, kind: "5h" | "weekly") {
	return headroom.windows?.find(window => window.kind === kind);
}

async function warmUsageCache(storage: AuthStorage, syntheticReport: UsageReport | null): Promise<number> {
	const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(syntheticReport);
	await storage.fetchUsageReports();
	return fetchSpy.mock.calls.length;
}
function oauthUsageCacheKey(credential: AuthCredential): string {
	if (credential.type !== "oauth") throw new Error("expected OAuth credential");
	return `usage_cache:report:anthropic:default:oauth|account:${credential.accountId}|email:${credential.email?.toLowerCase()}`;
}

function seedUsageCache(store: ObservableStore, credential: AuthCredential, syntheticReport: UsageReport): void {
	const expiresAt = Date.now() + 60_000;
	store.setCache(
		oauthUsageCacheKey(credential),
		JSON.stringify({ value: syntheticReport, expiresAt }),
		Math.floor(expiresAt / 1000),
	);
}

function seedStickySession(
	store: ObservableStore,
	provider: string,
	sessionId: string,
	row: StoredAuthCredential,
): void {
	store.setCache(
		`session:sticky:${provider}:${sessionId}`,
		JSON.stringify({ type: row.credential.type, index: 0, credentialId: row.id }),
		Math.floor((Date.now() + 60_000) / 1000),
	);
}

function mockAnthropicOAuthAccess(): void {
	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
		const credential = credentials[provider];
		return credential ? { newCredentials: credential, apiKey: `api-${credential.accountId}` } : null;
	});
}

async function makeStorage(rows: StoredAuthCredential[] = [oauthRow(1)]): Promise<AuthStorage> {
	const storage = new AuthStorage(makeStore(rows), {
		usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
	});
	await storage.reload();
	return storage;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AuthStorage.getUsageHeadroom", () => {
	it("requires every explicit 5h and weekly window in all-mode but allows either in any-mode", async () => {
		const storage = await makeStorage();
		const weeklyResetAt = Date.now() + 60_000;
		try {
			await warmUsageCache(
				storage,
				dualWindowReport({
					fiveHourFraction: 0.1,
					weeklyFraction: 0.9,
					weeklyResetAt,
				}),
			);

			const allMode = storage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"), { windowMode: "all" });
			expect(allMode.hasRoom).toBe(false);
			expect(allMode.reason).toBe("window-utilization");
			expect(allMode.window).toBe("weekly");
			expect(allMode.resetAtMs).toBe(weeklyResetAt);
			expect(windowKinds(allMode)).toEqual(["5h", "weekly"]);
			expect(usageWindow(allMode, "5h")?.usedFraction).toBe(0.1);
			expect(usageWindow(allMode, "weekly")?.usedFraction).toBe(0.9);

			const anyMode = storage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"), { windowMode: "any" });
			expect(anyMode.hasRoom).toBe(true);
			expect(windowKinds(anyMode)).toEqual(["5h", "weekly"]);
		} finally {
			storage.close();
		}
	});

	it("reports the 5h blocker in all-mode when weekly has room but any-mode still passes", async () => {
		const storage = await makeStorage();
		const fiveHourResetAt = Date.now() + 60_000;
		try {
			await warmUsageCache(
				storage,
				dualWindowReport({
					fiveHourFraction: 0.6,
					weeklyFraction: 0.1,
					fiveHourResetAt,
				}),
			);

			const allMode = storage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"), { windowMode: "all" });
			expect(allMode.hasRoom).toBe(false);
			expect(allMode.reason).toBe("window-utilization");
			expect(allMode.window).toBe("5h");
			expect(allMode.resetAtMs).toBe(fiveHourResetAt);
			expect(windowKinds(allMode)).toEqual(["5h", "weekly"]);

			const anyMode = storage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"), { windowMode: "any" });
			expect(anyMode.hasRoom).toBe(true);
			expect(windowKinds(anyMode)).toEqual(["5h", "weekly"]);
		} finally {
			storage.close();
		}
	});

	it("uses a strict boundary where 0.49 passes and exactly 0.50 blocks", async () => {
		const belowStorage = await makeStorage();
		try {
			await warmUsageCache(
				belowStorage,
				dualWindowReport({
					fiveHourFraction: 0.49,
					weeklyFraction: 0.49,
				}),
			);
			expect(belowStorage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5")).hasRoom).toBe(true);
		} finally {
			belowStorage.close();
		}

		vi.restoreAllMocks();
		const boundaryStorage = await makeStorage();
		try {
			await warmUsageCache(
				boundaryStorage,
				dualWindowReport({
					fiveHourFraction: 0.5,
					weeklyFraction: 0.49,
				}),
			);

			const headroom = boundaryStorage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"));
			expect(headroom.hasRoom).toBe(false);
			expect(headroom.reason).toBe("window-utilization");
			expect(headroom.window).toBe("5h");
		} finally {
			boundaryStorage.close();
		}
	});

	it("hard-gates an exhausted weekly window even when any-mode has a low 5h window", async () => {
		const storage = await makeStorage();
		const weeklyResetAt = Date.now() + 60_000;
		try {
			await warmUsageCache(
				storage,
				dualWindowReport({
					fiveHourFraction: 0.1,
					weeklyFraction: 0.1,
					weeklyStatus: "exhausted",
					weeklyResetAt,
				}),
			);

			const headroom = storage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"), { windowMode: "any" });
			expect(headroom.hasRoom).toBe(false);
			expect(headroom.reason).toBe("window-exhausted");
			expect(headroom.window).toBe("weekly");
			expect(headroom.resetAtMs).toBe(weeklyResetAt);
			expect(usageWindow(headroom, "weekly")?.exhausted).toBe(true);
			expect(usageWindow(headroom, "5h")?.usedFraction).toBe(0.1);
		} finally {
			storage.close();
		}
	});

	it("ignores stale high-usage windows while still reporting their stale snapshot", async () => {
		const storage = await makeStorage();
		const pastResetAt = Date.now() - 60_000;
		const fiveHourResetAt = Date.now() + 60_000;
		try {
			await warmUsageCache(
				storage,
				dualWindowReport({
					fiveHourFraction: 0.1,
					weeklyFraction: 0.99,
					fiveHourResetAt,
					weeklyResetAt: pastResetAt,
				}),
			);

			const headroom = storage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"));
			expect(headroom.hasRoom).toBe(true);
			expect(usageWindow(headroom, "weekly")?.usedFraction).toBe(0.99);
			expect(usageWindow(headroom, "weekly")?.resetsAt).toBe(pastResetAt);
			expect(usageWindow(headroom, "weekly")?.exhausted).toBe(false);
			expect(usageWindow(headroom, "5h")?.usedFraction).toBe(0.1);
		} finally {
			storage.close();
		}
	});

	it("defaults to a 0.5 threshold and honors a custom utilizationMax", async () => {
		const storage = await makeStorage();
		try {
			await warmUsageCache(
				storage,
				dualWindowReport({
					fiveHourFraction: 0.6,
					weeklyFraction: 0.1,
				}),
			);

			const defaultThreshold = storage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"));
			expect(defaultThreshold.hasRoom).toBe(false);
			expect(defaultThreshold.reason).toBe("window-utilization");
			expect(defaultThreshold.window).toBe("5h");

			const customThreshold = storage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"), {
				utilizationMax: 0.7,
			});
			expect(customThreshold.hasRoom).toBe(true);
		} finally {
			storage.close();
		}
	});

	it("keeps model-scoped isolation when the opposite Claude tier is exhausted", async () => {
		const storage = await makeStorage();
		try {
			const callsAfterWarm = await warmUsageCache(storage, tieredReport({ opusFraction: 1, sonnetFraction: 0.1 }));
			const headroom = storage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"));

			expect(headroom.hasRoom).toBe(true);
			expect(windowKinds(headroom)).toEqual(["5h", "weekly", "weekly"]);
			expect(claudeUsage.claudeUsageProvider.fetchUsage).toHaveBeenCalledTimes(callsAfterWarm);
		} finally {
			storage.close();
		}
	});

	it("preserves optimistic answers for missing credentials, null reports, and empty scoped limits", async () => {
		const noCredsStorage = await makeStorage([]);
		try {
			expect(noCredsStorage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"))).toEqual({ hasRoom: true });
		} finally {
			noCredsStorage.close();
		}

		vi.restoreAllMocks();
		const nullReportStorage = await makeStorage();
		try {
			await warmUsageCache(nullReportStorage, null);
			expect(nullReportStorage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"))).toEqual({ hasRoom: true });
		} finally {
			nullReportStorage.close();
		}

		vi.restoreAllMocks();
		const noScopedLimitsStorage = await makeStorage();
		try {
			await warmUsageCache(
				noScopedLimitsStorage,
				report([
					limit({
						id: "anthropic:7d:opus",
						windowId: "7d",
						usedFraction: 1,
						durationMs: WEEK_MS,
						tier: "opus",
						status: "exhausted",
					}),
				]),
			);
			expect(noScopedLimitsStorage.getUsageHeadroom(anthropicModel("claude-sonnet-4-5"))).toEqual({ hasRoom: true });
		} finally {
			noScopedLimitsStorage.close();
		}
	});

	describe("AuthStorage Anthropic OAuth sticky usage gate", () => {
		it("switches from a hard-exhausted sticky account to a sibling with room", async () => {
			const rowA = oauthRow(1);
			const rowB = oauthRow(2);
			const store = makeStore([rowA, rowB]);
			const storage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			});
			mockAnthropicOAuthAccess();
			try {
				seedStickySession(store, "anthropic", "sticky-a", rowA);
				await storage.reload();
				expect(storage.getOAuthAccountId("anthropic", "sticky-a")).toBe("account-1");
				seedUsageCache(store, rowA.credential, dualWindowReport({ fiveHourFraction: 1, weeklyFraction: 0.1 }));
				seedUsageCache(store, rowB.credential, dualWindowReport({ fiveHourFraction: 0.1, weeklyFraction: 0.1 }));

				expect(await storage.getApiKey("anthropic", "sticky-a", { modelId: "claude-sonnet-4-5" })).toBe(
					"api-account-2",
				);
			} finally {
				storage.close();
			}
		});

		it("keeps a hard-exhausted sticky account when no sibling has room", async () => {
			const rowA = oauthRow(1);
			const rowB = oauthRow(2);
			const store = makeStore([rowA, rowB]);
			const storage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			});
			mockAnthropicOAuthAccess();
			try {
				seedStickySession(store, "anthropic", "sticky-a", rowA);
				await storage.reload();
				expect(storage.getOAuthAccountId("anthropic", "sticky-a")).toBe("account-1");
				seedUsageCache(store, rowA.credential, dualWindowReport({ fiveHourFraction: 1, weeklyFraction: 0.1 }));
				seedUsageCache(store, rowB.credential, dualWindowReport({ fiveHourFraction: 0.1, weeklyFraction: 1 }));

				expect(await storage.getApiKey("anthropic", "sticky-a", { modelId: "claude-sonnet-4-5" })).toBe(
					"api-account-1",
				);
			} finally {
				storage.close();
			}
		});

		it("skips ranking when the sticky account still has room", async () => {
			const rowA = oauthRow(1);
			const rowB = oauthRow(2);
			const store = makeStore([rowA, rowB]);
			const storage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			});
			mockAnthropicOAuthAccess();
			try {
				seedStickySession(store, "anthropic", "sticky-a", rowA);
				await storage.reload();
				expect(storage.getOAuthAccountId("anthropic", "sticky-a")).toBe("account-1");
				seedUsageCache(store, rowA.credential, dualWindowReport({ fiveHourFraction: 0.1, weeklyFraction: 0.1 }));
				const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);

				expect(await storage.getApiKey("anthropic", "sticky-a", { modelId: "claude-sonnet-4-5" })).toBe(
					"api-account-1",
				);
				// Ranking would have to fetch sibling B's missing usage for Anthropic model-scoped selection.
				expect(fetchSpy).not.toHaveBeenCalled();
			} finally {
				storage.close();
			}
		});

		it("switches using broker-backed usage reports when no local cache exists", async () => {
			const rowA = oauthRow(1);
			const rowB = oauthRow(2);
			const reports: Record<string, UsageReport> = {
				"account-1": dualWindowReport({ fiveHourFraction: 1, weeklyFraction: 0.1 }),
				"account-2": dualWindowReport({ fiveHourFraction: 0.1, weeklyFraction: 0.1 }),
			};
			const store = makeStoreBackedUsageStore([rowA, rowB], reports);
			const storage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			});
			mockAnthropicOAuthAccess();
			try {
				seedStickySession(store, "anthropic", "sticky-a", rowA);
				await storage.reload();
				expect(storage.getOAuthAccountId("anthropic", "sticky-a")).toBe("account-1");

				expect(await storage.getApiKey("anthropic", "sticky-a", { modelId: "claude-sonnet-4-5" })).toBe(
					"api-account-2",
				);
			} finally {
				storage.close();
			}
		});

		it("does not yield a sticky account that is only over the soft headroom threshold", async () => {
			const rowA = oauthRow(1);
			const rowB = oauthRow(2);
			const store = makeStore([rowA, rowB]);
			const storage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			});
			mockAnthropicOAuthAccess();
			try {
				seedStickySession(store, "anthropic", "sticky-a", rowA);
				await storage.reload();
				expect(storage.getOAuthAccountId("anthropic", "sticky-a")).toBe("account-1");
				// 0.9 is above HEADROOM_UTILIZATION_MAX (0.5) but below the hard exhaustion boundary (1.0).
				seedUsageCache(store, rowA.credential, dualWindowReport({ fiveHourFraction: 0.9, weeklyFraction: 0.1 }));
				seedUsageCache(store, rowB.credential, dualWindowReport({ fiveHourFraction: 0.1, weeklyFraction: 0.1 }));
				const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockResolvedValue(null);

				expect(await storage.getApiKey("anthropic", "sticky-a", { modelId: "claude-sonnet-4-5" })).toBe(
					"api-account-1",
				);
				// A looser sticky gate would rank and fetch missing usage instead of staying on hard-limit parity.
				expect(fetchSpy).not.toHaveBeenCalled();
			} finally {
				storage.close();
			}
		});

		it("yields an exhausted broker-backed sticky account to a sibling with missing usage", async () => {
			const rowA = oauthRow(1);
			const rowB = oauthRow(2);
			const reports: Record<string, UsageReport> = {
				"account-1": dualWindowReport({ fiveHourFraction: 1, weeklyFraction: 0.1 }),
			};
			const store = makeStoreBackedUsageStore([rowA, rowB], reports);
			const storage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			});
			mockAnthropicOAuthAccess();
			try {
				seedStickySession(store, "anthropic", "sticky-a", rowA);
				await storage.reload();
				expect(storage.getOAuthAccountId("anthropic", "sticky-a")).toBe("account-1");

				expect(await storage.getApiKey("anthropic", "sticky-a", { modelId: "claude-sonnet-4-5" })).toBe(
					"api-account-2",
				);
			} finally {
				storage.close();
			}
		});

		it("keeps broker-backed sticky selection without model-scoped usage parity data", async () => {
			const rowA = oauthRow(1);
			const rowB = oauthRow(2);
			const reports: Record<string, UsageReport> = {
				"account-1": dualWindowReport({ fiveHourFraction: 1, weeklyFraction: 0.1 }),
				"account-2": dualWindowReport({ fiveHourFraction: 0.1, weeklyFraction: 0.1 }),
			};
			const store = makeStoreBackedUsageStore([rowA, rowB], reports);
			const getUsageReportSpy = vi.spyOn(store, "getUsageReport");
			const storage = new AuthStorage(store, {
				usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			});
			mockAnthropicOAuthAccess();
			try {
				seedStickySession(store, "anthropic", "sticky-a", rowA);
				await storage.reload();
				expect(storage.getOAuthAccountId("anthropic", "sticky-a")).toBe("account-1");

				expect(await storage.getApiKey("anthropic", "sticky-a")).toBe("api-account-1");
				// No modelId means the sticky probe mirrors the ranker: cache-first broker refreshes only for
				// the sticky check and the selected credential preflight, without the extra awaited
				// authoritative reads that would force needless ranking and then re-pin the sticky account.
				expect(getUsageReportSpy).toHaveBeenCalledTimes(2);
			} finally {
				storage.close();
			}
		});

		it("classifies a representative Anthropic account usage-limit 429 as a usage-limit outcome", () => {
			const message =
				'{"type":"error","error":{"type":"rate_limit_error","message":"This account has reached the 5-hour usage limit for Claude. Please try again later."}}';

			expect(isUsageLimitOutcome(429, message)).toBe(true);
		});
	});
});
