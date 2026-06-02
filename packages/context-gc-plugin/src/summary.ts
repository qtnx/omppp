const DEFAULT_LIMIT_BYTES = 4_096;
const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_MATCHES = 8;

export type PayloadSelector =
	| "summary"
	| "raw"
	| `${number}`
	| `${number}-${number}`
	| SummaryPayloadSelector
	| RangePayloadSelector
	| SearchPayloadSelector
	| RawPayloadSelector;

export interface SummaryPayloadSelector {
	readonly type: "summary";
	readonly summary: string;
	readonly maxBytes?: number;
}
export interface RawPayloadSelector {
	readonly type: "raw";
	readonly maxBytes?: number;
}

export interface RangePayloadSelector {
	readonly type: "range";
	readonly range: `${number}` | `${number}-${number}`;
	readonly maxBytes?: number;
}

export interface SearchPayloadSelector {
	readonly type: "search";
	readonly query: string;
	readonly before?: number;
	readonly after?: number;
	readonly maxMatches?: number;
	readonly maxBytes?: number;
	readonly caseSensitive?: boolean;
}

export interface SummaryOptions {
	readonly selector?: PayloadSelector;
	readonly maxBytes?: number;
}

export function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return Math.ceil(text.length / 4);
}

export function limitBytes(text: string, maxBytes = DEFAULT_LIMIT_BYTES): string {
	if (maxBytes <= 0) {
		return "";
	}
	const encoded = new TextEncoder().encode(text);
	if (encoded.byteLength <= maxBytes) {
		return text;
	}
	const suffix = "…";
	const suffixBytes = new TextEncoder().encode(suffix).byteLength;
	if (maxBytes < suffixBytes) {
		return "";
	}
	const targetBytes = maxBytes - suffixBytes;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (new TextEncoder().encode(text.slice(0, mid)).byteLength <= targetBytes) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return `${text.slice(0, low)}${suffix}`;
}

export function buildFallbackSummary(payload: string, options: SummaryOptions = {}): string {
	const selected = selectPayload(payload, options.selector ?? { type: "raw", maxBytes: options.maxBytes });
	const normalized = normalizeWhitespace(selected);
	const prefix = `${estimateTokens(payload)} tokens estimated`;
	if (normalized.length === 0) {
		return prefix;
	}
	return `${prefix}; preview: ${limitBytes(normalized, options.maxBytes ?? DEFAULT_LIMIT_BYTES)}`;
}

export function normalizeAgentSummary(
	summary: string | undefined,
	fallback: string,
	maxBytes = DEFAULT_LIMIT_BYTES,
): string {
	const normalized = normalizeWhitespace(summary ?? "");
	if (normalized.length > 0) {
		return limitBytes(normalized, maxBytes);
	}
	return limitBytes(normalizeWhitespace(fallback), maxBytes);
}

export function selectPayload(payload: string, selector: PayloadSelector = "raw"): string {
	if (typeof selector === "string") {
		if (selector === "summary") {
			return buildFallbackSummary(payload);
		}
		if (selector === "raw") {
			return limitBytes(payload);
		}
		return selectRange(payload, selector, DEFAULT_LIMIT_BYTES);
	}
	if (selector.type === "summary") {
		return limitBytes(normalizeWhitespace(selector.summary), selector.maxBytes ?? DEFAULT_LIMIT_BYTES);
	}
	if (selector.type === "raw") {
		return limitBytes(payload, selector.maxBytes ?? DEFAULT_LIMIT_BYTES);
	}
	if (selector.type === "range") {
		return selectRange(payload, selector.range, selector.maxBytes ?? DEFAULT_LIMIT_BYTES);
	}
	return selectSearch(payload, selector);
}

function selectRange(payload: string, range: `${number}` | `${number}-${number}`, maxBytes: number): string {
	const match = /^(\d+)(?:-(\d+))?$/.exec(range);
	if (!match) {
		throw new Error(`Invalid range selector: ${range}`);
	}
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : start;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
		throw new Error(`Invalid range selector: ${range}`);
	}
	const lines = payload.split("\n");
	return limitBytes(lines.slice(start - 1, end).join("\n"), maxBytes);
}

function selectSearch(payload: string, selector: SearchPayloadSelector): string {
	if (selector.query.length === 0) {
		return "";
	}
	const before = selector.before ?? DEFAULT_CONTEXT_LINES;
	const after = selector.after ?? DEFAULT_CONTEXT_LINES;
	const maxMatches = selector.maxMatches ?? DEFAULT_MAX_MATCHES;
	const maxBytes = selector.maxBytes ?? DEFAULT_LIMIT_BYTES;
	const query = selector.caseSensitive ? selector.query : selector.query.toLocaleLowerCase();
	const lines = payload.split("\n");
	const slices: string[] = [];
	let matches = 0;
	for (let index = 0; index < lines.length && matches < maxMatches; index += 1) {
		const haystack = selector.caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
		if (!haystack.includes(query)) {
			continue;
		}
		const start = Math.max(0, index - before);
		const end = Math.min(lines.length - 1, index + after);
		for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
			slices.push(`${lineIndex + 1}:${lines[lineIndex]}`);
		}
		matches += 1;
	}
	return limitBytes(slices.join("\n"), maxBytes);
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
