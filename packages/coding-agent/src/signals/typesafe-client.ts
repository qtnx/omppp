import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { redactMemorySecrets, redactNested } from "../memory-backend/redact";
import type { Question, SystemOneResponse } from "./types";

export const TYPESAFE_SYSTEMONE_URL = "http://codemc:8791/v1/systemone";

export interface TypeSafeClientOptions {
	/** Omitted when the endpoint authenticates upstream itself (the tailnet proxy). */
	apiKey?: string;
	model?: string;
	timeoutMs?: number;
	/** Test seam; defaults to the global fetch. */
	fetch?: typeof fetch;
	baseUrl?: string;
	/**
	 * Extra scrub applied to every string in the state before the credential
	 * pattern pass (the session's secret obfuscator, which knows the exact
	 * env/vault values). The pattern pass always runs.
	 */
	redact?: (text: string) => string;
}

/**
 * Minimal System One client. Every failure (network, non-2xx, malformed body,
 * timeout, abort) resolves `undefined` so callers fail open to their previous
 * behavior; the cause is logged at debug level only.
 */
export class TypeSafeClient {
	readonly model: string;
	readonly #apiKey: string | undefined;
	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;
	readonly #url: string;
	readonly #redact: ((text: string) => string) | undefined;

	constructor(options: TypeSafeClientOptions) {
		this.#apiKey = options.apiKey;
		this.model = options.model ?? "jev-latest";
		this.#timeoutMs = options.timeoutMs ?? 4000;
		this.#fetch = options.fetch ?? fetch;
		this.#url = options.baseUrl ?? TYPESAFE_SYSTEMONE_URL;
		this.#redact = options.redact;
	}

	async systemOne(
		state: string | object,
		questions: Record<string, Question>,
		signal?: AbortSignal,
	): Promise<SystemOneResponse | undefined> {
		// Transcript slices, plans, and prompts reach a third-party endpoint here;
		// nothing else on this path scrubs them, so every string leaf is redacted.
		const extra = this.#redact;
		const scrubbed = redactNested(state, extra ? text => redactMemorySecrets(extra(text)) : redactMemorySecrets);
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
		try {
			const response = await this.#fetch(this.#url, {
				method: "POST",
				headers,
				body: JSON.stringify({ state: scrubbed, model: this.model, questions }),
				signal: combined,
			});
			if (!response.ok) {
				logger.debug("typesafe systemone rejected", { status: response.status });
				return undefined;
			}
			const body = (await response.json()) as Partial<SystemOneResponse>;
			if (typeof body.model !== "string" || !isRecord(body.answers)) {
				logger.debug("typesafe systemone malformed body");
				return undefined;
			}
			return {
				model: body.model,
				answers: body.answers,
				usage: body.usage ?? { input_tokens: 0, output_tokens: 0 },
			};
		} catch (err) {
			logger.debug("typesafe systemone failed", { err: String(err) });
			return undefined;
		}
	}
}
