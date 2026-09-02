import type { LoopSnapshot } from "../session/loop-manager";
import { previewLine, TRUNCATE_LENGTHS } from "../tools/render-utils";
import { sanitizeStatusText } from "./shared";

/** What happens to the session context before each repeated loop turn. */
export type LoopContextMode = "prompt" | "compact" | "reset";

export type LoopConfig = {
	intervalMs: number;
	iterations?: number;
	/** Per-loop override of the `loop.mode` setting; undefined defers to the setting. */
	context?: LoopContextMode;
};

export type LoopRuntime = {
	intervalMs: number;
	initialIterations?: number;
	remainingIterations?: number;
	context?: LoopContextMode;
};

export const DEFAULT_LOOP_INTERVAL_MS = 800;
export const MAX_LOOP_INTERVAL_MS = 2_147_483_647;

const LOOP_USAGE =
	"Usage: /loop [count] [interval] [clean|compact|--keep] [prompt]. A bare number is the iteration count; add a unit (10s, 2m, 1h30m) for the sleep interval. Examples: /loop 10, /loop 10s 5, /loop clean 10 fix the tests, /loop 2m keep going.";

/**
 * Context option tokens. Bare `clean` / `compact` are accepted for convenience;
 * bare `keep` is not, so a prose prompt like "keep going" stays a prompt.
 */
const LOOP_CONTEXT_TOKENS: Record<string, LoopContextMode> = {
	"--keep": "prompt",
	"--prompt": "prompt",
	"--compact": "compact",
	compact: "compact",
	"--clean": "reset",
	"--clear": "reset",
	"--reset": "reset",
	clean: "reset",
};

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
	/** Repeat cadence / iteration budget / context option, when the user supplied any leading option token. */
	limit?: LoopConfig;
	/** Inline loop prompt: text after the parsed options, or the whole argument when no option was supplied. */
	prompt?: string;
}

export type ParsedLoopManagementArgs =
	| { kind: "non-management" }
	| { kind: "management"; action: "list" }
	| { kind: "management"; action: "stop" | "cancel"; target: string }
	| { kind: "error"; message: string };

/**
 * Parse management forms reserved from inline loop prompts. Other arguments
 * intentionally remain available to the existing loop-limit parser.
 */
export function parseLoopManagementArgs(args: string): ParsedLoopManagementArgs {
	const parts = args.trim().split(/\s+/);
	if (!args.trim()) return { kind: "non-management" };

	const action = parts[0].toLowerCase();
	switch (action) {
		case "list":
			return parts.length === 1 ? { kind: "management", action } : { kind: "error", message: "Usage: /loop list" };
		case "stop":
		case "cancel":
			return parts.length === 2
				? { kind: "management", action, target: parts[1] }
				: { kind: "error", message: `Usage: /loop ${action} <id|all>` };
		default:
			return { kind: "non-management" };
	}
}

export function formatAgentLoopList(loops: readonly LoopSnapshot[]): string {
	if (loops.length === 0) return "No agent loops are active.";
	return loops
		.map(
			loop =>
				`${loop.id} ${loop.state} ${loop.iteration}/${loop.count} every ${formatDuration(loop.intervalMs)} ${previewLine(sanitizeStatusText(loop.prompt), TRUNCATE_LENGTHS.CONTENT)}`,
		)
		.join("\n");
}

export function parseLoopArgs(args: string): LoopConfig | string {
	const parsed = parseLoopLimitArgs(args);
	if (typeof parsed === "string") return parsed;
	if (parsed.prompt) return LOOP_USAGE;
	return parsed.limit ?? { intervalMs: DEFAULT_LOOP_INTERVAL_MS };
}

/**
 * Parse `/loop` arguments into OMPx's repeat config plus upstream's optional
 * inline prompt. Leading tokens are consumed in any order: a bare integer is
 * the iteration count, a token with a time unit (or `N <unit>`) is the sleep
 * interval, and `clean` / `compact` / `--keep` pick the context mode. Tokens
 * that look numeric but fail interval parsing are hard errors; the first
 * token that is none of the above starts the prompt.
 */
