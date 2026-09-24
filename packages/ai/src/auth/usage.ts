import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { $pickenv, logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import { resolveUsedFraction } from "../usage";
import type {
	ClientUsageReport,
	ClientUsageSummary,
	CredentialRankingContext,
	UsageCostHistoryEntry,
	UsageCredential,
	UsageFetchParams,
	UsageHeadroom,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLimit,
	UsageLogger,
	UsageProvider,
	UsageReport,
	UsageWindowKind,
} from "../usage";
import { DEFAULT_USAGE_PROVIDERS } from "../usage/registry";
import { raceSignal } from "./abort";
import type { SessionAffinity } from "./affinity";
import { type CredentialBlocks, providerTypeKey } from "./blocks";
import type { KeyOverrides } from "./cascade";
import {
	buildUsageCredential,
	oauthUsageRequest,
	USAGE_FAILURE_BACKOFF_MS,
	USAGE_HEADER_INGEST_INTERVAL_MS,
	usageCacheIdentity,
	usageRequest,
} from "./usage-cache";
import type { UsageCache, UsageRequestDescriptor } from "./usage-cache";
import type { CredentialPool } from "./pool";
import type { RankingStrategyResolver } from "../usage/registry";
import { OAUTH_REFRESH_SKEW_MS } from "./refresh";
import type { OAuthRefresher } from "./refresh";
import { USAGE_REPORT_TTL_MS } from "./sqlite-credential-store";
import type { AuthCredentialStore } from "./store";
import type { AuthCredential, OAuthCredential, ObservedUsageInput, UsageApi } from "./types";
import {
	dedupeUsageReports,
	isUsageLimitExhausted,
	scopedUsageLimits,
	usageReportMetadataValue,
	usageReportScopeAccountId,
	windowResetAt,
} from "./usage-report";

/**
 * Advisory model-headroom probes stay cache-first and side-effect-light:
 * 1. all stored credentials blocked for the model's block scope => no room;
 * 2. any non-stale scoped cached usage window exhausted => that credential has no room;
 * 3. scoped cached usage windows must be strictly below this utilization.
 *
 * Missing reports, missing scoped limits, providers without a ranking strategy,
 * and broker `null` reports are optimistic; only credential blocks fire before
 * live requests, and live 429 handling remains on the request/retry path.
 */
const HEADROOM_UTILIZATION_MAX = 0.5;
/**
 * Microtask-scale grace given to a stale usage refresh before credential
 * ranking falls back to the last-good report. A provider that answers
 * immediately (or from its own cache) still re-ranks on current usage; a slow
 * endpoint must not block `getApiKey`.
 */
const USAGE_RANKING_STALE_REFRESH_GRACE_MS = 5;
const STALE_REFRESH_GRACE_EXPIRED = Symbol("usage-ranking-stale-refresh-grace-expired");

type UsageHeadroomWindow = {
	kind: UsageWindowKind;
	usedFraction?: number;
	resetsAt?: number;
	exhausted: boolean;
};

type UsageHeadroomBlock = {
	kind: UsageWindowKind;
	usedFraction?: number;
	resetAtMs?: number;
	windows: UsageHeadroomWindow[];
};

/** Keep the block whose reset lands earliest, so fallback hints name the soonest window. */
function chooseEarlierUsageHeadroomBlock(
	current: UsageHeadroomBlock | undefined,
	candidate: UsageHeadroomBlock,
): UsageHeadroomBlock {
	if (!current) return candidate;
	if (
		candidate.resetAtMs !== undefined &&
		(current.resetAtMs === undefined || candidate.resetAtMs < current.resetAtMs)
	) {
		return candidate;
	}
	return current;
}

/** Convert an OAuth usage credential into a refreshable stored shape; used by probes and health. */
export function buildRefreshableOauthCredential(credential: UsageCredential): OAuthCredential | null {
	if (!credential.accessToken || !credential.refreshToken || credential.expiresAt === undefined) {
		return null;
	}
	return {
		type: "oauth",
		access: credential.accessToken,
		refresh: credential.refreshToken,
		expires: credential.expiresAt,
		accountId: credential.accountId,
		projectId: credential.projectId,
		email: credential.email,
		orgId: credential.orgId,
		orgName: credential.orgName,
		enterpriseUrl: credential.enterpriseUrl,
		apiEndpoint: credential.apiEndpoint,
	};
}

/** Merge refreshed OAuth tokens and identity into a usage credential; used by probes and health. */
export function mergeRefreshedUsageCredential(
	credential: UsageCredential,
	refreshed: OAuthCredentials,
): UsageCredential {
	return {
		...credential,
		accessToken: refreshed.access,
		refreshToken: refreshed.refresh,
		expiresAt: refreshed.expires,
		accountId: refreshed.accountId ?? credential.accountId,
		projectId: refreshed.projectId ?? credential.projectId,
		email: refreshed.email ?? credential.email,
		enterpriseUrl: refreshed.enterpriseUrl ?? credential.enterpriseUrl,
		apiEndpoint: refreshed.apiEndpoint ?? credential.apiEndpoint,
		orgId: refreshed.orgId ?? credential.orgId,
		orgName: refreshed.orgName ?? credential.orgName,
	};
}

/** Dependencies for usage fetching and cache coordination; supplied by AuthStorage. */
export interface UsageServiceDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	overrides: KeyOverrides;
	refresher: OAuthRefresher;
	cache: UsageCache;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	strategies: RankingStrategyResolver;
	usageProviders: (provider: Provider) => UsageProvider | undefined;
	fetch: typeof fetch;
	requestTimeoutMs: number;
	logger: UsageLogger;
}

