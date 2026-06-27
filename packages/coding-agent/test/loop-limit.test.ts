import { describe, expect, test, vi } from "bun:test";
import {
	consumeLoopIteration,
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	createLoopRuntime,
	MAX_LOOP_INTERVAL_MS,
	parseLoopArgs,
	parseLoopLimitArgs,
} from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import type { BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/loop slash command", () => {
	test("accepts a sleep interval and optional iteration limit", async () => {
		const handleLoopCommand = vi.fn(async (_args?: string) => undefined);
		const runtime = {
			ctx: { handleLoopCommand, editor: { setText: vi.fn() } },
		} as unknown as BuiltinSlashCommandRuntime;
		const result = await executeBuiltinSlashCommand("/loop 10s 3", runtime);

		expect(result).toBe(true);
		expect(handleLoopCommand).toHaveBeenCalledWith("10s 3");
	});

	test("forwards a bare limit argument verbatim", async () => {
		const handleLoopCommand = vi.fn(async (_args?: string) => undefined);
		const runtime = {
			ctx: { handleLoopCommand, editor: { setText: vi.fn() } },
		} as unknown as BuiltinSlashCommandRuntime;
		const result = await executeBuiltinSlashCommand("/loop 10min", runtime);

		expect(result).toBe(true);
		expect(handleLoopCommand).toHaveBeenCalledWith("10min");
	});

	test("forwards the full residual and propagates the inline prompt for submission", async () => {
		// The dispatcher must hand the entire `<limit> <prompt>` string to
		// handleLoopCommand (the parser, not the dispatcher, splits limit vs prompt)
		// and surface the returned inline prompt so input-controller submits it.
		const handleLoopCommand = vi.fn(async (_args?: string) => "fix the failing tests");
		const setText = vi.fn();
		const runtime = {
			ctx: { handleLoopCommand, editor: { setText } },
		} as unknown as BuiltinSlashCommandRuntime;
		const result = await executeBuiltinSlashCommand("/loop 10m fix the failing tests", runtime);

		expect(handleLoopCommand).toHaveBeenCalledWith("10m fix the failing tests");
		expect(result).toBe("fix the failing tests");
		expect(setText).toHaveBeenCalledWith("");
	});
});

describe("loop argument parsing", () => {
	test("defaults to the existing 800ms interval with unlimited iterations", () => {
		expect(parseLoopArgs("")).toEqual({ intervalMs: 800 });
	});

	test("parses a bare positive integer as seconds between loop turns", () => {
		expect(parseLoopArgs("10")).toEqual({ intervalMs: 10_000 });
	});

	test("parses interval aliases with an optional iteration limit", () => {
		expect(parseLoopArgs("500ms")).toEqual({ intervalMs: 500 });
		expect(parseLoopArgs("10s 3")).toEqual({ intervalMs: 10_000, iterations: 3 });
		expect(parseLoopArgs("2 minutes 5")).toEqual({ intervalMs: 120_000, iterations: 5 });
	});

	test("rejects invalid intervals and iteration counts", () => {
		expect(parseLoopArgs("0")).toBe("Loop sleep time must be positive.");
		expect(parseLoopArgs("-1")).toContain("Usage: /loop");
		expect(parseLoopArgs("10fortnights")).toBe(
			"Loop sleep time unit must be milliseconds, seconds, minutes, or hours.",
		);
		expect(parseLoopArgs("10s 0")).toBe("Loop iteration count must be a positive integer.");
		expect(parseLoopArgs(`${MAX_LOOP_INTERVAL_MS + 1}ms`)).toBe(
			`Loop sleep time must be at most ${MAX_LOOP_INTERVAL_MS} milliseconds.`,
		);
		expect(parseLoopArgs("2147484 s")).toBe(`Loop sleep time must be at most ${MAX_LOOP_INTERVAL_MS} milliseconds.`);
	});
});

