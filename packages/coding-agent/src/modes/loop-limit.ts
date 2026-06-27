export type LoopConfig = {
	intervalMs: number;
	iterations?: number;
};

export type LoopRuntime = {
	intervalMs: number;
	initialIterations?: number;
	remainingIterations?: number;
};

export const DEFAULT_LOOP_INTERVAL_MS = 800;
export const MAX_LOOP_INTERVAL_MS = 2_147_483_647;

const LOOP_USAGE =
	"Usage: /loop [time] [iteration] [prompt]. Omit iteration for unlimited repeats. Examples: /loop 10, /loop 10s 5, /loop 2m keep going.";

const TIME_UNITS_MS = new Map<string, number>([
	["ms", 1],
	["msec", 1],
	["msecs", 1],
	["millisecond", 1],
	["milliseconds", 1],
	["s", 1_000],
	["sec", 1_000],
	["secs", 1_000],
	["second", 1_000],
	["seconds", 1_000],
	["m", 60_000],
	["min", 60_000],
	["mins", 60_000],
	["minute", 60_000],
	["minutes", 60_000],
	["h", 3_600_000],
	["hr", 3_600_000],
	["hrs", 3_600_000],
	["hour", 3_600_000],
	["hours", 3_600_000],
]);

type ParsedInterval = {
	intervalMs: number;
	nextIndex: number;
};

export interface ParsedLoopArgs {
	/** Repeat cadence / iteration budget, when the user supplied a leading time token. */
	limit?: LoopConfig;
	/** Inline loop prompt: text after the parsed time / iteration, or the whole argument when no time was supplied. */
	prompt?: string;
}

export function parseLoopArgs(args: string): LoopConfig | string {
	const parsed = parseLoopLimitArgs(args);
	if (typeof parsed === "string") return parsed;
	if (parsed.prompt) return LOOP_USAGE;
	return parsed.limit ?? { intervalMs: DEFAULT_LOOP_INTERVAL_MS };
}

/**
 * Parse `/loop` arguments into OMPx's repeat interval / optional iteration
 * count plus upstream's optional inline prompt. Tokens that look numeric but
 * fail interval parsing are hard errors; plain prose is treated as an unbounded
 * default-interval loop prompt.
 */
export function parseLoopLimitArgs(args: string): ParsedLoopArgs | string {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const parts = trimmed.split(/\s+/);
	const firstToken = parts[0].toLowerCase();
	if (!/^[+-]?\d/.test(firstToken)) {
		return { prompt: trimmed };
	}

	const parsedInterval = parseInterval(parts);
	if (typeof parsedInterval === "string") return parsedInterval;

	let nextIndex = parsedInterval.nextIndex;
	let iterations: number | undefined;
	if (nextIndex < parts.length && /^\d+$/.test(parts[nextIndex])) {
		const parsedIterations = parseIterationCount(parts[nextIndex]);
		if (typeof parsedIterations === "string") return parsedIterations;
		iterations = parsedIterations;
		nextIndex += 1;
	}

	const prompt = parts.slice(nextIndex).join(" ").trim() || undefined;
	return { limit: { intervalMs: parsedInterval.intervalMs, iterations }, prompt };
}

function parseInterval(parts: string[]): ParsedInterval | string {
	if (parts.length >= 2 && /^\d+$/.test(parts[0]) && TIME_UNITS_MS.has(parts[1].toLowerCase())) {
		const amount = parsePositiveInteger(
			parts[0],
			"Loop sleep time must use a positive integer amount.",
			"Loop sleep time must be positive.",
		);
		if (typeof amount === "string") return amount;
		return parseIntervalAmount(amount, parts[1].toLowerCase(), 2);
	}

	const compoundInterval = parseCompoundInterval(parts[0].toLowerCase());
	if (compoundInterval !== undefined) return compoundInterval;

	const compactMatch = /^(\d+)([a-z]+)?$/.exec(parts[0].toLowerCase());
	if (compactMatch) {
		const amount = parsePositiveInteger(
			compactMatch[1],
			"Loop sleep time must use a positive integer amount.",
			"Loop sleep time must be positive.",
		);
		if (typeof amount === "string") return amount;
		return parseIntervalAmount(amount, compactMatch[2] ?? "s", 1);
	}

	return LOOP_USAGE;
}