/** Usage reports: per-credential cached fetches, aggregate reports, header ingestion, history. */
export class UsageService implements UsageApi {
	#deps: UsageServiceDeps;
	/** Runtime extension providers take precedence over the configured/default resolver. */
	#runtimeUsageProviderOverrides: Map<Provider, { provider: UsageProvider; apiKey?: string }> = new Map();
	#usageRequestInFlight: Map<string, Promise<UsageReport | null>> = new Map();
	#usageHeaderIngestAt: Map<string, number> = new Map();
	#usageReportsInFlight: Map<string, Promise<UsageReport[] | null>> = new Map();
	readonly fetch: typeof fetch;
	readonly logger: UsageLogger;
	readonly requestTimeoutMs: number;

	constructor(deps: UsageServiceDeps) {
		this.#deps = deps;
		this.fetch = deps.fetch;
		this.logger = deps.logger;
		this.requestTimeoutMs = deps.requestTimeoutMs;
	}

	/** Whether OAuth usage can be fetched via a provider or the store hook. */
	canFetchOAuthUsage(provider: Provider): boolean {
		return this.providerFor(provider) !== undefined || this.#deps.store.getUsageReport !== undefined;
	}

	/**
	 * The {@link UsageProvider} registered for `provider`, or undefined when the
	 * provider has no usage endpoint at all. Lets callers tell "a credential we
	 * could have fetched usage for but didn't" apart from "a provider with no
	 * usage concept" (web-search keys, local/keyless servers, inference
	 * providers without a usage API) — the latter never warrants a usage row.
	 */
	providerFor(provider: Provider): UsageProvider | undefined {
		return this.#runtimeUsageProviderOverrides.get(provider)?.provider ?? this.#deps.usageProviders(provider);
	}

