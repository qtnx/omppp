import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type FleetAgentSettled, HerdrFleetWatcher } from "../src/herdr/fleet-watcher";

interface FakePane {
	pane_id: string;
	workspace_id?: string;
	agent?: string;
	agent_status?: string;
	title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function createFakeHerdr(panes: FakePane[]) {
	const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-fleet-watcher-"));
	const socketPath = path.join(runDir, "herdr.sock");
	const writers = new Map<unknown, (line: string) => void>();
	const buffers = new Map<unknown, string>();
	const subscribeCalls: Record<string, unknown>[] = [];
	const subscriptionWaiters: Array<{ count: number; resolve: () => void }> = [];

	const resolveSubscriptionWaiters = (): void => {
		for (let index = subscriptionWaiters.length - 1; index >= 0; index--) {
			const waiter = subscriptionWaiters[index];
			if (subscribeCalls.length >= waiter.count) {
				subscriptionWaiters.splice(index, 1);
				waiter.resolve();
			}
		}
	};

	const server = Bun.listen({
		unix: socketPath,
		socket: {
			open(socket) {
				writers.set(socket, line => {
					socket.write(line);
				});
				buffers.set(socket, "");
			},
			data(socket, data) {
				let buffer = `${buffers.get(socket) ?? ""}${Buffer.from(data).toString()}`;
				while (true) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim() === "") continue;

					let request: unknown;
					try {
						request = JSON.parse(line);
					} catch {
						continue;
					}
					if (!isRecord(request)) continue;
					if (request.method === "pane.list") {
						socket.write(`${JSON.stringify({ id: request.id, result: { panes } })}\n`);
						continue;
					}
					if (request.method === "events.subscribe") {
						subscribeCalls.push(isRecord(request.params) ? request.params : {});
						resolveSubscriptionWaiters();
						socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
					}
				}
				buffers.set(socket, buffer);
			},
			close(socket) {
				writers.delete(socket);
				buffers.delete(socket);
			},
		},
	});

	return {
		socketPath,
		subscribeCalls,
		waitForSubscriptions(count: number): Promise<void> {
			if (subscribeCalls.length >= count) return Promise.resolve();
			const deferred = Promise.withResolvers<void>();
			subscriptionWaiters.push({ count, resolve: deferred.resolve });
			return deferred.promise;
		},
		push(line: string): void {
			const eventLine = line.endsWith("\n") ? line : `${line}\n`;
			for (const write of writers.values()) write(eventLine);
		},
		async close(): Promise<void> {
			server.stop(true);
			await fs.rm(runDir, { recursive: true, force: true });
		},
	};
}

