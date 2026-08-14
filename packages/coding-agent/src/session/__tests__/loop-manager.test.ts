import { afterEach, describe, expect, test, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
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

	test("cancelAll aborts an in-flight delivery before it can schedule another iteration", async () => {
		vi.useFakeTimers();
		const delivery = Promise.withResolvers<void>();
		let deliverySignal: AbortSignal | undefined;
		const followUp = vi.fn(async (_text: string, signal: AbortSignal) => {
			deliverySignal = signal;
			await delivery.promise;
		});
		const manager = new LoopManager(followUp);

		manager.schedule({ prompt: "slow", intervalMs: 25, count: 3 });
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(deliverySignal).toBeInstanceOf(AbortSignal);

		manager.cancelAll();
		expect(deliverySignal?.aborted).toBe(true);
		expect(manager.activeCount).toBe(0);

		delivery.resolve();
		await flushMicrotasks();
		vi.advanceTimersByTime(25 * 10);
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(1);
	});

	test("lists isolated running and waiting snapshots", async () => {
		vi.useFakeTimers();
		const delivery = Promise.withResolvers<void>();
		const followUp = vi.fn(async () => {
			await delivery.promise;
		});
		const manager = new LoopManager(followUp);

		const handle = manager.schedule({ prompt: "inspect", intervalMs: 10, count: 2 });
		await flushMicrotasks();

		const running = manager.list();
		expect(running).toEqual([
			{
				id: handle.id,
				prompt: "inspect",
				intervalMs: 10,
				count: 2,
				iteration: 1,
				state: "running",
			},
		]);

		const anotherRunning = manager.list();
		expect(anotherRunning).not.toBe(running);
		expect(anotherRunning[0]).not.toBe(running[0]);
		Object.assign(running[0]!, { prompt: "corrupted", iteration: 99 });
		expect(manager.list()[0]).toMatchObject({ prompt: "inspect", iteration: 1 });

		delivery.resolve();
		await flushMicrotasks();
		expect(manager.list()[0]).toMatchObject({ state: "waiting", iteration: 1 });
		expect(manager.cancelAll()).toBe(1);
	});

	test("cancels one exact ID without stopping its sibling", async () => {
		vi.useFakeTimers();
		const followUp = vi.fn(async (_text: string) => {});
		const manager = new LoopManager(followUp);

		const first = manager.schedule({ prompt: "first", intervalMs: 10, count: 2 });
		const second = manager.schedule({ prompt: "second", intervalMs: 10, count: 2 });
		await flushMicrotasks();

		expect(manager.cancel(first.id)).toBe(true);
		expect(manager.activeCount).toBe(1);
		vi.advanceTimersByTime(10);
		await flushMicrotasks();

		expect(followUp.mock.calls.map(([text]) => text)).toEqual([
			`[loop ${first.id} · 1/2] first`,
			`[loop ${second.id} · 1/2] second`,
			`[loop ${second.id} · 2/2] second`,
		]);
		expect(manager.activeCount).toBe(0);
	});

	test("returns false for unknown and naturally completed IDs", async () => {
		const followUp = vi.fn(async (_text: string) => {});
		const manager = new LoopManager(followUp);

		expect(manager.cancel("missing")).toBe(false);
		const handle = manager.schedule({ prompt: "once", intervalMs: 10, count: 1 });
		await flushMicrotasks();

		expect(manager.cancel(handle.id)).toBe(false);
		expect(manager.list()).toEqual([]);
	});

	test("cancels an in-flight dequeued timer round without a later followUp", async () => {
		vi.useFakeTimers();
		const secondDelivery = Promise.withResolvers<void>();
		let calls = 0;
		const followUp = vi.fn(async (_text: string) => {
			calls += 1;
			if (calls === 2) await secondDelivery.promise;
		});
		const manager = new LoopManager(followUp);

		const handle = manager.schedule({ prompt: "boundary", intervalMs: 10, count: 3 });
		await flushMicrotasks();
		vi.advanceTimersByTime(10);
		await flushMicrotasks();
		expect(followUp).toHaveBeenCalledTimes(2);

		expect(manager.cancel(handle.id)).toBe(true);
		secondDelivery.resolve();
		await flushMicrotasks();
		vi.advanceTimersByTime(10 * 10);
		await flushMicrotasks();

		expect(followUp).toHaveBeenCalledTimes(2);
		expect(manager.list()).toEqual([]);
	});

	test("cancels a final in-flight round before natural completion", async () => {
		const delivery = Promise.withResolvers<void>();
		const followUp = vi.fn(async (_text: string) => {
			await delivery.promise;
		});
		const manager = new LoopManager(followUp);

		const handle = manager.schedule({ prompt: "final", intervalMs: 10, count: 1 });
		await flushMicrotasks();

		expect(manager.cancel(handle.id)).toBe(true);
		delivery.resolve();
		await flushMicrotasks();

		expect(manager.cancel(handle.id)).toBe(false);
		expect(manager.list()).toEqual([]);
		expect(followUp).toHaveBeenCalledTimes(1);
	});

	test("returns the exact active count from cancelAll", () => {
		const manager = new LoopManager(async () => {});
		manager.schedule({ prompt: "first", intervalMs: 10, count: 2 });
		manager.schedule({ prompt: "second", intervalMs: 10, count: 2 });

		expect(manager.cancelAll()).toBe(2);
		expect(manager.cancelAll()).toBe(0);
		expect(manager.list()).toEqual([]);
	});

	test("does not warn when cancellation aborts an in-flight followUp", async () => {
		const followUp = vi.fn(
			(_text: string, signal: AbortSignal) =>
				new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const warn = vi.spyOn(logger, "warn");
		const manager = new LoopManager(followUp);

		const handle = manager.schedule({ prompt: "abort", intervalMs: 10, count: 2 });
		expect(manager.cancel(handle.id)).toBe(true);
		await flushMicrotasks();

		expect(warn).not.toHaveBeenCalled();
		expect(manager.list()).toEqual([]);
	});
});
