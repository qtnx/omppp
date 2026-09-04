/** Final wire-shape inputs used to explain a prompt-cache invalidation. */
export interface AnthropicDiagnosticRequest {
	model: string;
	messages: readonly unknown[];
	system?: unknown;
	tools?: unknown;
	thinking?: unknown;
	contextManagement?: unknown;
	outputConfig?: unknown;
	cacheControls?: unknown;
	cacheControl?: unknown;
	featureNames?: readonly string[];
}

export interface AnthropicDiagnosticUsage {
	cacheRead: number;
	cacheWrite: number;
	input: number;
}

export type AnthropicCacheDiagnosticReason =
	| "model_changed"
	| "system_changed"
	| "tools_changed"
	| "thinking_or_effort_changed"
	| "cache_controls_changed"
	| "message_history_changed"
	| "beta_features_changed"
	| "ttl_or_provider_eviction";

export interface AnthropicDiagnosticFingerprint {
	modelHash: string;
	systemHash: string;
	/** Per-block digests of `system` (one entry for a string system prompt). */
	systemBlockHashes: readonly string[];
	toolsHash: string;
	/** Per-tool digests in wire order. */
	toolHashes: readonly string[];
	thinkingOrEffortHash: string;
	cacheControlsHash: string;
	messageHashes: readonly string[];
	featureNames: readonly string[];
	featureHash: string;
}

export interface AnthropicCacheDiagnosticState {
	fingerprint: AnthropicDiagnosticFingerprint;
	usage: AnthropicDiagnosticUsage;
}

/**
 * `cold`: a warm prefix read nothing back. `partial`: the request read less
 * than the previous request's whole prompt (`previousCacheRead +
 * previousCacheWrite`) even though that prompt should have been an append-only
 * prefix of this one — the conversation tail was rewritten.
 */
export type AnthropicCacheDiagnosticKind = "cold" | "partial";

export interface AnthropicCacheDiagnosticTransition {
	kind: AnthropicCacheDiagnosticKind;
	reasonCodes: readonly AnthropicCacheDiagnosticReason[];
	/** First previously-sent message whose bytes changed; absent for pure appends. */
	firstChangedMessageIndex?: number;
	/** First `system` block whose bytes changed. */
	firstChangedSystemBlockIndex?: number;
	/** First tool definition whose bytes changed. */
	firstChangedToolIndex?: number;
	previousCacheRead: number;
	/** Tokens the previous request proved cacheable: its read plus its write. */
	expectedCacheRead: number;
	currentCacheRead: number;
	currentCacheWrite: number;
	currentInput: number;
	/** Cached tokens the provider had to rewrite instead of read. */
	lostCacheTokens: number;
}

/**
 * Slack between the previous prompt size and the current read before a
 * shortfall counts as a partial miss. Successful append-only turns read the
 * previous prompt back exactly, so this only absorbs provider accounting jitter.
 */
const PARTIAL_MISS_TOLERANCE_TOKENS = 1024;

/** Beta/header feature names that are safe to retain in diagnostics. */
const ALLOWED_FEATURE_NAMES: Record<string, true> = {
	"advanced-tool-use-2025-11-20": true,
	"claude-code-20250219": true,
	"context-management-2025-06-27": true,
	"effort-2025-11-24": true,
	"extended-cache-ttl-2025-04-11": true,
	"fallback-credit-2026-06-01": true,
	"fast-mode-2026-02-01": true,
	"fine-grained-tool-streaming-2025-05-14": true,
	"interleaved-thinking-2025-05-14": true,
	"mid-conversation-system-2026-04-07": true,
	"prompt-caching-scope-2026-01-05": true,
	"redact-thinking-2026-02-12": true,
	"server-side-fallback-2026-06-01": true,
	"structured-outputs-2025-12-15": true,
	"task-budgets-2026-03-13": true,
	"thinking-token-count-2026-05-13": true,
};

