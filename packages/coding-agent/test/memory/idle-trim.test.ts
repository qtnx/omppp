import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { hasRunningAgents, IdleMemoryTrim, type IdleTrimDeps } from "@oh-my-pi/pi-coding-agent/memory/idle-trim";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { logger } from "@oh-my-pi/pi-utils";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function createHarness(
	options: {
		enabled?: boolean;
		idleSeconds?: number;
		trimMcp?: boolean;
		active?: () => boolean;
		parkAll?: () => Promise<void>;
	} = {},
) {
	const calls: string[] = [];
	const setHookStatus = vi.fn((_: string, _text: string | undefined) => {});
	const parkAll = vi.fn(
		options.parkAll ??
			(async () => {
				calls.push("park");
			}),
	);
	const sleepAll = vi.fn(async () => {
		calls.push("mcp");
	});
	const terminateAll = vi.fn(async () => {
		calls.push("workers");
	});
	const clear = vi.fn(() => {
		calls.push("caches");
	});
	const deps: IdleTrimDeps = {
		config: {
			enabled: () => options.enabled ?? true,
			idleSeconds: () => options.idleSeconds ?? 60,
			trimMcp: () => options.trimMcp ?? true,
		},
		lifecycle: { parkAll },
		mcp: { sleepAll },
		workers: { terminateAll },
		caches: { clear },
		statusLine: { setHookStatus },
		isActive: options.active ?? (() => false),
	};
	return { calls, clear, deps, parkAll, setHookStatus, sleepAll, terminateAll };
}

describe("IdleMemoryTrim", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("trims every target in locked order and records the RSS observation", async () => {
		const harness = createHarness();
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		vi.advanceTimersByTime(59_999);
		await flushMicrotasks();
		expect(harness.calls).toEqual([]);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(harness.calls).toEqual(["park", "mcp", "workers", "caches"]);
		expect(harness.setHookStatus).toHaveBeenCalledWith("memory", "low-mem");
		expect(infoSpy).toHaveBeenCalledTimes(1);
		const [message, fields] = infoSpy.mock.calls[0] ?? [];
		expect(message).toBe("idle memory trim");
		expect(fields).toEqual(
			expect.objectContaining({
				parked: true,
				mcpSlept: true,
				workers: true,
				cachesCleared: true,
			}),
		);
		expect(typeof fields?.rssBefore).toBe("number");
		expect(typeof fields?.rssAfter).toBe("number");
	});

	it("cancels an armed trim and clears the badge when activity resumes", async () => {
		const harness = createHarness();
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		trim.notifyActivityStart();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();

		expect(harness.calls).toEqual([]);
		expect(harness.setHookStatus).toHaveBeenCalledWith("memory", undefined);
	});

	it("does not start a trim while the session is active", async () => {
		const harness = createHarness({ active: () => true });
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();

		expect(harness.calls).toEqual([]);
	});

	it("does not start a trim after the feature is disabled", async () => {
		const harness = createHarness({ enabled: false });
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();

		expect(harness.calls).toEqual([]);
	});

	it("skips MCP while retaining every other trim target when MCP trimming is disabled", async () => {
		const harness = createHarness({ trimMcp: false });
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();

		expect(harness.calls).toEqual(["park", "workers", "caches"]);
		expect(harness.sleepAll).not.toHaveBeenCalled();
	});

	it("isolates a failed park operation and continues with later targets", async () => {
		const harness = createHarness({
			parkAll: async () => {
				harness.calls.push("park");
				throw new Error("park failed");
			},
		});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();

		expect(harness.calls).toEqual(["park", "mcp", "workers", "caches"]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(harness.setHookStatus).toHaveBeenCalledWith("memory", "low-mem");
	});

	it("stops after the current target when activity begins during an awaited trim", async () => {
		const parked = Promise.withResolvers<void>();
		const calls: string[] = [];
		const harness = createHarness({
			parkAll: async () => {
				calls.push("park");
				await parked.promise;
			},
		});
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();
		expect(calls).toEqual(["park"]);

		trim.notifyActivityStart();
		parked.resolve();
		await flushMicrotasks();

		expect(harness.sleepAll).not.toHaveBeenCalled();
		expect(harness.terminateAll).not.toHaveBeenCalled();
		expect(harness.clear).not.toHaveBeenCalled();
	});

	it("manual trim consumes the armed timer instead of trimming again when it expires", async () => {
		const harness = createHarness();
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		await trim.trimNow();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();

		expect(harness.calls).toEqual(["park", "mcp", "workers", "caches"]);
	});

	it("does not overlap trims while a target is still awaiting", async () => {
		const parked = Promise.withResolvers<void>();
		const calls: string[] = [];
		const harness = createHarness({
			parkAll: async () => {
				calls.push("park");
				await parked.promise;
			},
		});
		const trim = new IdleMemoryTrim(harness.deps);

		const first = trim.trimNow();
		await flushMicrotasks();
		const second = trim.trimNow();
		parked.resolve();
		await Promise.all([first, second]);

		expect(calls).toEqual(["park"]);
		expect(harness.sleepAll).toHaveBeenCalledTimes(1);
	});

	it("re-arms from the latest activity window and honours the lower clamp", async () => {
		const harness = createHarness({ idleSeconds: 1 });
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		vi.advanceTimersByTime(30_000);
		trim.notifyActivityEnd();
		vi.advanceTimersByTime(59_999);
		await flushMicrotasks();
		expect(harness.calls).toEqual([]);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(harness.calls).toEqual(["park", "mcp", "workers", "caches"]);
	});

	it("honours the upper clamp and dispose cancels the pending trim", async () => {
		const harness = createHarness({ idleSeconds: 9_999 });
		const trim = new IdleMemoryTrim(harness.deps);

		trim.notifyActivityEnd();
		vi.advanceTimersByTime(3_599_999);
		await flushMicrotasks();
		expect(harness.calls).toEqual([]);

		trim.dispose();
		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(harness.calls).toEqual([]);
		expect(harness.setHookStatus).toHaveBeenCalledWith("memory", undefined);
	});
});

describe("hasRunningAgents", () => {
	function ref(id: string, kind: AgentRef["kind"], status: AgentRef["status"]): AgentRef {
		return {
			id,
			displayName: id,
			kind,
			status,
			session: null,
			ircEnabled: false,
			sessionFile: null,
			createdAt: 0,
			lastActivity: 0,
		};
	}

	// Regression pin (rung-3 probe, 2026-07-19): Main is registered "running"
	// for its entire lifetime and never flips to idle on agent_end, so an
	// isActive check that counts Main suppresses the trim forever.
	it("ignores Main even while it is registered running", () => {
		expect(hasRunningAgents([ref("Main", "main", "running")])).toBe(false);
		expect(hasRunningAgents([ref("Main", "main", "running"), ref("P1", "sub", "idle")])).toBe(false);
	});

	it("counts running subagents and advisors as activity", () => {
		expect(hasRunningAgents([ref("Main", "main", "running"), ref("P1", "sub", "running")])).toBe(true);
		expect(hasRunningAgents([ref("Advisor", "advisor", "running")])).toBe(true);
	});

	it("is false with no agents or only settled agents", () => {
		expect(hasRunningAgents([])).toBe(false);
		expect(hasRunningAgents([ref("P1", "sub", "parked"), ref("P2", "sub", "aborted")])).toBe(false);
	});
});
