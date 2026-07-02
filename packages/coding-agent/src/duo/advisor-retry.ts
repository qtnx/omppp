import { getHeadersFromError, getRetryAfterMsFromHeaders } from "@oh-my-pi/pi-ai/utils/retry-after";

export const ADVISOR_RETRY_BASE_MS = 30_000;
export const ADVISOR_RETRY_CAP_MS = 600_000;

/**
 * Delay before the next advisor revival attempt. Honors a server retry-after
 * (capped) else exponential backoff base 30s, factor 2, capped 10min. attempt
 * is 0-based (0 = first retry).
 */
export function computeAdvisorRetryDelay(attempt: number, retryAfterMs?: number): number {
	if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, ADVISOR_RETRY_CAP_MS);
	const backoff = ADVISOR_RETRY_BASE_MS * 2 ** Math.max(0, attempt);
	return Math.min(backoff, ADVISOR_RETRY_CAP_MS);
}

export function parseRetryAfterMs(err: unknown): number | undefined {
	const structured = getStructuredRetryAfterMs(err);
	if (structured !== undefined) return structured;

	const headerRetryAfter = getRetryAfterMsFromHeaders(getHeadersFromError(err));
	if (headerRetryAfter !== undefined) return headerRetryAfter;

	const message = getErrorMessage(err);
	if (!message) return undefined;
	const match = /retry-after-ms=(\d+)/i.exec(message);
	return match ? Number(match[1]) : undefined;
}

function getStructuredRetryAfterMs(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	if ("retryAfterMs" in value) {
		const retryAfterMs = value.retryAfterMs;
		if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
	}
	if ("retryAfter" in value) {
		const retryAfter = value.retryAfter;
		if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
	}
	if ("cause" in value) return getStructuredRetryAfterMs(value.cause);
	return undefined;
}

function getErrorMessage(err: unknown): string | undefined {
	if (err instanceof Error) return err.message;
	return typeof err === "string" ? err : undefined;
}
