import type { MessageCreateParamsStreaming } from "./anthropic-wire";

export const ANTHROPIC_PREFIX_WARMUP_FOLLOWER_TIMEOUT_MS = 5_000;
export const ANTHROPIC_PREFIX_WARMUP_LIFETIME_MS = 270_000;

type TimerHandle = unknown;
type WarmupClock = {
	now?: () => number;
	setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimeout?: (handle: TimerHandle) => void;
};

type PrefixWarmupLease = {
	markReady(): void;
	release(): void;
};

type WarmEntry = {
	readyUntil: number | undefined;
	readyPromise: Promise<void>;
	resolveReady: () => void;
};

const noopLease: PrefixWarmupLease = {
	markReady() {},
	release() {},
};

function abortError(): Error {
	return new DOMException("The operation was aborted.", "AbortError");
}

function isGlobalCacheMarker(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const marker = value as { scope?: unknown };
	return marker.scope === "global";
}

function accountIdentityFromUserId(userId: string): string {
	if (userId.startsWith("user_") && userId.includes("_account_")) {
		const accountStart = userId.indexOf("_account_") + "_account_".length;
		const sessionStart = userId.indexOf("_session_", accountStart);
		if (sessionStart > accountStart) return userId.slice(accountStart, sessionStart);
	}
	if (userId.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(userId);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const accountId = (parsed as Record<string, unknown>).account_uuid;
				if (typeof accountId === "string" && accountId.length > 0) return accountId;
			}
		} catch {
			// Use the opaque attribution string below when it is not valid JSON.
		}
	}
	return userId;
}

/** Resolve a non-secret account/attribution identity from final request metadata. */
export function getAnthropicPrefixWarmupAccountIdentity(params: MessageCreateParamsStreaming): string | undefined {
	const userId = params.metadata?.user_id;
	return typeof userId === "string" && userId.length > 0 ? accountIdentityFromUserId(userId) : undefined;
}

/**
 * Build a fixed-size, non-reversible identity for the stable prefix ending at a
 * global cache breakpoint. The source objects are only serialized while hashing
 * and are never retained by the coordinator.
 */
export function getAnthropicPrefixWarmupKey(
	params: MessageCreateParamsStreaming,
	endpoint: string,
	accountIdentity: string | undefined,
	featureNames: readonly string[] = [],
): string | undefined {
	if (!accountIdentity) return undefined;
	const tools = params.tools ?? [];
	const system = Array.isArray(params.system) ? params.system : [];
	const toolMarkerIndex = tools.findIndex(tool => isGlobalCacheMarker(tool.cache_control));
	const systemMarkerIndex = system.findIndex(block => isGlobalCacheMarker(block.cache_control));
	if (toolMarkerIndex < 0 && systemMarkerIndex < 0) return undefined;
	const prefix = {
		endpoint,
		model: params.model,
		account: accountIdentity,
		tools: toolMarkerIndex >= 0 ? tools.slice(0, toolMarkerIndex + 1) : tools,
		system: systemMarkerIndex >= 0 ? system.slice(0, systemMarkerIndex + 1) : [],
		marker:
			toolMarkerIndex >= 0 ? { kind: "tool", index: toolMarkerIndex } : { kind: "system", index: systemMarkerIndex },
		features: [...featureNames].sort(),
		requestMode: {
			thinking: params.thinking,
			contextManagement: params.context_management,
			outputConfig: params.output_config,
			speed: params.speed,
			toolChoice: params.tool_choice,
		},
	};
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(prefix)).digest("hex");
}

export class AnthropicPrefixWarmupCoordinator {
	readonly #now: () => number;
	readonly #setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
	readonly #clearTimeout: (handle: TimerHandle) => void;
	readonly #entries = new Map<string, WarmEntry>();

	constructor(clock: WarmupClock = {}) {
		this.#now = clock.now ?? Date.now;
		this.#setTimeout = clock.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
		this.#clearTimeout = clock.clearTimeout ?? (handle => globalThis.clearTimeout(handle as NodeJS.Timeout));
	}

	async acquire(key: string, signal?: AbortSignal): Promise<PrefixWarmupLease> {
		if (signal?.aborted) throw abortError();
		const now = this.#now();
		for (const [entryKey, entry] of this.#entries) {
			if (entry.readyUntil !== undefined && entry.readyUntil <= now) this.#entries.delete(entryKey);
		}
		const existing = this.#entries.get(key);
		if (existing?.readyUntil !== undefined) {
			if (existing.readyUntil > now) return noopLease;
			this.#entries.delete(key);
		}
		if (!existing || existing.readyUntil !== undefined) {
			let resolveReady!: () => void;
			const readyPromise = new Promise<void>(resolve => (resolveReady = resolve));
			const entry: WarmEntry = { readyUntil: undefined, readyPromise, resolveReady };
			this.#entries.set(key, entry);
			let settled = false;
			const finishFailure = () => {
				if (settled) return;
				settled = true;
				if (this.#entries.get(key) === entry) this.#entries.delete(key);
				entry.resolveReady();
			};
			return {
				markReady: () => {
					if (settled) return;
					settled = true;
					entry.readyUntil = this.#now() + ANTHROPIC_PREFIX_WARMUP_LIFETIME_MS;
					entry.resolveReady();
				},
				release: finishFailure,
			};
		}

		await new Promise<void>((resolve, reject) => {
			let finished = false;
			const timeout = this.#setTimeout(() => finish(resolve), ANTHROPIC_PREFIX_WARMUP_FOLLOWER_TIMEOUT_MS);
			const onAbort = () => finish(reject, abortError());
			const finish = (done: (value?: void | PromiseLike<void>) => void, error?: Error) => {
				if (finished) return;
				finished = true;
				this.#clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else done();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			existing.readyPromise.then(
				() => finish(resolve),
				() => finish(resolve),
			);
		});
		return noopLease;
	}
}

export function createAnthropicPrefixWarmupCoordinator(clock: WarmupClock = {}): AnthropicPrefixWarmupCoordinator {
	return new AnthropicPrefixWarmupCoordinator(clock);
}

export const anthropicPrefixWarmupCoordinator = new AnthropicPrefixWarmupCoordinator();