describe("loop limit parsing", () => {
	test("empty args produce neither a limit nor a prompt", () => {
		expect(parseLoopLimitArgs("")).toEqual({});
		expect(parseLoopLimitArgs("   ")).toEqual({});
	});

	test("parses a bare positive integer as a seconds interval", () => {
		expect(parseLoopLimitArgs("10")).toEqual({ limit: { intervalMs: 10_000 } });
	});

	test("parses minute duration aliases as loop intervals", () => {
		expect(parseLoopLimitArgs("10m")).toEqual({ limit: { intervalMs: 600_000 } });
		expect(parseLoopLimitArgs("10min")).toEqual({ limit: { intervalMs: 600_000 } });
		expect(parseLoopLimitArgs("10 minutes")).toEqual({ limit: { intervalMs: 600_000 } });
	});

	test("parses compound durations like 1h30m as loop intervals", () => {
		expect(parseLoopLimitArgs("1h30m")).toEqual({ limit: { intervalMs: 5_400_000 } });
		expect(parseLoopLimitArgs("2h30min")).toEqual({ limit: { intervalMs: 9_000_000 } });
	});

	test("treats trailing text after a valid interval as an inline prompt", () => {
		expect(parseLoopLimitArgs("10m keep refactoring")).toEqual({
			limit: { intervalMs: 600_000 },
			prompt: "keep refactoring",
		});
		expect(parseLoopLimitArgs("5 fix the bug")).toEqual({
			limit: { intervalMs: 5_000 },
			prompt: "fix the bug",
		});
		// Space-separated unit must win over treating the count as a default-seconds interval.
		expect(parseLoopLimitArgs("10 minutes keep going")).toEqual({
			limit: { intervalMs: 600_000 },
			prompt: "keep going",
		});
	});

	test("treats non-limit prose as an unbounded loop with an inline prompt", () => {
		expect(parseLoopLimitArgs("keep going")).toEqual({ prompt: "keep going" });
		expect(parseLoopLimitArgs("fix the failing tests")).toEqual({ prompt: "fix the failing tests" });
	});

	test("rejects zero, negative, and unknown interval-shaped tokens", () => {
		expect(parseLoopLimitArgs("0")).toBe("Loop sleep time must be positive.");
		expect(parseLoopLimitArgs("-1")).toContain("Usage: /loop");
		expect(parseLoopLimitArgs("10fortnights")).toBe(
			"Loop sleep time unit must be milliseconds, seconds, minutes, or hours.",
		);
	});
});

describe("loop runtime", () => {
	test("allows exactly the configured number of auto-submitted iterations", () => {
		const config = parseLoopArgs("1s 3");
		expect(config).toEqual({ intervalMs: 1_000, iterations: 3 });
		if (typeof config === "string") throw new Error("expected parsed config");

		const runtime = createLoopRuntime(config);
		expect(consumeLoopIteration(runtime)).toBe(true);
		expect(consumeLoopIteration(runtime)).toBe(true);
		expect(consumeLoopIteration(runtime)).toBe(true);
		expect(consumeLoopIteration(runtime)).toBe(false);
		expect(consumeLoopIteration(runtime)).toBe(false);
	});

	test("leaves loops unlimited when no iteration count is configured", () => {
		const config = parseLoopArgs("250ms");
		expect(config).toEqual({ intervalMs: 250 });
		if (typeof config === "string") throw new Error("expected parsed config");

		const runtime = createLoopRuntime(config);
		expect(consumeLoopIteration(runtime)).toBe(true);
		expect(consumeLoopIteration(runtime)).toBe(true);
		expect(consumeLoopIteration(runtime)).toBe(true);
	});
});

describe("loop limit runtime", () => {
	test("allows exactly the configured number of auto-submitted iterations", () => {
		const parsed = parseLoopLimitArgs("1s 3");
		if (typeof parsed === "string" || !parsed.limit) throw new Error("expected parsed limit");
		expect(parsed.limit).toEqual({ intervalMs: 1_000, iterations: 3 });

		const limit = createLoopLimitRuntime(parsed.limit);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(false);
		expect(limit).toEqual({ intervalMs: 1_000, initialIterations: 3, remainingIterations: 0 });
	});

	test("leaves duration-style interval aliases unlimited without an iteration count", () => {
		const parsed = parseLoopLimitArgs("10m");
		if (typeof parsed === "string" || !parsed.limit) throw new Error("expected parsed limit");
		expect(parsed.limit).toEqual({ intervalMs: 600_000 });

		const limit = createLoopLimitRuntime(parsed.limit);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(limit).toEqual({ intervalMs: 600_000 });
	});
});