function parseCompoundInterval(token: string): ParsedInterval | string | undefined {
	const segmentPattern = /(\d+)([a-z]+)/g;
	let match = segmentPattern.exec(token);
	let nextOffset = 0;
	let segmentCount = 0;
	let intervalMs = 0;

	while (match !== null) {
		if (match.index !== nextOffset) return undefined;
		segmentCount += 1;

		const amount = parsePositiveInteger(
			match[1],
			"Loop sleep time must use a positive integer amount.",
			"Loop sleep time must be positive.",
		);
		if (typeof amount === "string") return amount;

		const unitMs = TIME_UNITS_MS.get(match[2]);
		if (unitMs === undefined) {
			return "Loop sleep time unit must be milliseconds, seconds, minutes, or hours.";
		}

		intervalMs += amount * unitMs;
		if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
			return "Loop sleep time must be positive.";
		}
		nextOffset = segmentPattern.lastIndex;
		match = segmentPattern.exec(token);
	}

	if (segmentCount < 2 || nextOffset !== token.length) return undefined;
	if (intervalMs > MAX_LOOP_INTERVAL_MS) {
		return `Loop sleep time must be at most ${MAX_LOOP_INTERVAL_MS} milliseconds.`;
	}
	return { intervalMs, nextIndex: 1 };
}

function parseIntervalAmount(amount: number, unitText: string, nextIndex: number): ParsedInterval | string {
	const unitMs = TIME_UNITS_MS.get(unitText);
	if (unitMs === undefined) {
		return "Loop sleep time unit must be milliseconds, seconds, minutes, or hours.";
	}

	const intervalMs = amount * unitMs;
	if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
		return "Loop sleep time must be positive.";
	}
	if (intervalMs > MAX_LOOP_INTERVAL_MS) {
		return `Loop sleep time must be at most ${MAX_LOOP_INTERVAL_MS} milliseconds.`;
	}
	return { intervalMs, nextIndex };
}

function parseIterationCount(token: string): number | string {
	const iterations = parsePositiveInteger(
		token,
		"Loop iteration count must be a positive integer.",
		"Loop iteration count must be a positive integer.",
	);
	return iterations;
}

function parsePositiveInteger(token: string, invalidMessage: string, nonPositiveMessage: string): number | string {
	if (!/^\d+$/.test(token)) return invalidMessage;
	const value = Number(token);
	if (!Number.isSafeInteger(value) || value <= 0) return nonPositiveMessage;
	return value;
}

export function createLoopRuntime(config: LoopConfig): LoopRuntime {
	const runtime: LoopRuntime = { intervalMs: config.intervalMs };
	if (config.iterations !== undefined) {
		runtime.initialIterations = config.iterations;
		runtime.remainingIterations = config.iterations;
	}
	return runtime;
}

export function hasLoopIterationRemaining(runtime: LoopRuntime | undefined): boolean {
	return runtime?.remainingIterations === undefined || runtime.remainingIterations > 0;
}

export function consumeLoopIteration(runtime: LoopRuntime | undefined): boolean {
	if (!hasLoopIterationRemaining(runtime)) return false;
	if (runtime?.remainingIterations === undefined) return true;
	runtime.remainingIterations -= 1;
	return true;
}

export function describeLoopConfig(config: LoopConfig): string {
	const interval = formatDuration(config.intervalMs);
	if (config.iterations === undefined) return `every ${interval}`;
	return `every ${interval} for ${config.iterations} ${config.iterations === 1 ? "iteration" : "iterations"}`;
}

export function describeLoopRuntime(runtime: LoopRuntime): string | undefined {
	if (runtime.remainingIterations === undefined || runtime.initialIterations === undefined) return undefined;
	return `${runtime.remainingIterations} of ${runtime.initialIterations} ${
		runtime.initialIterations === 1 ? "iteration" : "iterations"
	} remaining`;
}

export type LoopLimitConfig = LoopConfig;
export type LoopLimitRuntime = LoopRuntime;
export const createLoopLimitRuntime = createLoopRuntime;
export const consumeLoopLimitIteration = consumeLoopIteration;
export const describeLoopLimit = describeLoopConfig;
export const describeLoopLimitRuntime = describeLoopRuntime;

export function isLoopDurationExpired(): false {
	return false;
}

function formatDuration(durationMs: number): string {
	if (durationMs % 3_600_000 === 0) {
		const hours = durationMs / 3_600_000;
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	if (durationMs % 60_000 === 0) {
		const minutes = durationMs / 60_000;
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	if (durationMs % 1_000 === 0) {
		const seconds = durationMs / 1_000;
		return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
	}
	return `${durationMs} ${durationMs === 1 ? "millisecond" : "milliseconds"}`;
}
