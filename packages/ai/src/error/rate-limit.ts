/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

import { getHeadersFromError, getRetryAfterMsFromHeaders, type HeadersLike } from "../utils/retry-after";

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s
export const ROTATION_RETRY_AFTER_THRESHOLD_MS = 5 * 60_000;

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const SPEND_LIMIT_PATTERN = /spend.?limit/i;
const OPENROUTER_DAILY_FREE_LIMIT_PATTERN = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;

/**
 * Classify a rate-limit error message into a reason category.
 * Priority order: QUOTA (Antigravity "quota will reset") > MODEL_CAPACITY > QUOTA (account) >
 * RATE_LIMIT > QUOTA (generic) > SERVER_ERROR > UNKNOWN.
 *
 * "resource exhausted" maps to MODEL_CAPACITY (transient, short wait)
 * "quota exceeded" / "quota will reset" maps to QUOTA_EXHAUSTED (long wait, switch account)
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const lower = errorMessage.toLowerCase();

	// Antigravity / Cloud Code Assist surface multi-hour daily-quota exhaustion as
	// "You have exhausted your capacity on this model. Your quota will reset after …".
	// The literal "capacity" used to pre-empt the QUOTA branch even though "quota
	// will reset" is the long-wait signal — short-circuit here before the
	// MODEL_CAPACITY fallthrough so credential rotation (not 60s backoff) kicks in.
	if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("capacity") ||
		lower.includes("overloaded") ||
		lower.includes("529") ||
		lower.includes("503") ||
		lower.includes("resource exhausted")
	) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (SPEND_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque")
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		USAGE_LIMIT_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF_MS;
		default:
			return QUOTA_EXHAUSTED_BACKOFF_MS; // conservative default
	}
}

/** Detect usage/quota limit errors in error messages (persistent, requires credential switch). */
// Anthropic's account-local low-credit sentence remains precise; explicit xAI-origin
// account-cap phrases are intentionally provider-agnostic outcome signals so callers
// rotate an exhausted sibling instead of treating the response as a bad credential.
const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|balance.?exhausted|\bcredit[\W_]*balance[\W_]*is[\W_]*too[\W_]*low[\W_]*to[\W_]*access[\W_]*the[\W_]*anthropic[\W_]*api\b|run out of credits|out of credits|spending[- _]?limit|personal-team-blocked/i;
const RETRY_AFTER_MS_HINT_PATTERN = /\bretry-after-ms\s*[:=]\s*(\d+(?:\.\d+)?)/i;

function parseRetryAfterMsValue(value: string | undefined | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function getRetryAfterMsHeader(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) return parseRetryAfterMsValue(headers.get("retry-after-ms"));
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "retry-after-ms") return parseRetryAfterMsValue(value);
	}
	return undefined;
}

/**
 * HTTP status codes that, absent richer body classification, represent an
 * account-local usage cap rather than a bad credential or a transient blip.
 * HTTP 402 Payment Required is categorically an account-billing cap (xAI
 * Grok Build "usage balance exhausted", DeepSeek "Insufficient Balance",
 * OpenRouter credit exhaustion) — never a transient blip or bad credential.
 * Always combine with {@link isUsageLimitOutcome} when a message is available
 * — a 429 carrying transient rate-limit wording is NOT a usage cap.
 */
export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429 || status === 402;
}

export function extractRotationRetryAfterMs(error: unknown, message?: string): number | undefined {
	const headers = getHeadersFromError(error);
	const fromRetryAfterMsHeader = getRetryAfterMsHeader(headers);
	if (fromRetryAfterMsHeader !== undefined) return fromRetryAfterMsHeader;
	const fromHeaders = getRetryAfterMsFromHeaders(headers);
	if (fromHeaders !== undefined) return fromHeaders;
	const text = message ?? (error instanceof Error ? error.message : typeof error === "string" ? error : undefined);
	if (!text) return undefined;
	const match = RETRY_AFTER_MS_HINT_PATTERN.exec(text);
	if (!match) return undefined;
	return parseRetryAfterMsValue(match[1]!);
}

/**
 * Returns true for failures that should burn one credential and rotate to a
 * sibling account. Decision tree:
 *
 *  1. Body matches {@link isUsageLimitError} (Codex `usage_limit_reached`,
 *     Anthropic account rate-limit, Google `resource_exhausted`, OpenAI
 *     `insufficient_quota`, …) → rotate.
 *  2. Status is not a usage-limit status (429/402) → backoff (caller's domain).
 *  3. Body is absent or {@link isOpaqueStatusBody opaque} (just the status,
 *     empty JSON, HTTP framing only) → rotate conservatively: the server
 *     gave us nothing else to go on.
 *  4. Body has content → defer to {@link parseRateLimitReason}. Only
 *     `QUOTA_EXHAUSTED` rotates; `RATE_LIMIT_EXCEEDED` (`Too many requests`,
 *     per-minute caps), `MODEL_CAPACITY_EXHAUSTED` (`Service overloaded`),
 *     `SERVER_ERROR`, and `UNKNOWN` (`Please retry in 5s`) stay in the
 *     provider's own backoff layer so transient 429s don't burn sibling
 *     credentials.
 *  5. Body classifies as transient but carries a retry-after at or above
 *     {@link ROTATION_RETRY_AFTER_THRESHOLD_MS} → rotate. Long 429 retry hints
 *     mean account-level exhaustion in providers that use `rate_limit_error`
 *     for both per-minute throttles and multi-hour account caps.
 */
export function isUsageLimitOutcome(
	status: number | undefined,
	message: string | undefined,
	retryAfterMs?: number,
): boolean {
	if (message && matchesUsageLimitText(message)) return true;
	if (!isUsageLimitStatus(status)) return false;
	if (!message || isOpaqueStatusBody(message)) return true;
	if (parseRateLimitReason(message) === "QUOTA_EXHAUSTED") return true;
	const retryAfter = retryAfterMs ?? extractRotationRetryAfterMs(undefined, message);
	return retryAfter !== undefined && retryAfter >= ROTATION_RETRY_AFTER_THRESHOLD_MS;
}

/**
 * A usage-limit status body is opaque when it carries no signal beyond the
 * status itself — empty, whitespace-only, the status digits with HTTP/JSON
 * framing, or generic punctuation. Anything else (retry hints, capacity
 * wording, error descriptions) is informative enough to defer to the
 * classifier.
 */
export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b(?:429|402)\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "");
	return !/[a-z\d]{3,}/i.test(cleaned);
}

/**
 * Internal text matcher for usage/quota-limit phrasing. NOT part of the public
 * API — callers classify through {@link import("./flags").isUsageLimit} (the
 * flag accessor). `flags.ts` consumes this to populate `Flag.UsageLimit`, and
 * {@link isUsageLimitOutcome} uses it for the account-rotation decision.
 */
export function matchesUsageLimitText(errorMessage: string): boolean {
	return (
		USAGE_LIMIT_PATTERN.test(errorMessage) ||
		SPEND_LIMIT_PATTERN.test(errorMessage) ||
		ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage) ||
		OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)
	);
}