export function parseLoopLimitArgs(args: string): ParsedLoopArgs | string {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const parts = trimmed.split(/\s+/);
	let index = 0;
	let intervalMs: number | undefined;
	let iterations: number | undefined;
	let context: LoopContextMode | undefined;

	while (index < parts.length) {
		const token = parts[index].toLowerCase();
		const contextMode = Object.hasOwn(LOOP_CONTEXT_TOKENS, token) ? LOOP_CONTEXT_TOKENS[token] : undefined;
		if (contextMode !== undefined) {
			if (context !== undefined) return "Loop context option may only be given once.";
			context = contextMode;
			index += 1;
			continue;
		}
		if (!/^[+-]?\d/.test(token)) break;

		const unitFollows = index + 1 < parts.length && TIME_UNITS_MS.has(parts[index + 1].toLowerCase());
		if (/^\d+$/.test(token) && !unitFollows) {
			if (iterations !== undefined) break;
			const parsedIterations = parseIterationCount(token);
			if (typeof parsedIterations === "string") return parsedIterations;
			iterations = parsedIterations;
			index += 1;
			continue;
		}

		if (intervalMs !== undefined) break;
		const parsedInterval = parseInterval(parts, index);
		if (typeof parsedInterval === "string") return parsedInterval;
		intervalMs = parsedInterval.intervalMs;
		index = parsedInterval.nextIndex;
	}

	const prompt = parts.slice(index).join(" ").trim() || undefined;
	if (intervalMs === undefined && iterations === undefined && context === undefined) {
		return { prompt };
	}
	const limit: LoopConfig = { intervalMs: intervalMs ?? DEFAULT_LOOP_INTERVAL_MS };
	if (iterations !== undefined) limit.iterations = iterations;
	if (context !== undefined) limit.context = context;
	return { limit, prompt };
}

function parseInterval(parts: string[], start: number): ParsedInterval | string {
	const first = parts[start].toLowerCase();
	if (start + 1 < parts.length && /^\d+$/.test(first) && TIME_UNITS_MS.has(parts[start + 1].toLowerCase())) {
		const amount = parsePositiveInteger(
			first,
			"Loop sleep time must use a positive integer amount.",
			"Loop sleep time must be positive.",
		);
		if (typeof amount === "string") return amount;
		return parseIntervalAmount(amount, parts[start + 1].toLowerCase(), start + 2);
	}

	const compoundInterval = parseCompoundInterval(first, start + 1);
	if (compoundInterval !== undefined) return compoundInterval;

	const compactMatch = /^(\d+)([a-z]+)?$/.exec(first);
	if (compactMatch) {
		const amount = parsePositiveInteger(
			compactMatch[1],
			"Loop sleep time must use a positive integer amount.",
			"Loop sleep time must be positive.",
		);
		if (typeof amount === "string") return amount;
		return parseIntervalAmount(amount, compactMatch[2] ?? "s", start + 1);
	}

	return LOOP_USAGE;
}

function parseCompoundInterval(token: string, nextIndex: number): ParsedInterval | string | undefined {
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
	return { intervalMs, nextIndex };
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
	if (config.context !== undefined) runtime.context = config.context;
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

export function describeLoopContext(context: LoopContextMode): string {
	switch (context) {
		case "prompt":
			return "keeping context";
		case "compact":
			return "compacting context before each run";
		case "reset":
			return "starting a clean session before each run";
	}
}

export function describeLoopConfig(config: LoopConfig): string {
	const interval = formatDuration(config.intervalMs);
	const cadence =
		config.iterations === undefined
			? `every ${interval}`
			: `every ${interval} for ${config.iterations} ${config.iterations === 1 ? "iteration" : "iterations"}`;
	return config.context === undefined ? cadence : `${cadence}, ${describeLoopContext(config.context)}`;
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

export function formatDuration(durationMs: number): string {
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
