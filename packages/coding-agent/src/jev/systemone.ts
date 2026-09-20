/**
 * Shared TypeSafe "System One" HTTP client (Jev).
 *
 * Transport, environment resolution, and answer validation for every
 * conversation with a System One endpoint: the browser Jev policy, live-learning
 * relevance scoring, and the live-learning novelty check. Nothing here knows
 * about the browser DOM or the learning store — callers compose their own
 * `state` and `questions` and map errors onto their own surface.
 *
 * The proxy default needs no local key; an explicitly empty
 * `TYPESAFE_SYSTEMONE_URL` disables the capability, and callers must treat the
 * empty endpoint as "unavailable" rather than an error.
 */

export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_MODEL_ENV = "TYPESAFE_MODEL";
export const JEV_ENDPOINT_ENV = "TYPESAFE_SYSTEMONE_URL";
/** The tailnet proxy holds the key; point the endpoint at TypeSafe directly to need a local one. */
export const JEV_PROXY_ENDPOINT = "http://codemc:8791/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";

/** Jev is on whenever the TypeSafe key is present in the environment. */
export function jevApiKey(): string | undefined {
	const key = Bun.env[JEV_API_KEY_ENV]?.trim();
	return key ? key : undefined;
}

/**
 * System One endpoint; the proxy default needs no local key.
 * An explicitly empty variable disables the capability — that is the documented
 * "leave empty to disable" switch, so it must be distinguished from the
 * variable being unset.
 */
export function jevEndpoint(): string {
	const override = Bun.env[JEV_ENDPOINT_ENV];
	if (override !== undefined) return override.trim();
	return JEV_PROXY_ENDPOINT;
}

/** Whether any System One conversation is possible for this process. */
export function jevAvailable(): boolean {
	return jevEndpoint() !== "";
}

/** Selected Jev model (env override or the versioned default). */
export function jevModel(): string {
	return Bun.env[JEV_MODEL_ENV]?.trim() || JEV_DEFAULT_MODEL;
}

export type JevNoulQuestion = {
	type: "noul";
	instructions: string | object;
	criteria?: { true?: string; false?: string };
};

export type JevChoiceQuestion = {
	type: "choice";
	instructions: string | object;
	criteria: Record<string, string | null>;
};

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;

export interface JevRequest {
	model: string;
	state: unknown;
	questions: Record<string, JevQuestion>;
}

export interface JevResponse {
	model?: string;
	answers: Record<string, unknown>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevChoice {
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export type JevErrorKind = "connection" | "http" | "unavailable" | "invalid" | "aborted";

/** Transport and validation failure surfaced to callers that map it onto their own error type. */
export class JevError extends Error {
	readonly kind: JevErrorKind;
	constructor(message: string, kind: JevErrorKind) {
		super(message);
		this.name = "JevError";
		this.kind = kind;
	}
}

/** HTTP statuses that warrant a bounded retry for a System One conversation. */
const RETRY_STATUSES: Record<number, true> = { 429: true, 503: true, 529: true };

/**
 * Unreachable-endpoint breaker. A configured but unreachable Jev would otherwise
 * charge every caller a full connection timeout, turning an advisory signal into
 * latency on the critical path. One failed attempt parks the endpoint; the next
 * caller after the cooldown pays the probe.
 */
const JEV_COOLDOWN_MS = 60_000;
let jevColdUntil = 0;

/** Test seam: forget a recorded outage. */
export function resetJevBreaker(): void {
	jevColdUntil = 0;
}

export interface JevPostOptions {
	apiKey?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	/** Per-attempt request timeout. Default 25s. */
	timeoutMs?: number;
}

/**
 * POST a System One request. Retries 429/503/529 with exponential backoff.
 * Aborts propagate as `JevError` of kind `"aborted"` (callers may re-raise their
 * own abort type); every other transport/HTTP failure is a `JevError`.
 */
export async function postSystemOne(body: JevRequest, opts: JevPostOptions = {}): Promise<JevResponse> {
	const endpoint = jevEndpoint();
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 25_000;
	const headers: Record<string, string> = { "content-type": "application/json" };
	const apiKey = opts.apiKey ?? jevApiKey();
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	// Only the real transport participates: an injected fetch is the caller's own stub.
	const breaker = opts.fetchImpl === undefined;
	if (breaker && Date.now() < jevColdUntil)
		throw new JevError("Jev endpoint is cold after a recent failure", "unavailable");
	for (let attempt = 0; attempt < 3; attempt++) {
		if (opts.signal?.aborted) throw new JevError(`Jev request aborted (${String(opts.signal.reason)})`, "aborted");
		let response: Response;
		try {
			response = await fetchImpl(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: opts.signal
					? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
					: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			if (opts.signal?.aborted) throw new JevError(`Jev request aborted (${String(opts.signal.reason)})`, "aborted");
			if (breaker) jevColdUntil = Date.now() + JEV_COOLDOWN_MS;
			throw new JevError(
				`Jev connection failed (${error instanceof Error ? error.message : String(error)})`,
				"connection",
			);
		}
		if (RETRY_STATUSES[response.status] && attempt < 2) {
			await Bun.sleep(500 * 2 ** attempt);
			continue;
		}
		if (!response.ok) {
			throw new JevError(`Jev returned HTTP ${response.status}`, "http");
		}
		if (breaker) jevColdUntil = 0;
		return (await response.json()) as JevResponse;
	}
	throw new JevError("Jev unavailable", "unavailable");
}

/** Reject any choice answer whose choice, probability set, or normalization is off. */
export function validateChoice(answer: unknown, ids: Iterable<string>): JevChoice {
	const valid = new Set(ids);
	const record = answer as Partial<JevChoice> | undefined;
	const probabilities = record?.probabilities;
	const choice = record?.choice;
	const confidence = record?.confidence;
	const ok =
		typeof choice === "string" &&
		valid.has(choice) &&
		probabilities !== undefined &&
		probabilities !== null &&
		typeof probabilities === "object" &&
		typeof confidence === "number" &&
		Number.isFinite(confidence) &&
		confidence >= 0 &&
		confidence <= 1 &&
		Object.keys(probabilities).length === valid.size &&
		Object.keys(probabilities).every(key => valid.has(key)) &&
		Object.values(probabilities).every(p => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) &&
		Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) < 0.02 &&
		probabilities[choice]! >= Math.max(...Object.values(probabilities)) - 1e-6;
	if (!ok) throw new JevError("Invalid Jev response", "invalid");
	return { choice, confidence, probabilities };
}

/** A noul answer is the probability that the yes/no question is yes. */
export function validateNoul(answer: unknown): number {
	const record = answer as { type?: string; noul?: unknown } | undefined;
	const noul = record?.noul;
	if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
		throw new JevError("Invalid Jev noul response", "invalid");
	}
	return noul;
}