describe("HerdrFleetWatcher", () => {
	test("reports a working pane that completes once", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle" },
		]);
		const settled: FleetAgentSettled[] = [];
		const reported = Promise.withResolvers<void>();
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			minWorkMs: 0,
			now: () => 10_000,
			onSettled(info) {
				settled.push(info);
				reported.resolve();
			},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push(
				'{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","workspace_id":"w1","agent":"omp","agent_status":"working"}}',
			);
			herdr.push(
				'{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","workspace_id":"w1","agent":"omp","agent_status":"done"}}',
			);
			await reported.promise;

			expect(settled).toHaveLength(1);
			expect(settled[0]).toMatchObject({ paneId: "w1:p1", status: "done" });
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});

	test("does not report idle without a preceding working state", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle" },
		]);
		const settled: FleetAgentSettled[] = [];
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			minWorkMs: 0,
			onSettled(info) {
				settled.push(info);
			},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"idle"}}');
			herdr.push(
				'{"event":"pane_agent_detected","data":{"pane_id":"w1:p2","workspace_id":"w1","agent":"peer","agent_status":"idle"}}',
			);
			await herdr.waitForSubscriptions(2);

			expect(settled).toHaveLength(0);
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});

	test("reports idle after working as a settled state", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle" },
		]);
		const settled: FleetAgentSettled[] = [];
		const reported = Promise.withResolvers<void>();
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			minWorkMs: 0,
			onSettled(info) {
				settled.push(info);
				reported.resolve();
			},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"working"}}');
			herdr.push('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"idle"}}');
			await reported.promise;

			expect(settled).toHaveLength(1);
			expect(settled[0]).toMatchObject({ paneId: "w1:p1", status: "idle" });
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});

	test("does not report work shorter than minWorkMs", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle" },
		]);
		let clockCalls = 0;
		const now = (): number => (clockCalls++ === 0 ? 0 : 100);
		const settled: FleetAgentSettled[] = [];
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			minWorkMs: 5_000,
			now,
			onSettled(info) {
				settled.push(info);
			},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"working"}}');
			herdr.push('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"done"}}');
			herdr.push('{"event":"pane_agent_detected","data":{"pane_id":"w1:p2","agent":"peer","agent_status":"idle"}}');
			await herdr.waitForSubscriptions(2);

			expect(settled).toHaveLength(0);
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});

	test("keeps the working timer through blocked before done", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle" },
		]);
		let clockCalls = 0;
		const now = (): number => (clockCalls++ === 0 ? 1_000 : 6_000);
		const settled: FleetAgentSettled[] = [];
		const reported = Promise.withResolvers<void>();
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			minWorkMs: 5_000,
			now,
			onSettled(info) {
				settled.push(info);
				reported.resolve();
			},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"working"}}');
			herdr.push('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"blocked"}}');
			herdr.push('{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"done"}}');
			await reported.promise;

			expect(settled).toHaveLength(1);
			expect(settled[0]).toMatchObject({ paneId: "w1:p1", status: "done", workedMs: 5_000 });
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});

	test("filters self and out-of-workspace panes", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:self", workspace_id: "w1", agent: "omp", agent_status: "idle" },
			{ pane_id: "w2:peer", workspace_id: "w2", agent: "peer", agent_status: "idle" },
		]);
		const settled: FleetAgentSettled[] = [];
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			selfPaneId: "w1:self",
			workspaceId: "w1",
			minWorkMs: 0,
			onSettled(info) {
				settled.push(info);
			},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push(
				'{"event":"pane.agent_status_changed","data":{"pane_id":"w1:self","workspace_id":"w1","agent_status":"working"}}',
			);
			herdr.push(
				'{"event":"pane.agent_status_changed","data":{"pane_id":"w1:self","workspace_id":"w1","agent_status":"done"}}',
			);
			herdr.push(
				'{"event":"pane.agent_status_changed","data":{"pane_id":"w2:peer","workspace_id":"w2","agent_status":"working"}}',
			);
			herdr.push(
				'{"event":"pane.agent_status_changed","data":{"pane_id":"w2:peer","workspace_id":"w2","agent_status":"done"}}',
			);
			herdr.push(
				'{"event":"pane_agent_detected","data":{"pane_id":"w1:p3","workspace_id":"w1","agent":"peer","agent_status":"idle"}}',
			);
			await herdr.waitForSubscriptions(2);

			expect(settled).toHaveLength(0);
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});

	test("rebuilds subscriptions when a new agent pane is detected", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle" },
		]);
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			onSettled() {},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push(
				'{"event":"pane_agent_detected","data":{"pane_id":"w1:p2","workspace_id":"w1","agent":"peer","agent_status":"idle"}}',
			);
			await herdr.waitForSubscriptions(2);

			expect(herdr.subscribeCalls[1]).toEqual({
				subscriptions: [
					{ type: "pane.agent_detected" },
					{ type: "pane.agent_status_changed", pane_id: "w1:p1" },
					{ type: "pane.agent_status_changed", pane_id: "w1:p2" },
				],
			});
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});

	test("reports a detected pane that was already working when subscribed", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "idle" },
		]);
		const settled: FleetAgentSettled[] = [];
		const reported = Promise.withResolvers<void>();
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			minWorkMs: 0,
			onSettled(info) {
				settled.push(info);
				reported.resolve();
			},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push(
				'{"event":"pane_agent_detected","data":{"pane_id":"w1:p2","workspace_id":"w1","agent":"peer","agent_status":"working"}}',
			);
			await herdr.waitForSubscriptions(2);
			herdr.push(
				'{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p2","workspace_id":"w1","agent":"peer","agent_status":"done"}}',
			);
			await reported.promise;

			expect(settled).toHaveLength(1);
			expect(settled[0]).toMatchObject({ paneId: "w1:p2", status: "done" });
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});

	test("reports a pane adopted as working from the startup snapshot", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "working" },
		]);
		const settled: FleetAgentSettled[] = [];
		const reported = Promise.withResolvers<void>();
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			minWorkMs: 0,
			now: () => 10_000,
			onSettled(info) {
				settled.push(info);
				reported.resolve();
			},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push(
				'{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"done","agent":"omp","workspace_id":"w1"}}',
			);
			await reported.promise;

			expect(settled).toHaveLength(1);
			expect(settled[0]).toMatchObject({ paneId: "w1:p1", status: "done" });
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});

	test("removes a released pane from the watched set", async () => {
		const herdr = await createFakeHerdr([
			{ pane_id: "w1:p1", workspace_id: "w1", agent: "omp", agent_status: "working" },
		]);
		const watcher = new HerdrFleetWatcher({
			socketPath: herdr.socketPath,
			onSettled() {},
		});

		try {
			await watcher.start();
			await herdr.waitForSubscriptions(1);
			herdr.push(
				'{"event":"pane_agent_detected","data":{"released":true,"final_status":"unknown","pane_id":"w1:p1"}}',
			);
			await herdr.waitForSubscriptions(2);

			expect(watcher.watchedPanes).toEqual([]);
		} finally {
			await watcher.stop();
			await herdr.close();
		}
	});
});
