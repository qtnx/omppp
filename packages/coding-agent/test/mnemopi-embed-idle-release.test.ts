/**
 * Contract: the mnemopi embed client reaps its worker subprocess (and the
 * hundreds of MB its loaded model holds) once nothing has been in flight for
 * the idle window, respawns transparently on the next request, and never
 * reaps a worker that still owes a reply. Fake workers keep fastembed out.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { MnemopiEmbedClient, type MnemopiEmbedWorkerHandle } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import type {
	MnemopiEmbedWorkerInbound,
	MnemopiEmbedWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";

const IDLE_MS = 1_000;

/** Fake worker: answers `init` at once, holds each `embed` reply until `releaseEmbeds()`. */
function createFakeWorkers() {
	const stats = { spawns: 0, terminated: 0 };
	const heldReplies: Array<() => void> = [];
	const spawn = (): MnemopiEmbedWorkerHandle => {
		stats.spawns += 1;
		let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
		return {
			send(message: MnemopiEmbedWorkerInbound) {
				if (message.type === "init") {
					queueMicrotask(() => handler?.({ type: "ready", id: message.id }));
				} else if (message.type === "embed") {
					const vectors = message.texts.map(text => [text.length]);
					heldReplies.push(() => handler?.({ type: "vectors", id: message.id, vectors }));
				}
			},
			onMessage(next) {
				handler = next;
				return () => {
					if (handler === next) handler = undefined;
				};
			},
			onError() {
				return () => {};
			},
			ref() {},
			unref() {},
			async terminate() {
				stats.terminated += 1;
				handler = undefined;
			},
		};
	};
	const releaseEmbeds = () => {
		for (const reply of heldReplies.splice(0)) reply();
	};
	return { stats, spawn, releaseEmbeds };
}

async function drain(iterable: AsyncIterable<number[][]>): Promise<number[][]> {
	const rows: number[][] = [];
	for await (const batch of iterable) rows.push(...batch);
	return rows;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("mnemopi embed client idle release", () => {
	it("reaps an idle worker and respawns it for the next embed", async () => {
		vi.useFakeTimers();
		const { stats, spawn, releaseEmbeds } = createFakeWorkers();
		const client = new MnemopiEmbedClient(spawn, 60_000, IDLE_MS);
		try {
			const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			expect(model).not.toBeNull();

			vi.advanceTimersByTime(IDLE_MS - 1);
			expect(stats.terminated).toBe(0);
			vi.advanceTimersByTime(1);
			expect(stats.terminated).toBe(1);

			const embedding = drain(model!.embed(["abc"]));
			releaseEmbeds();
			expect(await embedding).toEqual([[3]]);
			expect(stats.spawns).toBe(2);
		} finally {
			await client.terminate();
		}
	});

	it("keeps a worker that still owes a reply past the idle window", async () => {
		vi.useFakeTimers();
		const { stats, spawn, releaseEmbeds } = createFakeWorkers();
		const client = new MnemopiEmbedClient(spawn, 60_000, IDLE_MS);
		try {
			const model = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
			const embedding = drain(model!.embed(["abcd"]));

			vi.advanceTimersByTime(IDLE_MS * 5);
			expect(stats.terminated).toBe(0);

			releaseEmbeds();
			expect(await embedding).toEqual([[4]]);
			expect(stats.spawns).toBe(1);
		} finally {
			await client.terminate();
		}
	});
});
