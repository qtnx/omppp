/**
 * Secrets Sentinel: context-aware secret detection backed by the
 * `hypn05/secrets-sentinel` line classifier, served over HTTP by
 * `scripts/secrets-sentinel/server.py` (codemc on the tailnet by default).
 *
 * The regex detector finds vendor-shaped tokens and keyword assignments; the
 * classifier additionally catches credentials regexes cannot tell apart from
 * code (`redis-server --requirepass s3cr3t`, `curl -u admin:Hunter2!`). Only
 * lines that hold an extractable literal token are sent, and any server
 * failure falls back to regex-only detection for {@link SERVER_DOWN_TTL_MS}.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { type DetectedSecret, detectSecretsInText, extractLineSecretCandidate } from "./detect";

/** Probability (LABEL_1) at or above which a line counts as holding a secret; the model card's production threshold. */
export const SENTINEL_THRESHOLD = 0.85;
/** Server-side request cap (`MAX_LINES` in server.py). */
const MAX_LINES_PER_REQUEST = 512;
/** Lines scanned per text; beyond this the classifier is skipped for the rest and regex detection still applies. */
const MAX_LINES_PER_TEXT = 512;
const MIN_LINE_LENGTH = 8;
const MAX_LINE_LENGTH = 2000;
const REQUEST_TIMEOUT_MS = 5_000;
const SERVER_DOWN_TTL_MS = 60_000;
const SCORE_CACHE_LIMIT = 4096;

export class SentinelClient {
	#serverUrl = "";
	#serverDownUntil = 0;
	/** Line → score. Bash output repeats heavily; insertion order doubles as FIFO eviction order. */
	#scores = new Map<string, number>();

	/** Empty disables the classifier. */
	setServerUrl(url: string | undefined): void {
		const next = url?.trim().replace(/\/+$/, "") ?? "";
		if (next === this.#serverUrl) return;
		this.#serverUrl = next;
		this.#serverDownUntil = 0;
		this.#scores.clear();
	}

	get enabled(): boolean {
		return this.#serverUrl.length > 0 && Date.now() >= this.#serverDownUntil;
	}

	/** Secret probability per line, or undefined when the server is disabled, down, or failed. */
	async classify(lines: string[], signal?: AbortSignal): Promise<number[] | undefined> {
		if (!this.enabled) return undefined;
		const pending = [...new Set(lines.filter(line => !this.#scores.has(line)))];
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		try {
			for (let offset = 0; offset < pending.length; offset += MAX_LINES_PER_REQUEST) {
				const batch = pending.slice(offset, offset + MAX_LINES_PER_REQUEST);
				const scores = await this.#request(batch, requestSignal);
				for (let index = 0; index < batch.length; index++) this.#remember(batch[index], scores[index]);
			}
		} catch (error) {
			if (signal?.aborted) return undefined;
			logger.warn("secrets-sentinel: classifier unavailable; using regex detection only", {
				server: this.#serverUrl,
				error: error instanceof Error ? error.message : String(error),
			});
			this.#serverDownUntil = Date.now() + SERVER_DOWN_TTL_MS;
			return undefined;
		}
		return lines.map(line => this.#scores.get(line) ?? 0);
	}

	async #request(lines: string[], signal: AbortSignal): Promise<number[]> {
		const response = await fetch(`${this.#serverUrl}/v1/classify`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lines }),
			signal,
		});
		if (!response.ok) throw new Error(`server answered ${response.status}: ${await response.text()}`);
		const { scores } = (await response.json()) as { scores?: unknown };
		if (
			!Array.isArray(scores) ||
			scores.length !== lines.length ||
			!scores.every(score => typeof score === "number")
		) {
			throw new Error("server returned a malformed classify response");
		}
		return scores as number[];
	}

	#remember(line: string, score: number): void {
		if (this.#scores.size >= SCORE_CACHE_LIMIT) {
			const oldest = this.#scores.keys().next().value;
			if (oldest !== undefined) this.#scores.delete(oldest);
		}
		this.#scores.set(line, score);
	}
}

/** Process-wide client: every session in this process shares one score cache and down-state. */
export const sentinelClient = new SentinelClient();

/**
 * Regex detections plus classifier-flagged secrets, sorted by position and
 * non-overlapping. Degrades to {@link detectSecretsInText} when the client is
 * disabled or the server fails.
 */
export async function detectSecrets(
	text: string,
	client: SentinelClient = sentinelClient,
	signal?: AbortSignal,
): Promise<DetectedSecret[]> {
	const detected = detectSecretsInText(text);
	if (!client.enabled) return detected;

	const candidates: DetectedSecret[] = [];
	const lines: string[] = [];
	let lineStart = 0;
	while (candidates.length < MAX_LINES_PER_TEXT) {
		const newline = text.indexOf("\n", lineStart);
		const line = text.slice(lineStart, newline === -1 ? text.length : newline);
		const candidate =
			line.length >= MIN_LINE_LENGTH && line.length <= MAX_LINE_LENGTH
				? extractLineSecretCandidate(line)
				: undefined;
		if (candidate) {
			const start = lineStart + candidate.start;
			const end = lineStart + candidate.end;
			if (!detected.some(span => start < span.end && span.start < end)) {
				candidates.push({ ...candidate, start, end, kind: "sentinel" });
				lines.push(line);
			}
		}
		if (newline === -1) break;
		lineStart = newline + 1;
	}
	if (candidates.length === 0) return detected;
	const scores = await client.classify(lines, signal);
	if (!scores) return detected;
	const flagged = candidates.filter((_, index) => scores[index] >= SENTINEL_THRESHOLD);
	if (flagged.length === 0) return detected;
	return [...detected, ...flagged].sort((left, right) => left.start - right.start);
}
