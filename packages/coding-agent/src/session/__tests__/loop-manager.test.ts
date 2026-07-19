import { afterEach, describe, expect, test, vi } from "bun:test";
import { LoopManager } from "../loop-manager";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

describe("LoopManager", () => {
	test("fires iteration 1 immediately with header, then remaining iterations on interval", async () => {
		vi.useFakeTimers();
		const followUp = vi.fn(async (_text: string) => {});
		const manager = new LoopManager(followUp);

		const handle = manager.schedule({ prompt: "check status", intervalMs: 20, count: 3 });

		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]?.[0]).toBe(`[loop ${handle.id} · 1/3] check status`);
		expect(manager.activeCount).toBe(1);

		vi.advanceTimersByTime(19);
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(2);
		expect(followUp.mock.calls[1]?.[0]).toBe(`[loop ${handle.id} · 2/3] check status`);

		vi.advanceTimersByTime(20);
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(3);
		expect(followUp.mock.calls[2]?.[0]).toBe(`[loop ${handle.id} · 3/3] check status`);
		expect(manager.activeCount).toBe(0);

		// Advancing far past the end must not fire extra iterations.
		vi.advanceTimersByTime(20 * 10);
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(3);
	});

	test("cancelAll mid-loop stops further iterations and is idempotent", async () => {
		vi.useFakeTimers();
		const followUp = vi.fn(async (_text: string) => {});
		const manager = new LoopManager(followUp);

		manager.schedule({ prompt: "ping", intervalMs: 15, count: 5 });
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(1);

		manager.cancelAll();
		expect(manager.activeCount).toBe(0);
		manager.cancelAll(); // idempotent

		vi.advanceTimersByTime(15 * 20);
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(1);
	});

	test("followUp rejection cancels that loop without unhandled rejection or further fires", async () => {
		vi.useFakeTimers();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const followUp = vi.fn(async (_text: string) => {
				throw new Error("follow-up failed");
			});
			const manager = new LoopManager(followUp);

			manager.schedule({ prompt: "retry me", intervalMs: 10, count: 4 });
			await flushMicrotasks();
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(manager.activeCount).toBe(0);

			vi.advanceTimersByTime(10 * 10);
			await flushMicrotasks();
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("in-flight followUp that settles after cancelAll does not schedule further iterations", async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<void>();
		const followUp = vi.fn(async (_text: string) => {
			await pending.promise;
		});
		const manager = new LoopManager(followUp);

		manager.schedule({ prompt: "slow", intervalMs: 25, count: 3 });
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(1);

		manager.cancelAll();
		expect(manager.activeCount).toBe(0);

		pending.resolve();
		await flushMicrotasks();

		vi.advanceTimersByTime(25 * 10);
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(1);
	});
});