/** Normalize an allowlisted beta/header identity without retaining arbitrary values. */
export function sanitizeAnthropicFeatureNames(features: readonly string[] | undefined): string[] {
	if (!features) return [];
	return [...new Set(features.flatMap(feature => feature.split(",").map(value => value.trim())))]
		.filter(feature => ALLOWED_FEATURE_NAMES[feature] === true)
		.sort();
}

function canonicalJson(value: unknown, stripCacheControls = false, seen = new Set<object>()): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "number":
			return Number.isFinite(value) ? String(value) : "null";
		case "boolean":
			return value ? "true" : "false";
		case "bigint":
			return `bigint:${value.toString()}`;
		case "undefined":
			return "undefined";
		case "function":
		case "symbol":
			return `[${typeof value}]`;
		case "object": {
			if (seen.has(value)) return "[cycle]";
			seen.add(value);
			const serialized = Array.isArray(value)
				? `[${value.map(item => canonicalJson(item, stripCacheControls, seen)).join(",")}]`
				: `{${Object.keys(value)
						.filter(key => !stripCacheControls || key !== "cache_control")
						.sort()
						.map(
							key =>
								`${JSON.stringify(key)}:${canonicalJson(
									(value as Record<string, unknown>)[key],
									stripCacheControls,
									seen,
								)}`,
						)
						.join(",")}}`;
			seen.delete(value);
			return serialized;
		}
	}
	return "[unknown]";
}

function digestSerialized(value: unknown, stripCacheControls = false): string {
	const serialized = canonicalJson(value, stripCacheControls);
	return new Bun.CryptoHasher("sha256").update(serialized).digest("hex");
}

function collectCacheControls(value: unknown, found: unknown[] = []): unknown[] {
	if (value === null || typeof value !== "object") return found;
	if (Array.isArray(value)) {
		for (const item of value) collectCacheControls(item, found);
		return found;
	}
	for (const [key, item] of Object.entries(value)) {
		if (key === "cache_control") found.push(item);
		else collectCacheControls(item, found);
	}
	return found;
}

function digestEach(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.map(item => digestSerialized(item, true));
	return [digestSerialized(value, true)];
}

export function fingerprintAnthropicRequest(input: AnthropicDiagnosticRequest): AnthropicDiagnosticFingerprint {
	const model = digestSerialized(input.model);
	const system = digestSerialized(input.system, true);
	const tools = digestSerialized(input.tools, true);
	const thinkingOrEffort = digestSerialized(
		{
			thinking: input.thinking,
			contextManagement: input.contextManagement,
			effort: input.outputConfig,
		},
		true,
	);
	const cacheControls =
		input.cacheControls === undefined
			? [input.cacheControl, ...collectCacheControls([input.messages, input.system, input.tools])]
			: input.cacheControls;
	const cacheControlsHash = digestSerialized(cacheControls);
	const messageHashes = input.messages.map(message => digestSerialized(message, true));
	const featureNames = sanitizeAnthropicFeatureNames(input.featureNames);
	const featureHash = digestSerialized(featureNames);
	return {
		modelHash: model,
		systemHash: system,
		systemBlockHashes: digestEach(input.system),
		toolsHash: tools,
		toolHashes: digestEach(input.tools),
		thinkingOrEffortHash: thinkingOrEffort,
		cacheControlsHash,
		messageHashes,
		featureNames,
		featureHash,
	};
}

/** First index where two digest lists differ, including a shorter/longer tail. */
function firstChangedIndex(previous: readonly string[], current: readonly string[]): number | undefined {
	const limit = Math.max(previous.length, current.length);
	for (let index = 0; index < limit; index++) {
		if (previous[index] !== current[index]) return index;
	}
	return undefined;
}

/**
 * First previously-sent message whose bytes changed. Messages appended after
 * the previous prompt extend the cached prefix and are never reported.
 */
function firstChangedMessageIndex(previous: readonly string[], current: readonly string[]): number | undefined {
	for (let index = 0; index < previous.length; index++) {
		if (previous[index] !== current[index]) return index;
	}
	return undefined;
}

