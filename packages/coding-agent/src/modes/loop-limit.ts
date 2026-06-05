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
	"Usage: /loop [time] [iteration]. Omit iteration for unlimited repeats. Examples: /loop 10, /loop 10s 5, /loop 2m.";

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

export function parseLoopArgs(args: string): LoopConfig | string {
	const trimmed = args.trim().toLowerCase();
	if (!trimmed) return { intervalMs: DEFAULT_LOOP_INTERVAL_MS };

	const parts = trimmed.split(/\s+/);
	if (parts.length > 3) return LOOP_USAGE;

	const parsedInterval = parseInterval(parts);
	if (typeof parsedInterval === "string") return parsedInterval;
	if (parsedInterval.nextIndex === parts.length) return { intervalMs: parsedInterval.intervalMs };
	if (parsedInterval.nextIndex !== parts.length - 1) return LOOP_USAGE;

	const iterations = parseIterationCount(parts[parsedInterval.nextIndex]);
	if (typeof iterations === "string") return iterations;
	return { intervalMs: parsedInterval.intervalMs, iterations };
}

function parseInterval(parts: string[]): ParsedInterval | string {
	if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^[a-z]+$/.test(parts[1])) {
		const amount = parsePositiveInteger(
			parts[0],
			"Loop sleep time must use a positive integer amount.",
			"Loop sleep time must be positive.",
		);
		if (typeof amount === "string") return amount;
		return parseIntervalAmount(amount, parts[1], 2);
	}

	const compactMatch = /^(\d+)([a-z]+)?$/.exec(parts[0]);
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
export const parseLoopLimitArgs = parseLoopArgs;
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
