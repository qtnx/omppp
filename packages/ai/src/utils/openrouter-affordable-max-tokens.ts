/**
 * One-shot retry when OpenRouter 402s because the reserved output budget
 * exceeds remaining credit (`can only afford N`).
 *
 * Omitting `max_tokens` on OpenRouter is required so provider routing is not
 * filtered by a catalog cap. OpenRouter still *reserves* the advertised
 * upstream output ceiling (65536 for DeepSeek V4 Pro), so a low-credit
 * account 402s even though a smaller explicit cap would succeed. Retry the
 * same request once with `maxTokens = N` instead of failing the turn or
 * rotating credentials.
 */
import { parseOpenRouterAffordableMaxTokens } from "../error/rate-limit";
import type { AssistantMessageEvent, Context } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

export interface OpenRouterAffordableMaxTokensOptions {
	maxTokens?: number;
	maxTokensExplicit?: boolean;
	signal?: AbortSignal;
}

function currentRequestedMaxTokens(options: OpenRouterAffordableMaxTokensOptions | undefined): number | undefined {
	const requested = options?.maxTokens;
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return undefined;
	return requested;
}

function shouldRetryWithAffordableBudget(
	event: Extract<AssistantMessageEvent, { type: "error" }> | undefined,
	options: OpenRouterAffordableMaxTokensOptions | undefined,
): number | undefined {
	if (event?.reason !== "error") return undefined;
	const status = event.error.errorStatus;
	if (status !== undefined && status !== 402) return undefined;
	const affordable = parseOpenRouterAffordableMaxTokens(event.error.errorMessage);
	if (affordable === undefined) return undefined;
	const requested = currentRequestedMaxTokens(options);
	if (requested !== undefined && requested <= affordable) return undefined;
	return affordable;
}

/**
 * Wrap a single-attempt provider stream and re-issue it once when OpenRouter
 * reports that the reserved output budget exceeds remaining credit.
 * `attempt` MUST create a fresh request on each call.
 */
export function withOpenRouterAffordableMaxTokensRetry<M, O extends OpenRouterAffordableMaxTokensOptions>(
	model: M,
	context: Context,
	options: O | undefined,
	attempt: (model: M, context: Context, options?: O) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	void (async () => {
		let attemptOptions = options;
		for (let retry = 0; ; retry++) {
			const inner = attempt(model, context, attemptOptions);
			const buffered: AssistantMessageEvent[] = [];
			let terminal: AssistantMessageEvent | undefined;
			const flush = (): void => {
				for (const event of buffered) outer.push(event);
				buffered.length = 0;
			};
			try {
				for await (const event of inner) {
					if (event.type === "done" || event.type === "error") {
						terminal = event;
						break;
					}
					buffered.push(event);
				}
			} catch (error) {
				flush();
				outer.fail(error);
				return;
			}

			const affordable =
				retry === 0 && !options?.signal?.aborted && terminal?.type === "error"
					? shouldRetryWithAffordableBudget(terminal, attemptOptions)
					: undefined;
			if (affordable !== undefined) {
				attemptOptions = {
					...(attemptOptions ?? ({} as O)),
					maxTokens: affordable,
					maxTokensExplicit: true,
				};
				continue;
			}

			flush();
			if (terminal) {
				outer.push(terminal);
			} else if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (error) {
					outer.fail(error);
				}
			}
			return;
		}
	})();
	return outer;
}
