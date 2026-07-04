import { describe, expect, test } from "bun:test";
import type { AuthBrokerClient, FetchSnapshotOptions, FetchSnapshotResult } from "@oh-my-pi/pi-ai/auth-broker/client";
import { RemoteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import type {
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEvent,
} from "@oh-my-pi/pi-ai/auth-broker/types";

const refresher: RefresherSchedule = {
	enabled: false,
	intervalMs: 60_000,
	skewMs: 300_000,
	nextSweepInMs: 60_000,
};

function makeSnapshot(generation: number): SnapshotResponse {
	return {
		generation,
		generatedAt: generation,
		serverNowMs: generation,
		refresher,
		credentials: [
			{
				id: generation,
				provider: "anthropic",
				identityKey: `acct-${generation}`,
				rotatesInMs: null,
				credential: { type: "api_key", key: `key-${generation}` },
			},
		],
	};
}

class SnapshotClientStub {
	readonly #snapshots: SnapshotResponse[];
	#streamEvents: SnapshotStreamEvent[] = [];
	#processedEvents: PromiseWithResolvers<void>[] = [];
	#streamWaiter: PromiseWithResolvers<void> | undefined;

	constructor(snapshots: SnapshotResponse[]) {
		this.#snapshots = [...snapshots];
	}

	async fetchSnapshot(opts: FetchSnapshotOptions = {}): Promise<FetchSnapshotResult> {
		if (opts.ifGenerationGt !== undefined) {
			// Background long-poll waits here until close aborts it; manual refreshSnapshot calls omit ifGenerationGt.
			const waiter = Promise.withResolvers<FetchSnapshotResult>();
			const finish = (): void => waiter.resolve({ status: 304, generation: opts.ifGenerationGt ?? 0 });
			if (opts.signal?.aborted) {
				finish();
				return waiter.promise;
			}
			opts.signal?.addEventListener("abort", finish, { once: true });
			return waiter.promise;
		}
		const snapshot = this.#snapshots.shift();
		if (!snapshot) return { status: 304, generation: 0 };
		return { status: 200, snapshot, generation: snapshot.generation };
	}

	pushStreamEvent(event: SnapshotStreamEvent): Promise<void> {
		const processed = Promise.withResolvers<void>();
		this.#streamEvents.push(event);
		this.#processedEvents.push(processed);
		this.#streamWaiter?.resolve();
		this.#streamWaiter = undefined;
		return processed.promise;
	}

	async *openSnapshotStream(opts: { signal?: AbortSignal } = {}): AsyncGenerator<SnapshotStreamEvent> {
		while (!opts.signal?.aborted) {
			const event = this.#streamEvents.shift();
			if (event) {
				yield event;
				this.#processedEvents.shift()?.resolve();
				continue;
			}
			this.#streamWaiter = Promise.withResolvers<void>();
			const abort = (): void => this.#streamWaiter?.resolve();
			opts.signal?.addEventListener("abort", abort, { once: true });
			await this.#streamWaiter.promise;
			opts.signal?.removeEventListener("abort", abort);
		}
	}
}

function makeEntry(id: number, key: string): SnapshotEntry {
	return {
		id,
		provider: "anthropic",
		identityKey: `acct-${id}`,
		rotatesInMs: null,
		credential: { type: "api_key", key },
	};
}

describe("RemoteAuthCredentialStore.onSnapshotChanged", () => {
	test("fires when a broker snapshot is applied and stops after unsubscribe", async () => {
		const client = new SnapshotClientStub([makeSnapshot(2), makeSnapshot(3)]) as unknown as AuthBrokerClient;
		const store = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: makeSnapshot(1),
			streamSnapshots: false,
		});
		try {
			let notifications = 0;
			const unsubscribe = store.onSnapshotChanged(() => {
				notifications += 1;
			});

			await store.refreshSnapshot();
			expect(notifications).toBe(1);

			unsubscribe();
			await store.refreshSnapshot();
			expect(notifications).toBe(1);
		} finally {
			store.close();
		}
	});

	test("fires for streamed entry and removal changes", async () => {
		const client = new SnapshotClientStub([]);
		const store = new RemoteAuthCredentialStore({
			client: client as unknown as AuthBrokerClient,
			initialSnapshot: makeSnapshot(1),
		});
		try {
			let notifications = 0;
			const unsubscribe = store.onSnapshotChanged(() => {
				notifications += 1;
			});

			await client.pushStreamEvent({
				kind: "entry",
				entry: makeEntry(2, "key-2"),
				generation: 2,
				serverNowMs: 2,
				refresher,
			});
			expect(notifications).toBe(1);
			expect(store.listAuthCredentials()).toHaveLength(2);

			await client.pushStreamEvent({
				kind: "removed",
				id: 1,
				generation: 3,
				serverNowMs: 3,
				refresher,
			});
			expect(notifications).toBe(2);
			expect(store.listAuthCredentials()).toHaveLength(1);

			unsubscribe();
			await client.pushStreamEvent({
				kind: "entry",
				entry: makeEntry(4, "key-4"),
				generation: 4,
				serverNowMs: 4,
				refresher,
			});
			expect(notifications).toBe(2);
		} finally {
			store.close();
		}
	});
});