	/**
	 * Install a runtime usage provider override (not persisted to disk).
	 *
	 * Runtime overrides are checked before the configured resolver, including its
	 * built-in fallback. Removing the override restores that resolver unchanged.
	 */
	setProvider(provider: Provider, usageProvider: UsageProvider, apiKey?: string): void {
		this.#runtimeUsageProviderOverrides.set(provider, {
			provider: usageProvider,
			apiKey,
		});
		this.#deps.cache.invalidateForProvider(provider);
	}
	/** Remove a runtime usage provider override and restore configured/default resolution. */
	removeProvider(provider: Provider): void {
		if (!this.#runtimeUsageProviderOverrides.has(provider)) return;
		this.#deps.cache.invalidateForProvider(provider);
		this.#runtimeUsageProviderOverrides.delete(provider);
	}

	/** Preserve the persisted OAuth row's login anchor and subtype metadata on usage-path refresh. */
	persistRefreshedCredential(
		provider: Provider,
		previous: UsageCredential,
		next: UsageCredential,
		credentialId = this.#deps.pool.findIdForUsageCredential(provider, previous),
	): void {
		if (credentialId === undefined) return;
		const entry = this.#deps.pool.entries(provider).find(candidate => candidate.id === credentialId);
		if (entry?.credential.type !== "oauth") return;
		this.#deps.pool.replaceById(provider, credentialId, {
			...entry.credential,
			access: next.accessToken ?? entry.credential.access,
			refresh: next.refreshToken ?? entry.credential.refresh,
			expires: next.expiresAt ?? entry.credential.expires,
			accountId: next.accountId ?? entry.credential.accountId,
			projectId: next.projectId ?? entry.credential.projectId,
			email: next.email ?? entry.credential.email,
			enterpriseUrl: next.enterpriseUrl ?? entry.credential.enterpriseUrl,
			apiEndpoint: next.apiEndpoint ?? entry.credential.apiEndpoint,
			orgId: next.orgId ?? entry.credential.orgId,
			orgName: next.orgName ?? entry.credential.orgName,
		});
	}

	/** Probe a provider endpoint, refreshing near-expiry OAuth tokens when possible. */
	async #fetchUsageUncached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const providerImpl = this.providerFor(request.provider);
		if (!providerImpl) return null;

		const timeoutSignal =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? AbortSignal.timeout(timeoutMs)
				: undefined;
		let params: UsageFetchParams = {
			...request,
			accountKey: usageCacheIdentity(request.credential),
			signal: timeoutSignal,
		};

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() + OAUTH_REFRESH_SKEW_MS >= request.credential.expiresAt
		) {
			const refreshableCredential = buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshableCredentialId = this.#deps.pool.findIdForUsageCredential(
						request.provider,
						request.credential,
					);
					const refreshed = await this.#deps.refresher.refresh(
						request.provider,
						refreshableCredential,
						refreshableCredentialId,
						timeoutSignal,
					);
					const refreshedCredential = mergeRefreshedUsageCredential(request.credential, refreshed);
					this.persistRefreshedCredential(
						request.provider,
						request.credential,
						refreshedCredential,
						refreshableCredentialId,
					);
					params = {
						...request,
						credential: refreshedCredential,
						accountKey: usageCacheIdentity(refreshedCredential),
						signal: timeoutSignal,
					};
				} catch (error) {
					const errorMsg = String(error);
					if (request.credential.expiresAt <= Date.now() && AIError.isDefinitiveOAuthFailure(errorMsg)) {
						// The current access token is unusable, so don't replay an
						// old usage report after its rotating refresh token is revoked.
						// This changes cache state only; usage polling remains
						// non-authoritative about the credential lifecycle.
						this.#deps.cache.set(this.#deps.cache.reportKey(request), {
							value: null,
							expiresAt: 0,
						});
					}
					// Usage polling is advisory. A refresh can fail while the current
					// access token remains valid inside the refresh skew, so probe with
					// that token and never mutate credential state from this path.
					this.logger?.debug("Usage credential refresh failed, using original credential", {
						provider: request.provider,
						error: errorMsg,
					});
				}
			}
		}

		if (providerImpl.supports && !providerImpl.supports(params)) return null;

		try {
			const report = await providerImpl.fetchUsage(params, {
				fetch: this.fetch,
				logger: this.logger,
			});
			// Attribute the report to the credential's organization. The orgId and
			// orgName fallbacks apply independently: Claude's usage endpoint stamps
			// orgId from the `anthropic-organization-id` response header but never
			// carries a display name, so the stored name must still be attached.
			// Never attach the stored name over a DIFFERENT org's report.
			if (report && params.credential.orgId !== undefined) {
				const metadata = report.metadata ?? {};
				const sameOrg = metadata.orgId === undefined || metadata.orgId === params.credential.orgId;
				const needsOrgId = metadata.orgId === undefined;
				const needsOrgName = sameOrg && params.credential.orgName !== undefined && metadata.orgName === undefined;
				if (needsOrgId || needsOrgName) {
					report.metadata = {
						...metadata,
						...(needsOrgId ? { orgId: params.credential.orgId } : {}),
						...(needsOrgName ? { orgName: params.credential.orgName } : {}),
					};
				}
			}
			return report;
		} catch (error) {
			if (error instanceof AIError.ProviderHttpError && (error.status === 401 || error.status === 403)) {
				// Definitive auth failure (revoked key, lapsed subscription): purge
				// the last-good report so #fetchUsageCached's failure branch can't
				// keep rendering and ranking from stale quota the way it does for
				// transient failures. Mirrors the definitive-OAuth-refresh path.
				this.#deps.cache.set(this.#deps.cache.reportKey(request), {
					value: null,
					expiresAt: 0,
				});
			}
			logger.debug("AuthStorage usage fetch failed", {
				provider: request.provider,
				error: String(error),
			});
			return null;
		}
	}

	/** Cache a credential report with jitter and failure cooldown. */
	async #fetchUsageCached(
		request: UsageRequestDescriptor,
		options: { timeoutMs?: number; forceRefresh?: boolean } = {},
	): Promise<UsageReport | null> {
		const timeoutMs = options.timeoutMs;
		const forceRefresh = options.forceRefresh ?? false;
		const cacheKey = this.#deps.cache.reportKey(request);

		const now = Date.now();
		const cached = forceRefresh ? undefined : this.#deps.cache.get<UsageReport | null>(cacheKey);
		// Fresh cache hit: return whatever's there (success or null fallback).
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const usageCacheEpoch = this.#deps.cache.epoch;
		const inFlightKey = `${cacheKey}\0${usageCacheEpoch}`;
		const inFlight = this.#usageRequestInFlight.get(inFlightKey);
		if (inFlight) return inFlight;
		const promise = (async () => {
			const report = await this.#fetchUsageUncached(request, timeoutMs);
			if (usageCacheEpoch !== this.#deps.cache.epoch) return report;
			const ttlJitter = USAGE_REPORT_TTL_MS * (Math.random() * 0.5 - 0.25);
			if (report !== null) {
				// Success: stagger per-credential cache expiry so all accounts don't
				// refresh in the same window — Anthropic / OpenAI rate-limit `/usage`
				// per source IP regardless of account, and synchronized 5-credential
				// fan-out trips 429s every cycle. With ±25% jitter on TTL the refresh
				// times decorrelate within a few cycles.
				this.#deps.cache.set(cacheKey, {
					value: report,
					expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter,
				});
				this.#recordUsageHistory(request, report);
				this.#deps.blocks.reconcileRequest(request, report);
				return report;
			}
			// Failure: apply a short jittered cool-down so the credential doesn't
			// re-hit the endpoint on every poll. Most providers serve the last good
			// value through transient failures. Session-cookie providers can opt out
			// so an expired login does not display stale quota indefinitely.
			const providerImpl = this.providerFor(request.provider);
			const retainLastGood = !forceRefresh && providerImpl?.retainLastGoodOnFailure !== false;
			const lastGood = retainLastGood
				? (this.#deps.cache.getStale<UsageReport | null>(cacheKey)?.value ?? null)
				: null;
			const failureBackoffMs = providerImpl?.failureBackoffMs ?? USAGE_FAILURE_BACKOFF_MS;
			const backoffJitter = failureBackoffMs * (Math.random() * 0.5 - 0.25);
			const coolDown = Date.now() + failureBackoffMs + backoffJitter;
			this.#deps.cache.set(cacheKey, { value: lastGood, expiresAt: coolDown });
			return lastGood;
		})().finally(() => {
			this.#usageRequestInFlight.delete(inFlightKey);
		});

		this.#usageRequestInFlight.set(inFlightKey, promise);
		return promise;
	}

	/**
	 * Append a freshly fetched report to durable usage history (when the store
	 * supports it). The usage cache is latest-snapshot-only — these rows are
	 * the only place limit utilization is kept over time.
	 */
	#recordUsageHistory(request: UsageRequestDescriptor, report: UsageReport): void {
		const record = this.#deps.store.recordUsageSnapshots;
		if (!record || report.limits.length === 0) return;
		const recordedAt = Number.isFinite(report.fetchedAt) && report.fetchedAt > 0 ? report.fetchedAt : Date.now();
		const accountKey = usageCacheIdentity(request.credential);
		const metadata = report.metadata ?? {};
		const metaEmail = typeof metadata.email === "string" ? metadata.email : undefined;
		const metaAccountId = typeof metadata.accountId === "string" ? metadata.accountId : undefined;
		const entries: UsageHistoryEntry[] = report.limits.map(limit => ({
			recordedAt,
			provider: request.provider,
			accountKey,
			email: request.credential.email ?? metaEmail,
			accountId: request.credential.accountId ?? limit.scope.accountId ?? metaAccountId,
			limitId: limit.id,
			label: limit.label,
			windowLabel: limit.window?.label ?? limit.scope.windowId,
			usedFraction: resolveUsedFraction(limit),
			status: limit.status,
			resetsAt: limit.window?.resetsAt,
		}));
		try {
			record.call(this.#deps.store, entries);
		} catch (error) {
			this.logger?.debug("usage history record failed", {
				provider: request.provider,
				error: String(error),
			});
		}
	}

	/**
	 * Recorded usage-limit snapshots, oldest first. Empty when the underlying
	 * store has no durable history (e.g. a broker-backed remote store).
	 */
	history(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.#deps.store.listUsageHistory?.(query) ?? [];
	}

	/**
	 * Forward one completed request's usage to the store's observer hook.
	 * Broker-backed stores batch these into per-install reports so the broker
	 * can track actual token burn per client; local stores have no hook and
	 * the call is a no-op.
	 */
	observe(entry: ObservedUsageInput): void {
		const record = this.#deps.store.recordObservedUsage;
		if (!record) return;
		try {
			record.call(
				this.#deps.store,
				[
					{
						at: entry.at ?? Date.now(),
						provider: entry.provider,
						model: entry.model,
						requests: 1,
						inputTokens: entry.usage.input,
						outputTokens: entry.usage.output,
						cacheReadTokens: entry.usage.cacheRead,
						cacheWriteTokens: entry.usage.cacheWrite,
						costUsd: Number.isFinite(entry.costUsd) ? (entry.costUsd ?? 0) : 0,
					},
				],
				entry.client,
			);
		} catch (error) {
			this.logger?.debug("observed usage record failed", {
				provider: entry.provider,
				error: String(error),
			});
		}
	}

	/** Broker host: persist one client's observed-usage report (per-install token burn). */
	recordClient(report: ClientUsageReport): boolean {
		const record = this.#deps.store.recordClientUsage;
		if (!record) return false;
		record.call(this.#deps.store, report);
		return true;
	}

	/** Broker host: aggregate recorded per-client usage since `sinceMs`. */
	clientSummary(sinceMs: number): ClientUsageSummary {
		return this.#deps.store.getClientUsageSummary?.(sinceMs) ?? { clients: [] };
	}

	/** Merge rate-limit headers into the latest account report. */
	ingestHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string; responseStatus?: number },
	): boolean {
		const parseHeaders = this.providerFor(provider)?.parseRateLimitHeaders;
		if (!parseHeaders) return false;

		const credential = this.#deps.affinity.activeOAuth(provider, options?.sessionId);
		if (!credential) return false;

		const cacheKey = this.#deps.cache.reportKey(oauthUsageRequest(provider, credential, options?.baseUrl));
		const now = Date.now();
		const parsedReport = parseHeaders(headers, now, { responseStatus: options?.responseStatus });
		if (!parsedReport) return false;
		// Throttled to one ingest per interval — except when a window reads
		// exhausted: persist that snapshot immediately. A full-backed cache can
		// then block the next getApiKey; a cold header-only snapshot first probes
		// the usage endpoint.
		const exhausted = parsedReport.limits.some(limit => isUsageLimitExhausted(limit));
		const last = this.#usageHeaderIngestAt.get(cacheKey);
		if (!exhausted && last !== undefined && now - last < USAGE_HEADER_INGEST_INTERVAL_MS) return false;
		const metadata: Record<string, unknown> = { ...parsedReport.metadata };
		if (credential.accountId && metadata.accountId === undefined) metadata.accountId = credential.accountId;
		if (credential.email && metadata.email === undefined) metadata.email = credential.email;
		if (credential.projectId && metadata.projectId === undefined) metadata.projectId = credential.projectId;
		if (credential.orgId && metadata.orgId === undefined) metadata.orgId = credential.orgId;
		if (credential.orgName && metadata.orgName === undefined) metadata.orgName = credential.orgName;
		const report: UsageReport = { ...parsedReport, metadata };

		const storeIngest = this.#deps.store.ingestUsageReport?.bind(this.#deps.store);
		if (storeIngest) {
			const ingested = storeIngest(provider, credential, report);
			if (ingested) this.#usageHeaderIngestAt.set(cacheKey, now);
			return ingested;
		}

		if (this.#deps.store.fetchUsageReports) return false;
		const priorEntry = this.#deps.cache.getStale<UsageReport | null>(cacheKey);
		const prior = priorEntry?.value;
		let merged = report;
		if (prior && Array.isArray(prior.limits)) {
			const headerLimitsById = new Map(report.limits.map(limit => [limit.id, limit]));
			const limits: UsageLimit[] = [];
			for (const limit of prior.limits) {
				const replacement = headerLimitsById.get(limit.id);
				if (replacement) {
					limits.push(replacement);
					headerLimitsById.delete(limit.id);
				} else {
					limits.push(limit);
				}
			}
			for (const limit of headerLimitsById.values()) {
				limits.push(limit);
			}
			merged = {
				...prior,
				fetchedAt: now,
				limits,
				metadata: {
					...report.metadata,
					...prior.metadata,
					source: prior.metadata?.source,
					headersUpdatedAt: now,
				},
			};
		}

		// Header ingestion merges values but never extends a cache entry's lifetime.
		// Preserve the existing expiry (including active failure cooldowns) so full
		// reports refetch on their original 5-minute schedule and full-payload-only
		// rows such as extra usage stay current; headers only refresh window rows
		// between fetches. A newly minted header-only report is durable but stale.
		const expiresAt = Math.max(priorEntry?.expiresAt ?? now - 1, now - 1);
		this.#deps.cache.set(cacheKey, { value: merged, expiresAt });
		this.#usageHeaderIngestAt.set(cacheKey, now);
		return true;
	}

	/** Collect resolved account requests for all configured usage providers. */
	async #collectUsageRequests(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
	}): Promise<UsageRequestDescriptor[]> {
		const requests: UsageRequestDescriptor[] = [];
		const providers = new Set<string>([
			...this.#deps.pool.providers(),
			...this.#runtimeUsageProviderOverrides.keys(),
			...DEFAULT_USAGE_PROVIDERS.map(provider => provider.id),
		]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			const providerImpl = this.providerFor(provider);
			if (!providerImpl) continue;
			const baseUrl = options?.baseUrlResolver?.(provider);
			let entries = this.#deps.pool.entries(providerId);
			if (entries.length > 0) {
				const dedupedEntries = await this.#deps.pool.pruneDuplicates(providerId, entries);
				if (dedupedEntries.length !== entries.length) {
					this.#deps.pool.replace(providerId, dedupedEntries);
				}
				entries = dedupedEntries;
			}

			// A declared OAuth bearer env list means usage probes must ignore stored
			// API keys and borrowed API-key env aliases. Even when an API-key row
			// exists, fall back to the provider's own OAuth env bearer.
			const oauthTokenEnv = authPolicyFor(providerId)?.oauthTokenEnv;
			if (oauthTokenEnv) {
				let hasUsableStoredOAuthCredential = false;
				for (const entry of entries) {
					if (entry.credential.type !== "oauth") continue;
					const request = oauthUsageRequest(provider, entry.credential, baseUrl);
					if (providerImpl.supports && !providerImpl.supports(request)) continue;
					requests.push(request);
					hasUsableStoredOAuthCredential = true;
				}
				const oauthToken = $pickenv(...oauthTokenEnv);
				if (!hasUsableStoredOAuthCredential && oauthToken) {
					const request = usageRequest(provider, { type: "oauth", accessToken: oauthToken }, baseUrl);
					if (!providerImpl.supports || providerImpl.supports(request)) requests.push(request);
				}
				continue;
			}

			if (entries.length === 0) {
				const runtimeKey = this.#deps.overrides.runtimeKey(providerId);
				const extensionUsageKeyConfig = this.#runtimeUsageProviderOverrides.get(provider)?.apiKey,
					extensionUsageKey = extensionUsageKeyConfig
						? await this.#deps.overrides.resolve(extensionUsageKeyConfig)
						: undefined,
					envKey = getEnvApiKey(providerId);
				const apiKey = runtimeKey ?? extensionUsageKey ?? envKey;
				if (!apiKey) continue;
				const request = usageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			for (const entry of entries) {
				const credential = entry.credential;
				let request: UsageRequestDescriptor;
				if (credential.type === "api_key") {
					// Stored keys may be references (env var name, "!command") —
					// resolve to the actual secret before it reaches a provider
					// fetcher's Authorization header. Unresolvable references are
					// skipped: probing with the literal reference string would
					// 401 and flag a working credential as bad.
					const apiKey = await this.#deps.overrides.resolve(credential.key);
					if (!apiKey) continue;
					request = usageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				} else {
					request = oauthUsageRequest(provider, credential, baseUrl);
				}
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
			}
		}

		return requests;
	}

	/** Fetch the best available report for one stored credential. */
	async report(
		provider: Provider,
		credential: AuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		// Store-level hook (e.g. `RemoteAuthCredentialStore`) is authoritative
		// when present for OAuth: the broker already aggregates usage from a
		// less-throttled IP, and falling back to the local per-credential fetch
		// would defeat the point of routing through it. API-key credentials do
		// not have a broker per-credential hook, so they use the normal cached
		// provider fetch path.
		if (credential.type === "oauth") {
			const storeHook = this.#deps.store.getUsageReport?.bind(this.#deps.store);
			if (storeHook) {
				const report = await storeHook(provider, credential, options?.signal);
				if (report) {
					this.#deps.blocks.reconcileRequest(oauthUsageRequest(provider, credential, options?.baseUrl), report);
				}
				return report;
			}
		}
		const usageCredential = buildUsageCredential(credential);
		if (credential.type === "api_key") {
			const resolvedApiKey = await this.#deps.overrides.resolve(credential.key);
			if (!resolvedApiKey) return null;
			usageCredential.apiKey = resolvedApiKey;
		}
		return this.#fetchUsageCached(usageRequest(provider, usageCredential, options?.baseUrl), {
			timeoutMs: options?.timeoutMs ?? this.requestTimeoutMs,
		});
	}

	/**
	 * Cache-only read of the last known report for an OAuth credential: fresh or
	 * last-good, never awaited, refreshed in the background when stale. Used by
	 * advisory probes (headroom, sticky ranking gate) that must not block.
	 */
	cachedReport(provider: Provider, credential: OAuthCredential, baseUrl?: string): UsageReport | null {
		return this.#usageReportCacheFirst(provider, credential, baseUrl);
	}

	/**
	 * Cached report for the advisory headroom probe: never awaits a fetch, and
	 * refreshes a stale entry in the background so the next probe sees current
	 * usage. Broker-backed stores own their snapshot, so the hook is fired and
	 * the probe reports "unknown" rather than reading a local cache.
	 */
	#usageReportCacheFirst(provider: Provider, credential: OAuthCredential, baseUrl?: string): UsageReport | null {
		const storeHook = this.#deps.store.getUsageReport?.bind(this.#deps.store);
		if (storeHook) {
			void storeHook(provider, credential).catch(error => {
				this.logger?.debug("Usage store background refresh failed", { provider, error: String(error) });
			});
			return null;
		}
		const request = oauthUsageRequest(provider, credential, baseUrl);
		const cacheKey = this.#deps.cache.reportKey(request);
		const cached =
			this.#deps.cache.get<UsageReport | null>(cacheKey) ?? this.#deps.cache.getStale<UsageReport | null>(cacheKey);
		if (!cached || cached.expiresAt <= Date.now()) {
			void this.#fetchUsageCached(request, { timeoutMs: this.requestTimeoutMs }).catch(error => {
				this.logger?.debug("Usage background refresh failed", { provider, error: String(error) });
			});
		}
		return cached?.value ?? null;
	}

	/** Classify quota windows by duration first, then provider id conventions. */
	#classifyUsageWindow(limit: UsageLimit): UsageWindowKind {
		const durationMs = limit.window?.durationMs;
		if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
			const fiveHoursMs = 18_000_000;
			const weeklyMs = 604_800_000;
			if (Math.abs(durationMs - fiveHoursMs) <= fiveHoursMs * 0.2) return "5h";
			if (Math.abs(durationMs - weeklyMs) <= weeklyMs * 0.2) return "weekly";
		}
		const id = limit.id.toLowerCase();
		if (id.includes("5h") || id.includes(":primary")) return "5h";
		if (id.includes("7d") || id.includes("week") || id.includes(":secondary")) return "weekly";
		return "other";
	}

	/**
	 * Synchronous, advisory headroom probe for model routing. It reuses the same
	 * model-scoped ranking strategy and credential blocks as OAuth selection, but
	 * never resolves/mints tokens or waits on usage fetches.
	 */
	headroom(model: Model<Api>, opts?: { utilizationMax?: number; windowMode?: "all" | "any" }): UsageHeadroom {
		const provider = model.provider;
		const rankingContext: CredentialRankingContext = { modelId: model.id };
		const strategy = this.#deps.strategies(provider);
		const utilizationMax =
			typeof opts?.utilizationMax === "number" && Number.isFinite(opts.utilizationMax)
				? opts.utilizationMax
				: HEADROOM_UTILIZATION_MAX;
		const windowMode = opts?.windowMode === "any" ? "any" : "all";
		// Explicit API-key overrides shadow stored OAuth rows, so their headroom is optimistic.
		if (this.#deps.overrides.has(provider)) return { hasRoom: true };
		const entries = this.#deps.pool.entries(provider);
		if (entries.length === 0) return { hasRoom: true };

		const nowMs = Date.now();
		let blockedCount = 0;
		let credentialResetAtMs: number | undefined;
		let exhaustedBlock: UsageHeadroomBlock | undefined;
		let utilizationBlock: UsageHeadroomBlock | undefined;
		let lastWindows: UsageHeadroomWindow[] | undefined;

		for (const [index, entry] of entries.entries()) {
			const { credential } = entry;
			const providerKey = providerTypeKey(provider, credential.type);
			const blockScope =
				credential.type === "oauth"
					? (strategy?.blockScope?.(rankingContext) ?? strategy?.backoffScope?.(rankingContext.modelId))
					: undefined;
			const blockedUntil = this.#deps.blocks.blockedUntil(provider, providerKey, index, blockScope);
			if (blockedUntil !== undefined) {
				blockedCount += 1;
				if (credentialResetAtMs === undefined || blockedUntil < credentialResetAtMs) {
					credentialResetAtMs = blockedUntil;
				}
				continue;
			}

			// Non-OAuth credentials and providers without ranking strategies stay fail-open.
			if (credential.type !== "oauth" || !strategy) return { hasRoom: true };

			const report = this.#usageReportCacheFirst(provider, credential);
			// A cache miss, broker `null` report, or no scoped rows cannot block routing.
			if (!report) return { hasRoom: true };

			const scopedLimits = scopedUsageLimits(strategy, report, rankingContext);
			if (scopedLimits.length === 0) return { hasRoom: true };

			const windows: UsageHeadroomWindow[] = [];
			const primaryWindowStates: Array<{ blocked: boolean; block?: UsageHeadroomBlock }> = [];
			const otherWindowStates: Array<{ blocked: boolean; block?: UsageHeadroomBlock }> = [];
			let credentialExhaustedBlock: UsageHeadroomBlock | undefined;
			let credentialAllModeBlock: UsageHeadroomBlock | undefined;

			for (const limit of scopedLimits) {
				const kind = this.#classifyUsageWindow(limit);
				// Report every evaluated window with normalized usage when available.
				const usedFraction = resolveUsedFraction(limit);
				const hasUsedFraction = typeof usedFraction === "number" && Number.isFinite(usedFraction);
				const resetsAt = windowResetAt(limit.window);
				// Stale windows are treated as already reset and excluded from blocking.
				const stale = resetsAt !== undefined && resetsAt <= nowMs;
				const window: UsageHeadroomWindow = { kind, exhausted: stale ? false : isUsageLimitExhausted(limit) };
				if (hasUsedFraction) window.usedFraction = usedFraction;
				if (resetsAt !== undefined) window.resetsAt = resetsAt;
				windows.push(window);

				if (stale) {
					// Stale reset windows are nonblocking but still satisfy any-mode.
					const state: { blocked: boolean } = { blocked: false };
					if (kind === "other") {
						otherWindowStates.push(state);
					} else {
						primaryWindowStates.push(state);
					}
					continue;
				}

				const block: UsageHeadroomBlock = { kind, windows };
				if (window.usedFraction !== undefined) block.usedFraction = window.usedFraction;
				if (resetsAt !== undefined) block.resetAtMs = resetsAt;

				// A non-stale exhausted scoped window is a hard gate in every mode.
				if (window.exhausted) {
					credentialExhaustedBlock = chooseEarlierUsageHeadroomBlock(credentialExhaustedBlock, block);
					continue;
				}

				// Strict threshold, so room exists only while usage is below utilizationMax.
				const blockedByUtilization = hasUsedFraction && usedFraction >= utilizationMax;
				if (blockedByUtilization) {
					credentialAllModeBlock = chooseEarlierUsageHeadroomBlock(credentialAllModeBlock, block);
				}
				const state: { blocked: boolean; block?: UsageHeadroomBlock } = { blocked: blockedByUtilization };
				if (blockedByUtilization) state.block = block;
				if (kind === "other") {
					otherWindowStates.push(state);
				} else {
					primaryWindowStates.push(state);
				}
			}

			lastWindows = windows;

			if (credentialExhaustedBlock) {
				exhaustedBlock = chooseEarlierUsageHeadroomBlock(exhaustedBlock, credentialExhaustedBlock);
				continue;
			}

			let credentialUtilizationBlock: UsageHeadroomBlock | undefined;
			if (windowMode === "all") {
				// Default all-mode blocks if any classified non-stale window reaches the threshold.
				credentialUtilizationBlock = credentialAllModeBlock;
			} else {
				// Any-mode only fails when every relevant 5h/weekly window blocks; others are fallback-only.
				const relevantStates = primaryWindowStates.length > 0 ? primaryWindowStates : otherWindowStates;
				if (relevantStates.length > 0 && relevantStates.every(state => state.blocked)) {
					for (const state of relevantStates) {
						if (state.block) {
							credentialUtilizationBlock = chooseEarlierUsageHeadroomBlock(
								credentialUtilizationBlock,
								state.block,
							);
						}
					}
				}
			}
			if (credentialUtilizationBlock) {
				utilizationBlock = chooseEarlierUsageHeadroomBlock(utilizationBlock, credentialUtilizationBlock);
				continue;
			}

			return { hasRoom: true, windows };
		}

		if (blockedCount === entries.length) {
			const result: UsageHeadroom = { hasRoom: false, reason: "credential-blocked" };
			if (credentialResetAtMs !== undefined) result.resetAtMs = credentialResetAtMs;
			return result;
		}
		if (exhaustedBlock) {
			const result: UsageHeadroom = { hasRoom: false, reason: "window-exhausted", window: exhaustedBlock.kind };
			if (exhaustedBlock.resetAtMs !== undefined) result.resetAtMs = exhaustedBlock.resetAtMs;
			if (lastWindows && lastWindows.length > 0) result.windows = lastWindows;
			return result;
		}
		if (utilizationBlock) {
			const result: UsageHeadroom = {
				hasRoom: false,
				reason: "window-utilization",
				window: utilizationBlock.kind,
			};
			if (utilizationBlock.resetAtMs !== undefined) result.resetAtMs = utilizationBlock.resetAtMs;
			if (lastWindows && lastWindows.length > 0) result.windows = lastWindows;
			return result;
		}

		return { hasRoom: true };
	}

	/**
	 * The credential a completed request is attributed to: the session's active
	 * credential when known, the provider's only credential, else the env key.
	 * Returns undefined for an ambiguous pool, so cost history never guesses.
	 */
	#observedCredential(provider: Provider, sessionId?: string): UsageCredential | undefined {
		const entries = this.#deps.pool.entries(provider);
		const sessionCredential = this.#deps.affinity.get(provider, sessionId);
		const tracked = sessionCredential ? entries[sessionCredential.index]?.credential : undefined;
		if (tracked) return buildUsageCredential(tracked);
		const only = entries.length === 1 ? entries[0]?.credential : undefined;
		if (only) return buildUsageCredential(only);
		const envKey = getEnvApiKey(provider);
		if (envKey) return { type: "api_key", apiKey: envKey };
		return undefined;
	}

	/** Record one observed provider request cost for later local usage aggregation. */
	recordCost(
		provider: Provider,
		costUsd: number,
		options?: { sessionId?: string; recordedAt?: number; baseUrl?: string },
	): boolean {
		if (!Number.isFinite(costUsd) || costUsd <= 0) return false;
		const record = this.#deps.store.recordUsageCosts;
		if (!record) return false;
		const credential = this.#observedCredential(provider, options?.sessionId);
		if (!credential) return false;
		const entry: UsageCostHistoryEntry = {
			recordedAt: options?.recordedAt ?? Date.now(),
			provider,
			accountKey: usageCacheIdentity(credential),
			costUsd,
		};
		try {
			record.call(this.#deps.store, [entry]);
			// Expire the cached report so the next probe re-reads quota instead of
			// serving a snapshot taken before this spend.
			const cacheKey = this.#deps.cache.reportKey(usageRequest(provider, credential, options?.baseUrl));
			const existing = this.#deps.cache.getStale<UsageReport | null>(cacheKey);
			this.#deps.cache.set(cacheKey, { value: existing?.value ?? null, expiresAt: Date.now() - 1 });
			return true;
		} catch (error) {
			this.logger?.debug("usage cost record failed", { provider, error: String(error) });
			return false;
		}
	}

	/** Cache peek for ranking: the last known report, fresh or last-good, without awaiting a fetch. */
	#peekUsageReportForRanking(
		provider: Provider,
		credential: AuthCredential,
		baseUrl?: string,
	): { value: UsageReport | null; fresh: boolean } | undefined {
		// The broker hook and api-key path bypass the usage cache, so there is
		// nothing to peek at and the caller must take the awaited path.
		if (credential.type !== "oauth" || this.#deps.store.getUsageReport) return undefined;
		const cacheKey = this.#deps.cache.reportKey(oauthUsageRequest(provider, credential, baseUrl));
		const entry = this.#deps.cache.getStale<UsageReport | null>(cacheKey);
		if (!entry) return undefined;
		return { value: entry.value, fresh: entry.expiresAt > Date.now() };
	}

	/**
	 * Usage report for ranking. A cold credential is awaited outright so an
	 * empty cache cannot bypass known-exhausted or explicitly allowed accounts.
	 * A stale credential gets a microtask-scale grace: a provider that answers
	 * immediately (or from its own cache) still re-ranks on current usage, while
	 * a slow endpoint falls back to the last-good report instead of blocking
	 * `getApiKey`. The refresh keeps running either way and lands in the cache
	 * for the next call.
	 */
	async reportForRanking(
		provider: Provider,
		credential: AuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		const peeked = this.#peekUsageReportForRanking(provider, credential, options?.baseUrl);
		if (!peeked) return this.report(provider, credential, options);
		if (peeked.fresh) return peeked.value;
		const refresh = this.report(provider, credential, options).catch(() => null);
		const graceExpired = Promise.withResolvers<typeof STALE_REFRESH_GRACE_EXPIRED>();
		const timer = setTimeout(
			() => graceExpired.resolve(STALE_REFRESH_GRACE_EXPIRED),
			USAGE_RANKING_STALE_REFRESH_GRACE_MS,
		);
		timer.unref?.();
		const winner = await Promise.race([refresh, graceExpired.promise]);
		clearTimeout(timer);
		return winner === STALE_REFRESH_GRACE_EXPIRED ? peeked.value : winner;
	}

	/**
	 * Return model ids whose live reports map to a quantitative usage scope.
	 * Provider strategies supply model/tier mapping when available; otherwise
	 * only explicitly matching model ids and account-wide shared limits count.
	 * Label-only or ambiguous tier limits are excluded rather than guessed.
	 */
	reportingModelIds(provider: Provider, modelIds: readonly string[], reports: readonly UsageReport[]): string[] {
		const strategy = this.#deps.strategies(provider);
		const providerReports = reports.filter(report => report.provider === provider);
		if (providerReports.length === 0) return [];
		const seen = new Set<string>();
		const reporting: string[] = [];
		for (const modelId of modelIds) {
			if (seen.has(modelId)) continue;
			seen.add(modelId);
			const context: CredentialRankingContext = { modelId };
			const hasUsage = providerReports.some(report => {
				const limits = strategy
					? scopedUsageLimits(strategy, report, context)
					: report.limits.filter(limit => limit.scope.shared === true || limit.scope.modelId === modelId);
				return limits.some(limit => isUsageLimitExhausted(limit) || resolveUsedFraction(limit) !== undefined);
			});
			if (hasUsage) reporting.push(modelId);
		}
		return reporting;
	}

	/**
	 * Fetch every requested report, keeping normal polls parallel while a
	 * manually invalidated provider probes accounts one at a time.
	 */
	#fetchUsageRequests(
		requests: readonly UsageRequestDescriptor[],
		serializedProviders: ReadonlySet<Provider>,
	): Promise<Array<UsageReport | null>> {
		const tails = new Map<Provider, Promise<void>>();
		return Promise.all(
			requests.map(request => {
				const forceRefresh = serializedProviders.has(request.provider);
				if (!forceRefresh) {
					return this.#fetchUsageCached(request, {
						timeoutMs: this.requestTimeoutMs,
					});
				}
				const tail = tails.get(request.provider) ?? Promise.resolve();
				const current = tail.then(() =>
					this.#fetchUsageCached(request, {
						timeoutMs: this.requestTimeoutMs,
						forceRefresh: true,
					}),
				);
				tails.set(
					request.provider,
					current.then(
						() => undefined,
						() => undefined,
					),
				);
				return current;
			}),
		);
	}

	/** Fetch all providers’ current usage reports, sharing concurrent polls. */
	async reports(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
		/** Caller's cancel signal; only rejects this caller, never the shared upstream fetch. */
		signal?: AbortSignal;
	}): Promise<UsageReport[] | null> {
		// Store-level hook > local per-credential fan-out. `RemoteAuthCredentialStore`
		// implements the hook so a gateway backed by a broker routes usage to the
		// broker without the caller wiring it explicitly.
		const storeOverride = this.#deps.store.fetchUsageReports?.bind(this.#deps.store);
		if (storeOverride) {
			// Reuse the in-flight map so concurrent callers (widget poll + format
			// dispatch + credential selection) coalesce into one upstream call.
			// Each caller's `signal` only cancels THAT caller's await; the
			// shared upstream fetch runs to completion so peers aren't punished.
			const overrideKey = `__override__\0${this.#deps.cache.epoch}`;
			let shared = this.#usageReportsInFlight.get(overrideKey);
			if (!shared) {
				// Don't forward the caller signal into the shared fetch — first caller's
				// abort would otherwise cancel the upstream for every peer.
				shared = storeOverride().finally(() => {
					this.#usageReportsInFlight.delete(overrideKey);
				});
				this.#usageReportsInFlight.set(overrideKey, shared);
			}
			const reports = await raceSignal(shared, options?.signal, "usage fetch aborted");
			if (reports) this.#deps.blocks.reconcileReports(reports);
			return reports;
		}
		const requests = await this.#collectUsageRequests(options);
		if (requests.length === 0) return [];

		this.logger?.debug("Usage fetch requested", {
			providers: [...new Set(requests.map(request => request.provider))].sort(),
		});

		// Per-credential caching with jitter lives in #fetchUsageCached, so we
		// don't store the aggregated result here — doing so locks the widget to
		// a single decorrelation snapshot for 30s, defeating the jitter (some
		// accounts can be missing from one fetch and present in the next; the
		// aggregate cache freezes whichever set landed first).
		const forcedRefresh = this.#deps.cache.forcedRefresh(requests);
		const cacheKey = `${this.#deps.cache.reportsKey(requests)}\0${this.#deps.cache.epoch}`;

		const inFlight = this.#usageReportsInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const promise = (async () => {
			for (const request of requests) {
				this.logger?.debug("Usage fetch queued", {
					provider: request.provider,
					credentialType: request.credential.type,
					baseUrl: request.baseUrl,
					accountId: request.credential.accountId,
					email: request.credential.email,
				});
			}

			const results = await this.#fetchUsageRequests(requests, forcedRefresh.providers);
			const reports = results.filter((report): report is UsageReport => report !== null);
			const deduped = dedupeUsageReports(reports, this.logger);
			// no outer cache write — see comment above.
			const resolved = deduped;
			this.logger?.debug("Usage fetch resolved", {
				reports: resolved.map(report => {
					const accountLabel =
						usageReportMetadataValue(report, "email") ??
						usageReportMetadataValue(report, "accountId") ??
						usageReportMetadataValue(report, "account") ??
						usageReportMetadataValue(report, "user") ??
						usageReportMetadataValue(report, "username") ??
						usageReportScopeAccountId(report);
					return {
						provider: report.provider,
						limits: report.limits.length,
						account: accountLabel,
					};
				}),
			});
			this.#deps.cache.clearForceRefresh(forcedRefresh);
			return resolved;
		})().finally(() => {
			this.#usageReportsInFlight.delete(cacheKey);
		});

		this.#usageReportsInFlight.set(cacheKey, promise);
		return promise;
	}

	/**
	 * Discard cached usage reports before a user-requested refresh. The next
	 * read probes upstream serially per provider; a failure reports no fresh
	 * usage instead of replaying an invalidated last-good snapshot.
	 */
	async invalidate(provider?: string, signal?: AbortSignal): Promise<void> {
		await this.#deps.cache.clearReports(provider, () => this.#collectUsageRequests());

		if (this.#deps.store.invalidateUsageCache) {
			await this.#deps.store.invalidateUsageCache(signal).catch(err => {
				logger.debug("Failed to notify store of stale usage", { err });
			});
		}
	}
}