/**
 * Diagnose a proven explicit-cache loss between two settled requests: a warm
 * prefix that read nothing back (`cold`), or a request that read less than the
 * whole previous prompt (`partial`).
 */
export function diagnoseAnthropicCacheTransition(
	previous: AnthropicCacheDiagnosticState | undefined,
	current: AnthropicCacheDiagnosticState,
): AnthropicCacheDiagnosticTransition | undefined {
	if (!previous || current.usage.cacheWrite <= 0) return undefined;
	const expectedCacheRead = previous.usage.cacheRead + previous.usage.cacheWrite;
	let kind: AnthropicCacheDiagnosticKind;
	if (current.usage.cacheRead <= 0) {
		if (previous.usage.cacheRead <= 0) return undefined;
		kind = "cold";
	} else if (current.usage.cacheRead + PARTIAL_MISS_TOLERANCE_TOKENS < expectedCacheRead) {
		kind = "partial";
	} else {
		return undefined;
	}
	const reasonCodes: AnthropicCacheDiagnosticReason[] = [];
	if (previous.fingerprint.modelHash !== current.fingerprint.modelHash) reasonCodes.push("model_changed");
	const changedSystemBlockIndex =
		previous.fingerprint.systemHash === current.fingerprint.systemHash
			? undefined
			: (firstChangedIndex(previous.fingerprint.systemBlockHashes, current.fingerprint.systemBlockHashes) ?? 0);
	if (changedSystemBlockIndex !== undefined) reasonCodes.push("system_changed");
	const changedToolIndex =
		previous.fingerprint.toolsHash === current.fingerprint.toolsHash
			? undefined
			: (firstChangedIndex(previous.fingerprint.toolHashes, current.fingerprint.toolHashes) ?? 0);
	if (changedToolIndex !== undefined) reasonCodes.push("tools_changed");
	if (previous.fingerprint.thinkingOrEffortHash !== current.fingerprint.thinkingOrEffortHash) {
		reasonCodes.push("thinking_or_effort_changed");
	}
	if (previous.fingerprint.cacheControlsHash !== current.fingerprint.cacheControlsHash) {
		reasonCodes.push("cache_controls_changed");
	}
	const changedMessageIndex = firstChangedMessageIndex(
		previous.fingerprint.messageHashes,
		current.fingerprint.messageHashes,
	);
	if (changedMessageIndex !== undefined) reasonCodes.push("message_history_changed");
	if (previous.fingerprint.featureHash !== current.fingerprint.featureHash) reasonCodes.push("beta_features_changed");
	if (reasonCodes.length === 0) reasonCodes.push("ttl_or_provider_eviction");
	return {
		kind,
		reasonCodes,
		...(changedMessageIndex === undefined ? {} : { firstChangedMessageIndex: changedMessageIndex }),
		...(changedSystemBlockIndex === undefined ? {} : { firstChangedSystemBlockIndex: changedSystemBlockIndex }),
		...(changedToolIndex === undefined ? {} : { firstChangedToolIndex: changedToolIndex }),
		previousCacheRead: previous.usage.cacheRead,
		expectedCacheRead,
		currentCacheRead: current.usage.cacheRead,
		currentCacheWrite: current.usage.cacheWrite,
		currentInput: current.usage.input,
		lostCacheTokens: Math.max(0, expectedCacheRead - current.usage.cacheRead),
	};
}

/** Record a settled successful usage, returning an event when invalidation is proven. */
export function recordAnthropicCacheDiagnostics(
	state: AnthropicCacheDiagnosticState | undefined,
	request: AnthropicDiagnosticRequest,
	usage: AnthropicDiagnosticUsage,
	successful: boolean,
): AnthropicCacheDiagnosticTransition | undefined {
	if (!state || !successful) return undefined;
	const current: AnthropicCacheDiagnosticState = { fingerprint: fingerprintAnthropicRequest(request), usage };
	const transition = diagnoseAnthropicCacheTransition(state, current);
	state.fingerprint = current.fingerprint;
	state.usage = current.usage;
	return transition;
}
