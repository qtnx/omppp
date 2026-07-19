import { afterEach, describe, expect, test, vi } from "bun:test";
import { LoopManager } from "../../session/loop-manager";
import type { ToolSession } from "../index";
import { LoopTool } from "../loop";
import { ToolAbortError, ToolError } from "../tool-errors";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function createNoopProxy<T extends object>(overrides: Record<string, unknown>): T {
	return new Proxy(overrides, {
		get(target, prop) {
			if (typeof prop === "string" && prop in target) return target[prop];
			return () => undefined;
		},
		set(target, prop, value) {
			if (typeof prop === "string") target[prop] = value;
			return true;
		},
	}) as T;
}

function createToolSession(getLoopManager?: () => LoopManager | undefined, taskDepth = 0): ToolSession {
	return createNoopProxy({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: createNoopProxy({
			get() {
				return undefined;
			},
		}),
		getLoopManager,
		taskDepth,
	}) as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("LoopTool factory", () => {
	test("only creates a loop tool for a primary session with a loop manager", () => {
		const manager = new LoopManager(async () => {});

		expect(LoopTool.createIf(createToolSession())).toBeNull();
		expect(LoopTool.createIf(createToolSession(() => manager))).toBeInstanceOf(LoopTool);
		expect(LoopTool.createIf(createToolSession(() => manager, 1))).toBeNull();
	});
});

describe("LoopTool interval parsing", () => {
	test.each([
		["10s", 10_000],
		["5m", 300_000],
		["1h", 3_600_000],
		["30", 30_000],
	] as const)("parses %s to %sms and schedules", async (interval, intervalMs) => {
		vi.useFakeTimers();
		const followUp = vi.fn(async (_text: string) => {});
		const manager = new LoopManager(followUp);
		const scheduleSpy = vi.spyOn(manager, "schedule");
		const tool = new LoopTool(createToolSession(() => manager));

		const result = await tool.execute("call-parse", {
			prompt: "heartbeat",
			interval,
			count: 1,
		});

		expect(scheduleSpy).toHaveBeenCalledWith({
			prompt: "heartbeat",
			intervalMs,
			count: 1,
		});
		const text = textOf(result);
		expect(text).toContain("heartbeat");
		expect(text).toContain(interval);
		expect(text).toContain("1 iterations");
		expect(text).toMatch(/Loop \S+ scheduled/);
	});

	test.each(["0s", "abc", ""] as const)("rejects invalid interval %j", async interval => {
		const manager = new LoopManager(async () => {});
		const tool = new LoopTool(createToolSession(() => manager));

		let err: unknown;
		try {
			await tool.execute("call-invalid", {
				prompt: "x",
				interval,
				count: 1,
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ToolError);
		expect(err instanceof Error ? err.message : String(err)).toMatch(
			/Expected a positive number of seconds or duration like "5s", "10m", "1h"/,
		);
	});

	test("rejects intervals below 10s", async () => {
		const manager = new LoopManager(async () => {});
		const tool = new LoopTool(createToolSession(() => manager));

		let err: unknown;
		try {
			await tool.execute("call-below-min", {
				prompt: "hot",
				interval: "9s",
				count: 1,
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ToolError);
		expect((err instanceof Error ? err.message : String(err)).toLowerCase()).toMatch(/10s|10 seconds|minimum/);
	});
});

describe("LoopTool execute", () => {
	test("valid args return confirmation with id, prompt, interval, and count", async () => {
		vi.useFakeTimers();
		const followUp = vi.fn(async (_text: string) => {});
		const manager = new LoopManager(followUp);
		const tool = new LoopTool(createToolSession(() => manager));

		const result = await tool.execute("call-ok", {
			prompt: "recheck CI",
			interval: "10m",
			count: 5,
		});

		const text = textOf(result);
		expect(text).toMatch(/Loop \S+ scheduled: "recheck CI" every 10m, 5 iterations/);
		expect(text).toContain("Iteration 1/5 queued");
		expect(text).toContain("follow-up");
	});

	test("pre-aborted calls reject without scheduling a loop", async () => {
		const controller = new AbortController();
		controller.abort();
		const schedule = vi.fn(() => ({ id: "loop-aborted" }));
		const manager = { schedule } as unknown as LoopManager;
		const tool = new LoopTool(createToolSession(() => manager));

		let error: unknown;
		try {
			await tool.execute(
				"call-pre-aborted",
				{
					prompt: "do not queue",
					interval: "10s",
					count: 1,
				},
				controller.signal,
			);
		} catch (caught) {
			error = caught;
		}

		expect(schedule).not.toHaveBeenCalled();
		expect(error).toBeInstanceOf(ToolAbortError);
		expect(error).toMatchObject({ name: "ToolAbortError", message: ToolAbortError.MESSAGE });
	});

	test("missing getLoopManager reports loops unavailable", async () => {
		const tool = new LoopTool(createToolSession(undefined));

		let err: unknown;
		try {
			await tool.execute("call-unavailable", {
				prompt: "x",
				interval: "10s",
				count: 1,
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ToolError);
		expect((err instanceof Error ? err.message : String(err)).toLowerCase()).toMatch(/unavailable|this session/);
	});

	test("prompt starting with / is rejected", async () => {
		const manager = new LoopManager(async () => {});
		const tool = new LoopTool(createToolSession(() => manager));

		let err: unknown;
		try {
			await tool.execute("call-slash", {
				prompt: "/compact",
				interval: "10s",
				count: 1,
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ToolError);
		expect(err instanceof Error ? err.message : String(err)).toMatch(/\/|extension|command/i);
	});

	test("count above 100 fails schema validation", () => {
		const manager = new LoopManager(async () => {});
		const tool = new LoopTool(createToolSession(() => manager));
		const parsed = tool.parameters.safeParse({
			prompt: "x",
			interval: "10s",
			count: 101,
		});
		expect(parsed.success).toBe(false);
	});
});
