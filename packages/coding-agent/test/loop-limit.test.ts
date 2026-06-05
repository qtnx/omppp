import { describe, expect, test, vi } from "bun:test";
import {
	consumeLoopIteration,
	createLoopRuntime,
	MAX_LOOP_INTERVAL_MS,
	parseLoopArgs,
} from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import type { BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/loop slash command", () => {
	test("accepts a sleep interval and optional iteration limit", async () => {
		const handleLoopCommand = vi.fn(async (_args?: string) => {});
		const runtime = {
			ctx: {
				handleLoopCommand,
				editor: { setText: vi.fn() },
			},
			handleBackgroundCommand: vi.fn(),
		} as unknown as BuiltinSlashCommandRuntime;
		const result = await executeBuiltinSlashCommand("/loop 10s 3", runtime);

		expect(result).toBe(true);
		expect(handleLoopCommand).toHaveBeenCalledWith("10s 3");
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
